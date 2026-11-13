import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import { createDoc, refreshStale } from '../../packs/kb/docs.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-mcp-'));
process.env.OPC_DATA_DIR = dir;
const file = path.join(dir, 'opc.db');
const T = Date.UTC(2026, 10, 1);

{
  const db = openDb(file);
  db.prepare('UPDATE profile SET content = ?, updated_at = ? WHERE id = 1').run('独立开发者，在做律所合同审查工具', T);
  const mem = db.prepare('INSERT INTO memories(kind, content, created_at, updated_at) VALUES (?, ?, ?, ?)');
  mem.run('decision', '先做律所市场，暂不做个人用户', T, T);
  mem.run('interest', '端侧模型', T, T);
  const rv = db.prepare("INSERT INTO pm_reviews(created_at, updated_at, status, mode, input) VALUES (?, ?, 'done', 'idea', ?)");
  const ver = db.prepare("INSERT INTO pm_versions(review_id, n, created_at, source, content) VALUES (?, 1, ?, 'ai_initial', ?)");
  for (let i = 1; i <= 12; i++) {
    const id = Number(rv.run(T + i, T + i, `面向中小律所的合同审查第${i}版`).lastInsertRowid);
    ver.run(id, T + i, `## 一句话结论\n有条件地做${i}\n\n## 机会\n很多`);
  }
  db.close();
}

const { TOOLS, callTool } = await import('./server.ts');

after(() => fs.rmSync(dir, { recursive: true, force: true }));

const len = (s: string) => [...s].length;

function bigDb(): { file: string } {
  const f = path.join(dir, 'big.db');
  const db = openDb(f);
  db.prepare('UPDATE profile SET content = ?, updated_at = 1 WHERE id = 1').run('画'.repeat(1500));
  const mem = db.prepare('INSERT INTO memories(kind, content, created_at, updated_at) VALUES (?, ?, 1, 1)');
  for (let i = 0; i < 60; i++) mem.run(['fact', 'preference', 'decision', 'interest'][i % 4], `${i}`.padEnd(200, '记'));
  db.close();
  return { file: f };
}

test('tools/list 含 memory_profile 与 history_search', () => {
  const names = TOOLS.map((t) => t.name);
  assert.ok(names.includes('memory_profile'));
  assert.ok(names.includes('history_search'));
});

