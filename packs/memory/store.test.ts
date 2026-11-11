import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';
import { recordEvent } from './events.ts';
import {
  MAX_MEMORIES,
  addMemory,
  clearMemory,
  deleteMemory,
  evictOverflow,
  exportMemory,
  getProfile,
  listMemories,
  logChange,
  recentChanges,
  setProfile,
  undoChange,
  updateMemory,
} from './store.ts';

const T = 1_800_000_000_000;
const DAY = 86_400_000;

function tmp(): { db: DB; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-store-'));
  const db = openDb(path.join(dir, 't.db'));
  return { db, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}
const all = (db: DB, sql: string) => (db.prepare(sql).all() as Record<string, unknown>[]).map((r) => ({ ...r }));
const lastChange = (db: DB) => Number((db.prepare('SELECT max(id) AS id FROM memory_changes').get() as { id: number }).id);

/** 模拟一次自动整理新增的条目 */
function autoAdd(db: DB, kind: string, content: string, at = T): number {
  const id = Number(db.prepare('INSERT INTO memories(kind, content, created_at, updated_at) VALUES (?, ?, ?, ?)').run(kind, content, at, at).lastInsertRowid);
  logChange(db, { op: 'add', memoryId: id, kind, after: { kind, content, manual: false }, source: 'auto', eventIds: [] }, at);
  return id;
}

test('手动增改删：校验 kind/长度/敏感信息，写 manual 变更', () => {
  const { db, done } = tmp();
  assert.throws(() => addMemory(db, 'mood', 'x'), { status: 400, message: '记忆类型不合法' });
  assert.throws(() => addMemory(db, 'fact', '   '), { status: 400, message: '内容需在 1–200 字之间' });
  assert.throws(() => addMemory(db, 'fact', 'x'.repeat(201)), { status: 400 });
  assert.throws(() => addMemory(db, 'fact', '我的手机 13812345678'), { status: 400, message: '看起来包含敏感信息（如 Key、手机号），没有保存' });
  const id = addMemory(db, 'fact', '  在做律所合同审查工具 ', T);
  assert.deepEqual(
    listMemories(db).map((m) => [m.id, m.kind, m.content, m.manual]),
    [[id, 'fact', '在做律所合同审查工具', true]],
  );
  updateMemory(db, id, { content: '在做中小律所合同审查 SaaS' }, T + 1);
  updateMemory(db, id, { kind: 'decision', content: '先做律所，不做企业法务' }, T + 2);
  assert.equal(listMemories(db)[0].kind, 'decision');
  assert.throws(() => updateMemory(db, id, { kind: 'bad', content: 'x' }), { status: 400 });
  assert.throws(() => updateMemory(db, 999, { content: 'x' }), { status: 404 });
  deleteMemory(db, id, T + 3);
  assert.throws(() => deleteMemory(db, id), { status: 404 });
  assert.deepEqual(all(db, 'SELECT op, source FROM memory_changes ORDER BY id'), [
    { op: 'add', source: 'manual' },
    { op: 'update', source: 'manual' },
    { op: 'update', source: 'manual' },
    { op: 'delete', source: 'manual' },
  ]);
  const del = all(db, "SELECT before FROM memory_changes WHERE op = 'delete'")[0];
  assert.deepEqual(JSON.parse(String(del.before)), { kind: 'decision', content: '先做律所，不做企业法务', manual: true });
  done();
});

test('手动编辑自动条目会把它标成手动', () => {
  const { db, done } = tmp();
  const id = autoAdd(db, 'interest', '关注 AI 硬件');
  assert.equal(listMemories(db)[0].manual, false);
  updateMemory(db, id, { content: '关注端侧 AI 硬件' }, T + 1);
  assert.equal(listMemories(db)[0].manual, true);
  done();
});

test('setProfile：≤1500 字、置 manual、记变更', () => {
  const { db, done } = tmp();
  assert.throws(() => setProfile(db, 'x'.repeat(1501)), { status: 400, message: '画像最多 1500 字' });
  assert.throws(() => setProfile(db, '邮箱 a@b.com'), { status: 400 });
  assert.throws(() => setProfile(db, 5), { status: 400 });
  setProfile(db, '## 身份与业务\n独立开发者', T);
  assert.deepEqual(getProfile(db), { content: '## 身份与业务\n独立开发者', updated_at: T, manual: true });
  const c = all(db, 'SELECT op, source, before, after FROM memory_changes')[0];
  assert.deepEqual([c.op, c.source, JSON.parse(String(c.before)), JSON.parse(String(c.after))], [
    'profile',
    'manual',
    { content: '', manual: false },
    { content: '## 身份与业务\n独立开发者', manual: true },
  ]);
  done();
});

test('撤销 add / update / delete / evict / profile', () => {
  const { db, done } = tmp();
  // add
  const a = autoAdd(db, 'fact', '在做律所工具');
  undoChange(db, lastChange(db), T + 1);
  assert.equal(listMemories(db).length, 0);
  // update：内容与 manual 回到 before
  const b = autoAdd(db, 'fact', '原内容', T + 2);
  updateMemory(db, b, { content: '新内容' }, T + 3);
  undoChange(db, lastChange(db), T + 4);
  assert.deepEqual(listMemories(db).map((m) => [m.id, m.content, m.manual]), [[b, '原内容', false]]);
  // delete：用原 id 重新插入，manual 取 before
  addMemory(db, 'preference', '喜欢短句', T + 5);
  const p = listMemories(db).find((m) => m.content === '喜欢短句')!.id;
  deleteMemory(db, p, T + 6);
  undoChange(db, lastChange(db), T + 7);
  assert.deepEqual(listMemories(db).find((m) => m.id === p)?.manual, true);
  // evict
  db.prepare('DELETE FROM memories WHERE id = ?').run(b);
  logChange(db, { op: 'delete', memoryId: b, kind: 'fact', before: { kind: 'fact', content: '原内容', manual: false }, source: 'evict' }, T + 8);
  undoChange(db, lastChange(db), T + 9);
  assert.equal(listMemories(db).find((m) => m.id === b)?.content, '原内容');
  // profile
  setProfile(db, '画像一', T + 10);
  setProfile(db, '画像二', T + 11);
  undoChange(db, lastChange(db), T + 12);
  assert.deepEqual(getProfile(db).content, '画像一');
  // 每次撤销都写 undo 变更并标记原变更
  const undos = all(db, "SELECT count(*) AS n FROM memory_changes WHERE source = 'undo'")[0].n;
  const undone = all(db, 'SELECT count(*) AS n FROM memory_changes WHERE undone_at IS NOT NULL')[0].n;
  assert.deepEqual([undos, undone], [5, 5]);
  assert.ok(a > 0);
  done();
});

test('撤销被拒：后续已修改、超过 30 天、已撤销、撤销记录本身、不存在', () => {
  const { db, done } = tmp();
  const id = autoAdd(db, 'fact', '甲', T);
  const addChange = lastChange(db);
  updateMemory(db, id, { content: '乙' }, T + 1);
  const upd = lastChange(db);
  assert.throws(() => undoChange(db, addChange, T + 2), { status: 409, message: '已被后续修改，请直接编辑' });
  undoChange(db, upd, T + 3);
  assert.throws(() => undoChange(db, upd, T + 4), { status: 409, message: '已撤销' });
  assert.throws(() => undoChange(db, lastChange(db), T + 4), { status: 409, message: '这条记录不能撤销' });
  // 后续变更已撤销时，前一条可以撤销
  undoChange(db, addChange, T + 5);
  assert.equal(listMemories(db).length, 0);
  autoAdd(db, 'fact', '丙', T);
  assert.throws(() => undoChange(db, lastChange(db), T + 31 * DAY), { status: 409, message: '超过 30 天，无法撤销' });
  assert.throws(() => undoChange(db, 9999, T), { status: 404 });
  // 画像之后又被改过
  setProfile(db, 'P1', T);
  const p1 = lastChange(db);
  setProfile(db, 'P2', T + 1);
  assert.throws(() => undoChange(db, p1, T + 2), { status: 409, message: '已被后续修改，请直接编辑' });
  done();
});

test('evictOverflow：超过 60 条按 manual、最近使用、hits、id 淘汰并记 evict', () => {
  const { db, done } = tmp();
  for (let i = 0; i < MAX_MEMORIES; i++) db.prepare('INSERT INTO memories(kind, content, manual, created_at, updated_at, hits) VALUES (?, ?, 1, ?, ?, 0)').run('fact', `手动${i}`, T, T);
  const old = autoAdd(db, 'fact', '旧自动', T - DAY);
  const usedOld = autoAdd(db, 'fact', '用过的自动', T - 3 * DAY);
  db.prepare('UPDATE memories SET last_used_at = ? WHERE id = ?').run(T, usedOld);
  const hot = autoAdd(db, 'fact', '热门自动', T - DAY);
  db.prepare('UPDATE memories SET hits = 5 WHERE id = ?').run(hot);
  assert.equal(evictOverflow(db, T + 1), 3);
  // 全部淘汰的都是自动条目，顺序：最近使用早的、hits 少的先走
  assert.deepEqual(
    all(db, "SELECT memory_id, source FROM memory_changes WHERE source = 'evict' ORDER BY id").map((r) => r.memory_id),
    [old, hot, usedOld],
  );
  assert.equal(listMemories(db).length, MAX_MEMORIES);
  assert.equal(evictOverflow(db, T + 2), 0);
  done();
});

test('addMemory：60 条全是手动时拒绝新增；有自动条目时新增后淘汰自动条目', () => {
  const { db, done } = tmp();
  for (let i = 0; i < MAX_MEMORIES - 1; i++) db.prepare('INSERT INTO memories(kind, content, manual, created_at, updated_at) VALUES (?, ?, 1, ?, ?)').run('fact', `手动${i}`, T, T);
  const auto = autoAdd(db, 'fact', '自动一条');
  addMemory(db, 'fact', '新手动', T + 1);
  assert.equal(listMemories(db).length, MAX_MEMORIES);
  assert.equal(listMemories(db).some((m) => m.id === auto), false);
  assert.throws(() => addMemory(db, 'fact', '再来一条'), { status: 409, message: '记忆已满 60 条，请先删除不需要的' });
  done();
});

test('clearMemory：没有确认串 400，确认后清空三表并重置画像', () => {
  const { db, done } = tmp();
  addMemory(db, 'fact', '甲', T);
  setProfile(db, '画像', T);
  recordEvent(db, { kind: 'item_star', refType: 'item', refId: 1, summary: 's' }, T);
  assert.throws(() => clearMemory(db, undefined), { status: 400, message: '请输入「清空」确认' });
  assert.throws(() => clearMemory(db, '清 空'), { status: 400 });
  clearMemory(db, '清空');
  for (const t of ['memories', 'memory_changes', 'events']) assert.equal(all(db, `SELECT count(*) AS n FROM ${t}`)[0].n, 0);
  assert.deepEqual([getProfile(db).content, getProfile(db).manual], ['', false]);
  done();
});

test('recentChanges：附来源事件 summary，undoable 与 undoChange 判断一致', () => {
  const { db, done } = tmp();
  const ev = recordEvent(db, { kind: 'review_create', refType: 'review', refId: 1, summary: '评审：律所工具' }, T)!;
  const id = Number(db.prepare('INSERT INTO memories(kind, content, created_at, updated_at) VALUES (?, ?, ?, ?)').run('fact', '在做律所工具', T, T).lastInsertRowid);
  logChange(db, { op: 'add', memoryId: id, kind: 'fact', after: { kind: 'fact', content: '在做律所工具', manual: false }, reason: '首次提到', source: 'auto', eventIds: [ev] }, T);
  updateMemory(db, id, { content: '在做律所 SaaS' }, T + 1);
  const ch = recentChanges(db, 50, T + 2);
  assert.deepEqual(
    ch.map((c) => [c.op, c.source, c.undoable, c.events]),
    [
      ['update', 'manual', true, []],
      ['add', 'auto', false, ['评审：律所工具']],
    ],
  );
  assert.deepEqual(ch[1].after, { kind: 'fact', content: '在做律所工具', manual: false });
  assert.equal(ch[1].reason, '首次提到');
  assert.equal(recentChanges(db, 50, T + 31 * DAY)[0].undoable, false);
  const ex = exportMemory(db);
  assert.equal(ex.memories.length, 1);
  assert.equal(ex.changes.length, 2);
  done();
});

test('撤销删除/淘汰：其余 60 条全是手动时拒绝，不淘汰手动条目', () => {
  const { db, done } = tmp();
  for (let i = 0; i < MAX_MEMORIES - 1; i++) db.prepare('INSERT INTO memories(kind, content, manual, created_at, updated_at) VALUES (?, ?, 1, ?, ?)').run('fact', `手动${i}`, T, T);
  autoAdd(db, 'fact', '自动一条');
  addMemory(db, 'fact', '新手动', T + 1);
  const evict = Number((db.prepare("SELECT id FROM memory_changes WHERE source = 'evict'").get() as { id: number }).id);
  assert.throws(() => undoChange(db, evict, T + 2), { status: 409, message: '记忆已满 60 条，请先删除不需要的' });
  assert.equal(listMemories(db).filter((m) => m.manual).length, MAX_MEMORIES);
  assert.equal(all(db, 'SELECT undone_at FROM memory_changes WHERE id = ' + evict)[0].undone_at, null);
  done();
});
