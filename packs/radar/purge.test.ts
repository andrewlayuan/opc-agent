import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';
import { insertEntries, syncSources } from './collect.ts';
import type { SourceRow } from './collect.ts';
import { PurgeInputError, parsePurgeBody, purgeItems } from './purge.ts';
import { listItems } from './query.ts';
import { TopicMatcher, loadTopics } from './text.ts';

const DAY = 24 * 3600 * 1000;
const T0 = new Date(2026, 10, 1).getTime();
const day = (n: number) => T0 + n * DAY;

function tmpDb(): { db: DB; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-purge-'));
  const db = openDb(path.join(dir, 't.db'));
  syncSources(db);
  return { db, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}
let seq = 0;
function add(db: DB, d: number, o: { starred?: boolean; dup?: number | null } = {}): number {
  seq++;
  return Number(
    db
      .prepare(`INSERT INTO items(source_id, url, title, norm_title, published_at, fetched_at, content, topics, dup_of, starred, analyzed_at, importance) VALUES ('openai', ?, ?, '', ?, ?, '', '[]', ?, ?, 1, 3)`)
      .run(`https://a.com/${seq}`, `T${seq}`, day(d), day(d), o.dup ?? null, o.starred ? 1 : 0).lastInsertRowid,
  );
}
const ids = (db: DB) => (db.prepare('SELECT id FROM items ORDER BY id').all() as { id: number }[]).map((r) => r.id);
const dupOf = (db: DB, id: number) => (db.prepare('SELECT dup_of FROM items WHERE id = ?').get(id) as { dup_of: number | null }).dup_of;

test('按日期区间删除：含两端，区间外不动；先预览不改数据，再真正删除', () => {
  const { db, done } = tmpDb();
  const [a, b, c, d, e] = [add(db, 1), add(db, 2), add(db, 3), add(db, 4), add(db, 5)];
  const dry = purgeItems(db, { from: day(2), to: day(4) }, { dryRun: true });
  assert.deepEqual(dry, { matched: 3, deleted: 3, keptStarred: 0, keptInKb: 0 });
  assert.equal(ids(db).length, 5, '预览不删除');
  assert.equal(db.prepare('SELECT count(*) AS n FROM radar_deleted_urls').get()!.n, 0, '预览不记录');
  const r = purgeItems(db, { from: day(2), to: day(4) });
  assert.deepEqual(r, dry);
  assert.deepEqual(ids(db), [a, e]);
  void b; void c; void d;
  done();
});

test('删除全部：收藏的与已在知识库里的保留并分别计数', () => {
  const { db, done } = tmpDb();
  const plain = add(db, 1);
  const star = add(db, 2, { starred: true });
  const inKb = add(db, 3);
  db.prepare("INSERT INTO kb_docs(kind, title, item_id, created_at, updated_at) VALUES ('item', 'x', ?, 1, 1)").run(inKb);
  const r = purgeItems(db, {});
  assert.deepEqual(r, { matched: 3, deleted: 1, keptStarred: 1, keptInKb: 1 });
  assert.deepEqual(ids(db), [star, inKb]);
  void plain;
  done();
});

test('被删条目的网址进入黑名单；全文检索索引同步删除；重复清理不报错', () => {
  const { db, done } = tmpDb();
  const a = add(db, 1);
  const url = (db.prepare('SELECT url FROM items WHERE id = ?').get(a) as { url: string }).url;
  assert.equal(listItems(db, { q: `T${seq}` }).length >= 0, true);
  purgeItems(db, {}, { now: 123 });
  assert.deepEqual(db.prepare('SELECT url, at FROM radar_deleted_urls').all().map((r) => ({ ...r })), [{ url, at: 123 }]);
  assert.equal((db.prepare("SELECT count(*) AS n FROM items_fts WHERE items_fts MATCH ?").get(`"T${seq}"`) as { n: number }).n, 0);
  assert.deepEqual(purgeItems(db, {}), { matched: 0, deleted: 0, keptStarred: 0, keptInKb: 0 });
  done();
});

test('留下的重复条目改指向其中最早的一条，不会变成永远看不见的孤儿', () => {
  const { db, done } = tmpDb();
  const rep = add(db, 1);
  const k1 = add(db, 5, { dup: rep });
  const k2 = add(db, 4, { dup: rep });
  const gone = add(db, 2, { dup: rep });
  const other = add(db, 6);
  purgeItems(db, { from: day(1), to: day(2) });
  assert.deepEqual(ids(db), [k1, k2, other]);
  assert.equal(dupOf(db, k2), null, '最早的留下的成为新的代表条目');
  assert.equal(dupOf(db, k1), k2);
  assert.deepEqual(listItems(db, {}).map((x) => x.id).sort(), [k2, other].sort());
  assert.deepEqual(listItems(db, {}).find((x) => x.id === k2)!.also.map((x) => x.id), [k1]);
  void gone;
  done();
});

test('被删的代表条目和它的重复条目一起在区间内时，不留悬空引用', () => {
  const { db, done } = tmpDb();
  const rep = add(db, 1);
  add(db, 2, { dup: rep });
  const keep = add(db, 9);
  purgeItems(db, { from: day(0), to: day(3) });
  assert.deepEqual(ids(db), [keep]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM items WHERE dup_of IS NOT NULL').get()!.n, 0);
  done();
});

test('采集：被清理过的网址不会被重新采回来，新网址照常入库', () => {
  const { db, done } = tmpDb();
  const src = db.prepare("SELECT * FROM sources WHERE id = 'openai'").get() as unknown as SourceRow;
  const matcher = new TopicMatcher(loadTopics());
  const entry = (u: string) => ({ title: `Title ${u} about large language models`, url: u, content: 'LLM', publishedAt: Date.now() - 1000 });
  assert.equal(insertEntries(db, src, [entry('https://x.com/a')], matcher, 14).length, 1);
  purgeItems(db, {});
  assert.equal(insertEntries(db, src, [entry('https://x.com/a')], matcher, 14).length, 0, '同一网址不再入库');
  assert.equal(insertEntries(db, src, [entry('https://x.com/b')], matcher, 14).length, 1, '新网址照常入库');
  done();
});

test('请求体校验', () => {
  assert.deepEqual(parsePurgeBody({ all: true }), { range: {}, dryRun: false });
  assert.deepEqual(parsePurgeBody({ from: 1, to: 2, dryRun: true }), { range: { from: 1, to: 2 }, dryRun: true });
  for (const bad of [{}, { from: 1 }, { to: 1 }, { all: true, from: 1, to: 2 }, { all: 'yes' }, { from: 5, to: 1 }, { from: -1, to: 1 }, { from: '1', to: 2 }, { from: 1.5, to: 2 }, { from: 1, to: 2, dryRun: 'x' }, { all: false }]) {
    assert.throws(() => parsePurgeBody(bad as Record<string, unknown>), PurgeInputError, JSON.stringify(bad));
  }
});
