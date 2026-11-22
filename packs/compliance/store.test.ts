import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';
import type { Answers } from './rules.ts';
import { CpError, assessAndMerge, createProduct, deleteProduct, getProduct, listProducts, saveExplain, updateItem, updateProduct } from './store.ts';
import { REMIND_DAYS, listReminders } from './reminders.ts';

const DAY = 86_400_000;
function tmp(): { db: DB; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-cp-'));
  const db = openDb(path.join(dir, 't.db'));
  return { db, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}
const writer = (o: Answers = {}): Answers => ({
  forms: ['app'], audience: 'public', overseas: 'no', charge: ['paid'], ai_use: 'cn_api', ai_output: 'raw', ai_media: ['text'], algo: 'no',
  social: ['none'], companion: 'no', scale: 'prelaunch', pi: ['general'], minors: 'no', cross_border: 'no', ...o,
});
const throwsCp = (fn: () => unknown, status: number) =>
  assert.throws(fn, (e: unknown) => e instanceof CpError && e.status === status);
const itemOf = (db: DB, pid: number, id: string) => getProduct(db, pid).items.find((x) => x.item === id)!;

test('迁移 11–12：合规表存在，user_version=12，cp_products 有 facts 列', () => {
  const { db, done } = tmp();
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 13);
  assert.ok((db.prepare('PRAGMA table_info(cp_products)').all() as { name: string }[]).some((c) => c.name === 'facts'));
  for (const t of ['cp_products', 'cp_assessments', 'cp_items', 'cp_entity', 'cp_docs', 'cp_doc_sections', 'cp_doc_revisions']) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t), t);
  done();
});

test('createProduct 校验：名称、描述长度，评审不存在 404，带评审取评审输入', () => {
  const { db, done } = tmp();
  throwsCp(() => createProduct(db, { name: '  ', description: '' }), 400);
  throwsCp(() => createProduct(db, { name: '名'.repeat(61), description: '' }), 400);
  throwsCp(() => createProduct(db, { name: 'a', description: 'x'.repeat(8001) }), 400);
  throwsCp(() => createProduct(db, { name: 'a', description: '' }, 999), 404);
  const rid = Number(db.prepare("INSERT INTO pm_reviews(created_at, updated_at, status, mode, input) VALUES (1, 1, 'done', 'idea', '律所 AI 助手')").run().lastInsertRowid);
  const id = createProduct(db, { name: ' 律所助手 ', description: '' }, rid, 5);
  const p = getProduct(db, id).product;
  assert.deepEqual({ name: p.name, description: p.description, review_id: p.review_id, created_at: p.created_at }, { name: '律所助手', description: '律所 AI 助手', review_id: rid, created_at: 5 });
  updateProduct(db, id, { name: '新名' }, 9);
  assert.equal(getProduct(db, id).product.name, '新名');
  throwsCp(() => updateProduct(db, id, { name: '' }), 400);
  throwsCp(() => updateProduct(db, 999, { name: 'x' }), 404);
  done();
});

test('assessAndMerge 新建台账：条数等于 required + maybe，记录一次判定', () => {
  const { db, done } = tmp();
  const id = createProduct(db, { name: '写作 App', description: '' });
  const { result, assessmentId } = assessAndMerge(db, id, writer(), ['forms'], 100);
  const n = result.items.filter((x) => x.level !== 'na').length;
  const got = getProduct(db, id);
  assert.equal(got.items.length, n);
  assert.equal(got.assessment!.id, assessmentId);
  assert.equal(got.assessment!.rules_version, 1);
  assert.deepEqual(got.assessment!.prefilled, ['forms']);
  assert.deepEqual(got.assessment!.answers, writer());
  assert.equal(Number((db.prepare('SELECT count(*) AS n FROM cp_assessments').get() as { n: number }).n), 1);
  for (const it of got.items) assert.equal(it.status, 'todo');
  throwsCp(() => assessAndMerge(db, 999, writer(), []), 404);
  done();
});

test('assessAndMerge 保留手填字段：编号、备注、状态不变，assessment_id 更新', () => {
  const { db, done } = tmp();
  const id = createProduct(db, { name: 'p', description: '' });
  const first = assessAndMerge(db, id, writer(), [], 1);
  const icp = itemOf(db, id, 'icp_filing');
  updateItem(db, icp.id, { ref_no: '京ICP备2026000001号', note: '已提交接入商', status: 'submitted' }, 2);
  const second = assessAndMerge(db, id, writer({ forms: ['app', 'web'] }), [], 3);
  assert.notEqual(second.assessmentId, first.assessmentId);
  const after = itemOf(db, id, 'icp_filing');
  assert.deepEqual([after.ref_no, after.note, after.status], ['京ICP备2026000001号', '已提交接入商', 'submitted']);
  const row = db.prepare('SELECT assessment_id FROM cp_items WHERE id = ?').get(icp.id) as { assessment_id: number };
  assert.equal(row.assessment_id, second.assessmentId);
  done();
});

