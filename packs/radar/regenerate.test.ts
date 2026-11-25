import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../../packages/core/config.ts';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';
import { Reach } from '../../packages/core/reach.ts';
import { resetSourceCache, syncSources } from './collect.ts';
import { PurgeInputError, parseRegenBody, purgeItems } from './purge.ts';
import { Radar } from './service.ts';

const DAY = 24 * 3600 * 1000;
const T0 = new Date(2026, 10, 10).getTime();
const day = (n: number, h = 12) => T0 + n * DAY + h * 3600 * 1000;

function tmpDb(): { db: DB; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-regen-'));
  const db = openDb(path.join(dir, 't.db'));
  syncSources(db);
  return { db, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}
let seq = 0;
function add(db: DB, at: number, o: { starred?: boolean } = {}): number {
  seq++;
  return Number(
    db
      .prepare(`INSERT INTO items(source_id, url, title, norm_title, published_at, fetched_at, content, topics, starred, analyzed_at, importance) VALUES ('openai', ?, ?, '', ?, ?, '', '[]', ?, 1, 3)`)
      .run(`https://r.com/${seq}`, `T${seq}`, at, at, o.starred ? 1 : 0).lastInsertRowid,
  );
}
const ids = (db: DB) => (db.prepare('SELECT id FROM items ORDER BY id').all() as { id: number }[]).map((r) => r.id);
const tombs = (db: DB) => Number((db.prepare('SELECT count(*) AS n FROM radar_deleted_urls').get() as { n: number }).n);

test('purgeItems tombstone:false：照常删除，但不记已删网址（默认仍会记）', () => {
  const { db, done } = tmpDb();
  const a = add(db, day(0));
  const b = add(db, day(0));
  const r = purgeItems(db, { from: day(0, 0), to: day(0, 23) }, { tombstone: false });
  assert.equal(r.deleted, 2);
  assert.deepEqual(ids(db), []);
  assert.equal(tombs(db), 0, '重新生成时删除的条目要能再被采集回来');
  const c = add(db, day(1));
  purgeItems(db, { from: day(1, 0), to: day(1, 23) });
  assert.equal(tombs(db), 1, '默认仍记录');
  void a; void b; void c;
  done();
});

test('parseRegenBody：必须给起止；不允许 all；dryRun 透传', () => {
  assert.deepEqual(parseRegenBody({ from: 1, to: 2 }), { range: { from: 1, to: 2 }, dryRun: false });
  assert.equal(parseRegenBody({ from: 1, to: 2, dryRun: true }).dryRun, true);
  assert.throws(() => parseRegenBody({ all: true }), PurgeInputError);
  assert.throws(() => parseRegenBody({ all: false, from: 1, to: 2 }), PurgeInputError);
  assert.throws(() => parseRegenBody({}), PurgeInputError);
  assert.throws(() => parseRegenBody({ from: 1 }), PurgeInputError);
  assert.throws(() => parseRegenBody({ from: 5, to: 2 }), PurgeInputError);
});

test('resetSourceCache：只清启用源的 ETag / Last-Modified', () => {
  const { db, done } = tmpDb();
  db.prepare("UPDATE sources SET etag='e', last_modified='m'").run();
  db.prepare("UPDATE sources SET enabled = 0 WHERE id = 'openai'").run();
  const n = resetSourceCache(db);
  assert.ok(n > 0);
  const row = (id: string) => db.prepare('SELECT etag, last_modified FROM sources WHERE id = ?').get(id) as { etag: string | null; last_modified: string | null };
  assert.deepEqual({ ...row('deepmind') }, { etag: null, last_modified: null });
  assert.deepEqual({ ...row('openai') }, { etag: 'e', last_modified: 'm' });
  done();
});

test('Radar.runCycle({regenerate})：删除该日未收藏条目、保留收藏与别的日期，并让信息源忽略缓存', async () => {
  const { db, done } = tmpDb();
  process.env.DEEPSEEK_API_KEY = '';
  const radar = new Radar(db, loadConfig({ requireAuth: false }), () => {});
  Object.assign(radar, { reach: new Reach({ enabled: false }) });
  // 只留一个会立刻失败的 reach 源，避免测试访问网络
  db.prepare('UPDATE sources SET enabled = 0').run();
  db.prepare("INSERT INTO sources(id, name, url, kind, grp, enabled, custom, etag, last_modified, reach_args) VALUES ('t-reach', 't', 'https://t.example/', 'reach', 'custom', 1, 1, 'E', 'M', '[]')").run();
  const today = add(db, day(0));
  const starred = add(db, day(0), { starred: true });
  const yesterday = add(db, day(-1));
  const tomorrow = add(db, day(1));

  const msg = await radar.runCycle({ regenerate: { from: day(0, 0), to: day(0, 23) } });
  assert.match(msg, /^重新生成：清除 1 条，/);
  assert.deepEqual(ids(db), [starred, yesterday, tomorrow].sort((a, b) => a - b));
  assert.equal(tombs(db), 0);
  const src = db.prepare("SELECT etag, last_modified FROM sources WHERE id = 't-reach'").get() as { etag: string | null; last_modified: string | null };
  assert.deepEqual({ ...src }, { etag: null, last_modified: null });
  assert.equal(radar.state.running, false);
  void today;
  done();
});

test('Radar.runCycle：普通刷新不删任何条目、不清缓存；已有任务时不重复清理', async () => {
  const { db, done } = tmpDb();
  process.env.DEEPSEEK_API_KEY = '';
  const radar = new Radar(db, loadConfig({ requireAuth: false }), () => {});
  Object.assign(radar, { reach: new Reach({ enabled: false }) });
  db.prepare('UPDATE sources SET enabled = 0').run();
  db.prepare("INSERT INTO sources(id, name, url, kind, grp, enabled, custom, etag, reach_args) VALUES ('t-reach', 't', 'https://t.example/', 'reach', 'custom', 1, 1, 'E', '[]')").run();
  add(db, day(0));
  const msg = await radar.runCycle();
  assert.doesNotMatch(msg, /重新生成/);
  assert.equal(ids(db).length, 1);
  assert.equal((db.prepare("SELECT etag FROM sources WHERE id = 't-reach'").get() as { etag: string }).etag, 'E');
  radar.state.running = true;
  assert.equal(await radar.runCycle({ regenerate: { from: day(0, 0), to: day(0, 23) } }), '已有任务在运行');
  assert.equal(ids(db).length, 1, '已有任务在跑时不能清理');
  done();
});