test('memory_profile：画像 + 按类分组的记忆，≤6000 字；无数据返回「暂无记忆」', () => {
  const out = callTool('memory_profile', {});
  assert.match(out, /独立开发者，在做律所合同审查工具/);
  assert.match(out, /## 决定\n- 先做律所市场，暂不做个人用户/);
  assert.match(out, /## 关注\n- 端侧模型/);
  assert.ok(out.indexOf('独立开发者') < out.indexOf('## 决定'));

  const big = new DatabaseSync(bigDb().file, { readOnly: true });
  const outBig = callTool('memory_profile', {}, big);
  assert.ok(len(outBig) <= 6000, `len=${len(outBig)}`);
  big.close();

  const ef = path.join(dir, 'empty.db');
  openDb(ef).close();
  const empty = new DatabaseSync(ef, { readOnly: true });
  assert.equal(callTool('memory_profile', {}, empty), '暂无记忆');
  empty.close();
});

test('history_search：返回 #id 日期 需求摘要｜命中片段｜最新结论；query 少于 2 字或超过 200 字报错；limit 限制在 1–10', () => {
  const out = callTool('history_search', { query: '合同审查' });
  const lines = out.split('\n').filter(Boolean);
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^#\d+ 2026-11-01 面向中小律所的合同审查第\d+版｜.*【.*】.*｜有条件地做\d+$/);
  assert.equal(callTool('history_search', { query: '合同审查', limit: 50 }).split('\n').filter(Boolean).length, 10);
  assert.equal(callTool('history_search', { query: '合同审查', limit: 0 }).split('\n').filter(Boolean).length, 1);
  assert.equal(callTool('history_search', { query: '完全无关的话题' }), '没有找到相关的历史讨论。');
  assert.throws(() => callTool('history_search', { query: '合' }), /2–200/);
  assert.throws(() => callTool('history_search', { query: ' ' }), /2–200/);
  assert.throws(() => callTool('history_search', { query: '合'.repeat(201) }), /2–200/);
  assert.throws(() => callTool('history_search', {}), /2–200/);
});

test('旧库（缺少记忆表与 history_fts）：两个工具都不抛错', () => {
  const f = path.join(dir, 'v4.db');
  openDb(f).close();
  const raw = new DatabaseSync(f);
  raw.exec(`
    DROP TRIGGER IF EXISTS pm_reviews_hi; DROP TRIGGER IF EXISTS pm_versions_hi; DROP TRIGGER IF EXISTS pm_messages_hi;
    DROP TRIGGER IF EXISTS pm_messages_hu; DROP TRIGGER IF EXISTS pm_reviews_hd;
    DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS memories; DROP TABLE IF EXISTS profile;
    DROP TABLE IF EXISTS memory_changes; DROP TABLE IF EXISTS history_fts;
    PRAGMA user_version = 4;
    INSERT INTO pm_reviews(created_at, status, mode, input) VALUES (1, 'done', 'idea', '合同审查工具');`);
  raw.close();
  const old = new DatabaseSync(f, { readOnly: true });
  assert.equal(callTool('memory_profile', {}, old), '暂无记忆');
  assert.equal(callTool('history_search', { query: '合同审查' }, old), '没有找到相关的历史讨论。');
  old.close();
});

function kbDb(): { db: DatabaseSync; ids: Record<string, number>; close: () => void } {
  const f = path.join(dir, `kb-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(f);
  const ids: Record<string, number> = {};
  const folder = (name: string, parent: number | null) => Number(db.prepare('INSERT INTO kb_folders(parent_id, name, created_at) VALUES (?, ?, 1)').run(parent, name).lastInsertRowid);
  const prod = folder('产品', null);
  const comp = folder('竞品', prod);
  ids.note = createDoc(db, { kind: 'note', title: '竞品分析', folderId: comp, body: '## 定价策略\n竞品甲的合同审查按席位收费，每席位每月 99 元' });
  ids.long = createDoc(db, { kind: 'note', title: '长文', body: `${'甲'.repeat(8000)}${'乙'.repeat(8000)}${'丙'.repeat(100)}` });
  const rid = Number(db.prepare("INSERT INTO pm_reviews(created_at, updated_at, status, mode, input) VALUES (1, 1, 'done', 'idea', '律所工具')").run().lastInsertRowid);
  db.prepare("INSERT INTO pm_versions(review_id, n, created_at, source, content) VALUES (?, 1, 1, 'ai_initial', '## 一句话结论\n值得做\n\n## 风险\n获客难')").run(rid);
  ids.rid = rid;
  ids.review = createDoc(db, { kind: 'review', reviewId: rid });
  db.prepare("INSERT OR IGNORE INTO sources(id, name, url) VALUES ('s1', '源', 'https://s')").run();
  const iid = Number(
    db.prepare("INSERT INTO items(source_id, url, title, norm_title, published_at, fetched_at, content, title_zh) VALUES ('s1', 'https://news.example/a', 'Pricing', '', 1, 1, 'body', '定价新闻')").run().lastInsertRowid,
  );
  ids.iid = iid;
  ids.item = createDoc(db, { kind: 'item', itemId: iid });
  const rid2 = Number(db.prepare("INSERT INTO pm_reviews(created_at, updated_at, status, mode, input) VALUES (1, 1, 'done', 'idea', '待删')").run().lastInsertRowid);
  db.prepare("INSERT INTO pm_versions(review_id, n, created_at, source, content) VALUES (?, 1, 1, 'ai_initial', '内容')").run(rid2);
  ids.orphan = createDoc(db, { kind: 'review', reviewId: rid2 });
  db.prepare('DELETE FROM pm_reviews WHERE id = ?').run(rid2);
  refreshStale(db);
  db.close();
  const ro = new DatabaseSync(f, { readOnly: true });
  return { db: ro, ids, close: () => ro.close() };
}

test('kb 工具：tools/list 含 kb_search、kb_doc，说明写明只读与可能不是最新版本', () => {
  for (const n of ['kb_search', 'kb_doc']) {
    const t = TOOLS.find((x) => x.name === n);
    assert.ok(t, n);
    assert.match(t!.description, /只读；评审类条目可能不是最新版本/);
  }
});

test('kb_search：#docId 路径/标题 › heading｜片段；limit 默认 5、最大 10；无命中提示', () => {
  const { db, ids, close } = kbDb();
  const out = callTool('kb_search', { query: '合同审查按席位' }, db);
  assert.match(out.split('\n')[0], new RegExp(`^#${ids.note} 产品/竞品/竞品分析 › 定价策略｜.*【.*】`));
  assert.equal(callTool('kb_search', { query: '没有这种内容的查询' }, db), '知识库中没有找到相关内容');
  assert.ok(callTool('kb_search', { query: '甲', limit: 50 }, db).split('\n').length <= 10);
  assert.throws(() => callTool('kb_search', { query: ' ' }, db), /query/);
  close();
});

test('kb_doc：标题、路径、来源、分页正文；不存在与孤儿条目', () => {
  const { db, ids, close } = kbDb();
  const p2 = callTool('kb_doc', { id: ids.long, page: 2 }, db);
  assert.match(p2, /^标题：长文\n目录：未归类\n来源：笔记\n/);
  assert.ok(p2.includes('乙'.repeat(8000)));
  assert.ok(!p2.includes('甲'));
  assert.ok(p2.endsWith('（第 2/3 页）'));
  assert.ok(callTool('kb_doc', { id: ids.long }, db).endsWith('（第 1/3 页）'));
  const rv = callTool('kb_doc', { id: ids.review }, db);
  assert.match(rv, new RegExp(`来源：评审 #${ids.rid}\n`));
  assert.match(rv, /## 一句话结论\n值得做\n\n## 风险\n获客难/);
  assert.match(callTool('kb_doc', { id: ids.item }, db), new RegExp(`来源：资讯 #${ids.iid} https://news\\.example/a\n`));
  assert.match(callTool('kb_doc', { id: ids.orphan }, db), /来源已删除/);
  assert.throws(() => callTool('kb_doc', { id: 99999 }, db), /^Error: 条目不存在$/);
  assert.throws(() => callTool('kb_doc', { id: ids.long, page: 9 }, db), /页码/);
  close();
});