test('不再适用只标 stale：状态不变，保留或标为不适用后清除', () => {
  const { db, done } = tmp();
  const id = createProduct(db, { name: 'p', description: '' });
  assessAndMerge(db, id, writer(), []);
  updateItem(db, itemOf(db, id, 'app_filing').id, { status: 'preparing' });
  assessAndMerge(db, id, writer({ forms: ['web'], charge: ['free'] }), []);
  const app = itemOf(db, id, 'app_filing');
  assert.equal(app.stale, true);
  assert.equal(app.status, 'preparing');
  assert.equal(updateItem(db, app.id, { keep: true }).stale, false);
  const lic = itemOf(db, id, 'icp_license');
  assert.equal(lic.stale, true);
  const na = updateItem(db, lic.id, { status: 'na', na_reason: '已改为免费' });
  assert.deepEqual([na.stale, na.status, na.na_reason], [false, 'na', '已改为免费']);
  assessAndMerge(db, id, writer({ forms: ['web'], charge: ['free'] }), []);
  assert.equal(itemOf(db, id, 'icp_license').stale, false);
  done();
});

test('maybe 升级为 required 时清除 stale 并更新 level', () => {
  const { db, done } = tmp();
  const id = createProduct(db, { name: 'p', description: '' });
  assessAndMerge(db, id, writer({ ai_output: 'processed' }), []);
  assert.equal(itemOf(db, id, 'genai_filing').level, 'maybe');
  assessAndMerge(db, id, writer({ ai_use: 'none', ai_output: undefined as unknown as string, ai_media: undefined as unknown as string[] }), []);
  assert.equal(itemOf(db, id, 'genai_filing').stale, true);
  assessAndMerge(db, id, writer({ ai_use: 'own' }), []);
  const g = itemOf(db, id, 'genai_filing');
  assert.deepEqual([g.level, g.stale], ['required', false]);
  done();
});

test('updateItem 校验：状态、不适用原因、编号长度、日期，不存在 404', () => {
  const { db, done } = tmp();
  const id = createProduct(db, { name: 'p', description: '' });
  assessAndMerge(db, id, writer(), []);
  const it = itemOf(db, id, 'icp_filing');
  throwsCp(() => updateItem(db, it.id, { status: 'x' as never }), 400);
  throwsCp(() => updateItem(db, it.id, { status: 'na' }), 400);
  throwsCp(() => updateItem(db, it.id, { status: 'na', na_reason: '  ' }), 400);
  throwsCp(() => updateItem(db, it.id, { na_reason: 'x'.repeat(201) }), 400);
  throwsCp(() => updateItem(db, it.id, { ref_no: 'x'.repeat(101) }), 400);
  throwsCp(() => updateItem(db, it.id, { due_at: -1 }), 400);
  throwsCp(() => updateItem(db, it.id, { due_at: 1.5 }), 400);
  throwsCp(() => updateItem(db, it.id, { ref_no: 5 as never }), 400);
  throwsCp(() => updateItem(db, 9999, { status: 'done' }), 404);
  const ok = updateItem(db, it.id, { ref_no: null, due_at: null, note: '  ' }, 7);
  assert.deepEqual([ok.ref_no, ok.due_at, ok.note, ok.updated_at], [null, null, null, 7]);
  done();
});

test('办结推算：ICP 许可 5 年到期、次年提醒；手填过到期日的不覆盖', () => {
  const { db, done } = tmp();
  const id = createProduct(db, { name: 'p', description: '' });
  assessAndMerge(db, id, writer(), []);
  const lic = itemOf(db, id, 'icp_license');
  const d = updateItem(db, lic.id, { status: 'done', done_at: Date.UTC(2026, 0, 1) });
  assert.deepEqual([d.due_at, d.remind_at], [Date.UTC(2031, 0, 1), Date.UTC(2027, 0, 1)]);
  const icp = itemOf(db, id, 'icp_filing');
  const n = updateItem(db, icp.id, { status: 'done' }, 42);
  assert.deepEqual([n.done_at, n.due_at, n.remind_at], [42, null, null]);
  const id2 = createProduct(db, { name: 'q', description: '' });
  assessAndMerge(db, id2, writer(), []);
  const lic2 = itemOf(db, id2, 'icp_license');
  updateItem(db, lic2.id, { due_at: Date.UTC(2030, 5, 1) });
  const m = updateItem(db, lic2.id, { status: 'done', done_at: Date.UTC(2026, 0, 1) });
  assert.deepEqual([m.due_at, m.remind_at], [Date.UTC(2030, 5, 1), null]);
  done();
});

