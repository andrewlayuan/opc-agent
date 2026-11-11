import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';

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
