import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';
import { syncSources } from './collect.ts';
import { FEED_LIMITS, feedWiki } from './feed.ts';

const HOUR = 3600 * 1000;
// 固定「现在」为本地 2026-11-25 10:00，昨天即 2026-11-24
const NOW = new Date(2026, 10, 25, 10, 0, 0).getTime();
const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0, 0).getTime();

function tmpDb(): { db: DB; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-feed-'));
  const db = openDb(path.join(dir, 't.db'));
  syncSources(db);
  return { db, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}

let seq = 0;
function add(db: DB, o: { pub: number; imp?: number; rel?: number | null; dup?: number | null; analyzed?: boolean; title?: string; topics?: string[] }): number {
  seq++;
  return Number(
    db
      .prepare(
        `INSERT INTO items(source_id, url, title, norm_title, published_at, fetched_at, content, topics, title_zh, summary_zh, analyzed_at, importance, relevance, dup_of)
         VALUES ('openai', ?, ?, '', ?, ?, 'c', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(`https://a.com/${seq}`, `T${seq}`, o.pub, o.pub, JSON.stringify(o.topics ?? ['llm']), o.title ?? `标题${seq}`, `摘要${seq}`, o.analyzed === false ? null : o.pub, o.analyzed === false ? null : (o.imp ?? 4), o.rel ?? null, o.dup ?? null).lastInsertRowid,
  );
}
const docs = (db: DB) => db.prepare('SELECT id, kind, title, item_id, folder_id FROM kb_docs ORDER BY id').all() as { id: number; kind: string; title: string; item_id: number | null; folder_id: number | null }[];

test('日报：昨天重要度 ≥3 的条目汇总成一份笔记，按主题分组，归并的来源并入；只生成一次', () => {
  const { db, done } = tmpDb();
  const a = add(db, { pub: at(24, 9), imp: 5, title: '重磅发布' });
  const b = add(db, { pub: at(24, 12), imp: 3, topics: ['multimodal'], title: '多模态进展' });
  add(db, { pub: at(24, 15), imp: 4, topics: [], title: '无主题的' });
  add(db, { pub: at(24, 16), imp: 2, title: '重要度太低' });
  add(db, { pub: at(24, 17), imp: 4, dup: a, title: '已并入的' });
  add(db, { pub: at(23, 23), imp: 4, title: '前天的' });
  add(db, { pub: at(25, 1), imp: 4, title: '今天的' });
  add(db, { pub: at(24, 18), imp: 4, analyzed: false, title: '还没分析' });
  assert.equal(feedWiki(db, NOW), 1);
  const d = docs(db);
  assert.equal(d.length, 1);
  assert.equal(d[0].kind, 'note');
  assert.equal(d[0].title, '情报日报 2026-11-24');
  assert.ok(d[0].folder_id != null);
  assert.equal((db.prepare('SELECT name FROM kb_folders WHERE id = ?').get(d[0].folder_id) as { name: string }).name, '情报');
  const body = (db.prepare('SELECT body FROM kb_docs WHERE id = ?').get(d[0].id) as { body: string }).body;
  assert.match(body, /^# 情报日报 2026-11-24/);
  for (const t of ['重磅发布', '多模态进展', '无主题的']) assert.ok(body.includes(t), t);
  for (const t of ['重要度太低', '已并入的', '前天的', '今天的', '还没分析']) assert.ok(!body.includes(t), `不应包含 ${t}`);
  assert.match(body, /## 大模型[\s\S]*重磅发布/);
  assert.match(body, /## 多模态[\s\S]*多模态进展/);
  assert.match(body, /## 其他[\s\S]*无主题的/);
  assert.match(body, /另有 1 个来源/, '被并入的条目体现为「另有 N 个来源」');
  void b;
  assert.equal(feedWiki(db, NOW + HOUR), 0, '同一天不重复生成');
  assert.equal(docs(db).length, 1);
  done();
});

test('日报：凌晨 2 点前即使条数够也不生成，2 点后生成', () => {
  const { db, done } = tmpDb();
  for (let i = 0; i < 3; i++) add(db, { pub: at(24, 9 + i) });
  assert.equal(feedWiki(db, at(25, 1)), 0);
  assert.equal(docs(db).length, 0);
  assert.equal(feedWiki(db, at(25, 3)), 1);
  done();
});

test('日报：不足 3 条不生成但记一笔不再重试；凌晨 2 点前不生成；删除后不会被重新生成', () => {
  const { db, done } = tmpDb();
  add(db, { pub: at(24, 9) });
  add(db, { pub: at(24, 10) });
  assert.equal(feedWiki(db, at(25, 1)), 0, '2 点前不生成');
  assert.equal(feedWiki(db, NOW), 0);
  add(db, { pub: at(24, 11) });
  assert.equal(feedWiki(db, NOW + HOUR), 0, '不足时已记录，当天不重试');
  assert.equal(docs(db).length, 0);
  const { db: db2, done: done2 } = tmpDb();
  for (let i = 0; i < 3; i++) add(db2, { pub: at(24, 9 + i) });
  assert.equal(feedWiki(db2, NOW), 1);
  db2.prepare('DELETE FROM kb_docs').run();
  assert.equal(feedWiki(db2, NOW + HOUR), 0, '用户删除后不重新生成');
  done2();
  done();
});

test('与你相关的资讯：relevance ≥2 且重要度 ≥3、48 小时内、非重复，存成资讯条目；不重复存', () => {
  const { db, done } = tmpDb();
  const ok1 = add(db, { pub: NOW - 2 * HOUR, rel: 3, imp: 4 });
  const ok2 = add(db, { pub: NOW - 3 * HOUR, rel: 2, imp: 3 });
  add(db, { pub: NOW - 2 * HOUR, rel: 1, imp: 5 });
  add(db, { pub: NOW - 2 * HOUR, rel: 3, imp: 2 });
  add(db, { pub: NOW - 50 * HOUR, rel: 3, imp: 5 });
  add(db, { pub: NOW - 2 * HOUR, rel: 3, imp: 5, dup: ok1 });
  add(db, { pub: NOW - 2 * HOUR, rel: 3, imp: 5, analyzed: false });
  assert.equal(feedWiki(db, NOW), 2);
  assert.deepEqual(docs(db).map((d) => d.item_id), [ok1, ok2], '按相关度、重要度排序');
  assert.ok(docs(db).every((d) => d.kind === 'item' && d.folder_id != null));
  assert.equal(feedWiki(db, NOW + HOUR), 0);
  assert.equal(docs(db).length, 2);
  db.prepare('DELETE FROM kb_docs').run();
  assert.equal(feedWiki(db, NOW + 2 * HOUR), 0, '用户删除知识库条目后不会被重新存入');
  assert.equal(docs(db).length, 0);
  done();
});

test('每天最多 10 份（日报 + 单条）；次日额度重置；已在知识库里的资讯只记录不重复建', () => {
  const { db, done } = tmpDb();
  for (let i = 0; i < 3; i++) add(db, { pub: at(24, 9 + i) });
  const ids = Array.from({ length: 14 }, (_, i) => add(db, { pub: NOW - (i + 1) * 600_000, rel: 3, imp: 4 }));
  assert.equal(feedWiki(db, NOW), FEED_LIMITS.dailyDocs);
  assert.equal(docs(db).length, 10);
  assert.equal(docs(db)[0].kind, 'note', '日报占 1 份');
  assert.equal(docs(db).filter((d) => d.kind === 'item').length, 9);
  assert.equal(feedWiki(db, NOW + HOUR), 0, '当天额度用完');
  // 次日：先生成 25 日的日报（那天有 14 条重要资讯），再补存剩下的 5 条，共 6 份
  assert.equal(feedWiki(db, NOW + 24 * HOUR), 6);
  assert.equal(docs(db).length, 16);
  assert.equal(docs(db).filter((d) => d.kind === 'note').length, 2);
  void ids;
  const { db: db2, done: done2 } = tmpDb();
  const x = add(db2, { pub: NOW - HOUR, rel: 3, imp: 4 });
  db2.prepare("INSERT INTO kb_docs(kind, title, item_id, created_at, updated_at) VALUES ('item', 'x', ?, 1, 1)").run(x);
  assert.equal(feedWiki(db2, NOW), 0);
  assert.equal(docs(db2).length, 1);
  done2();
  done();
});

test('日报正文：标题与摘要里的方括号、尖括号和换行被清理，不会生成多余结构', () => {
  const { db, done } = tmpDb();
  add(db, { pub: at(24, 9), title: '恶意 [链接](javascript:x) <img onerror=1>\n# 注入标题' });
  add(db, { pub: at(24, 10) });
  add(db, { pub: at(24, 11) });
  feedWiki(db, NOW);
  const body = (db.prepare("SELECT body FROM kb_docs WHERE kind = 'note'").get() as { body: string }).body;
  assert.ok(!body.includes('<img') && !body.includes('](javascript'));
  assert.equal(body.split('\n').filter((l) => /^# /.test(l)).length, 1, '只有日报自己的一级标题');
  done();
});