test('续期：提醒已触发的事项重新办结，按新办结日重算到期与提醒；未触发的保留原日期', () => {
  const { db, done } = tmp();
  const id = createProduct(db, { name: 'p', description: '' });
  assessAndMerge(db, id, writer(), []);
  const lic = itemOf(db, id, 'icp_license');
  updateItem(db, lic.id, { status: 'done', done_at: Date.UTC(2026, 0, 1) });
  const early = Date.UTC(2026, 2, 1);
  updateItem(db, lic.id, { status: 'preparing' }, early);
  const kept = updateItem(db, lic.id, { status: 'done' }, early);
  assert.deepEqual([kept.done_at, kept.due_at, kept.remind_at], [Date.UTC(2026, 0, 1), Date.UTC(2031, 0, 1), Date.UTC(2027, 0, 1)]);
  const now = Date.UTC(2026, 11, 15);
  updateItem(db, lic.id, { status: 'preparing' }, now);
  const r = updateItem(db, lic.id, { status: 'done' }, now);
  assert.deepEqual([r.done_at, r.due_at, r.remind_at], [now, Date.UTC(2031, 11, 15), Date.UTC(2027, 11, 15)]);
  const later = Date.UTC(2027, 11, 20);
  updateItem(db, lic.id, { status: 'submitted' }, later);
  const g = updateItem(db, lic.id, { status: 'done', done_at: Date.UTC(2027, 11, 18) }, later);
  assert.deepEqual([g.done_at, g.due_at, g.remind_at], [Date.UTC(2027, 11, 18), Date.UTC(2032, 11, 18), Date.UTC(2028, 11, 18)]);
  done();
});

test('saveExplain 截断并更新事项 updated_at', () => {
  const { db, done } = tmp();
  const id = createProduct(db, { name: 'p', description: '' });
  assessAndMerge(db, id, writer(), [], 1);
  const it = itemOf(db, id, 'icp_filing');
  saveExplain(db, it.id, '  ' + '说'.repeat(700) + ' ', 77);
  const got = itemOf(db, id, 'icp_filing');
  assert.equal(got.updated_at, 77);
  assert.equal([...got.explain!].length, 600);
  done();
});

test('listReminders：30 天内为快到期，已过为逾期且排前，不适用和远期不提醒', () => {
  const { db, done } = tmp();
  const now = Date.UTC(2026, 10, 20);
  assert.equal(REMIND_DAYS, 30);
  const id = createProduct(db, { name: '写作', description: '' });
  assessAndMerge(db, id, writer(), []);
  const at = (k: string) => itemOf(db, id, k).id;
  updateItem(db, at('icp_filing'), { remind_at: now + 10 * DAY });
  updateItem(db, at('icp_license'), { due_at: now - DAY });
  updateItem(db, at('app_filing'), { remind_at: now + 40 * DAY });
  updateItem(db, at('mlps'), { status: 'na', na_reason: '无', remind_at: now + DAY });
  const r = listReminders(db, now);
  assert.deepEqual(r.map((x) => [x.item, x.kind]), [['icp_license', 'overdue'], ['icp_filing', 'soon']]);
  assert.deepEqual([r[0].productId, r[0].productName, r[0].name, r[0].date], [id, '写作', 'ICP 经营许可证（增值电信业务）', now - DAY]);
  done();
});

test('listProducts 计数：必须办、未完成、提醒', () => {
  const { db, done } = tmp();
  const now = Date.UTC(2026, 10, 20);
  const a = createProduct(db, { name: 'a', description: '' }, null, 1);
  const b = createProduct(db, { name: 'b', description: '' }, null, 2);
  assessAndMerge(db, a, writer({ ai_output: 'processed' }), [], 3);
  const req = getProduct(db, a).items.filter((x) => x.level === 'required');
  updateItem(db, req[0].id, { status: 'done' }, 4);
  updateItem(db, req[1].id, { remind_at: now + DAY }, 4);
  const list = listProducts(db, now);
  assert.deepEqual(list.map((p) => p.id), [a, b]);
  const pa = list[0];
  assert.equal(pa.required, req.length);
  assert.equal(pa.open, getProduct(db, a).items.length - 1);
  assert.equal(pa.alerts, 1);
  assert.deepEqual([list[1].required, list[1].open, list[1].alerts], [0, 0, 0]);
  done();
});

test('deleteProduct 级联：三张表都清空；再删 404', () => {
  const { db, done } = tmp();
  const id = createProduct(db, { name: 'p', description: '' });
  assessAndMerge(db, id, writer(), []);
  deleteProduct(db, id);
  for (const t of ['cp_products', 'cp_assessments', 'cp_items']) assert.equal(Number((db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n), 0, t);
  throwsCp(() => deleteProduct(db, id), 404);
  throwsCp(() => getProduct(db, id), 404);
  done();
});
