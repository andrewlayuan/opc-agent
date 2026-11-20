// 合规台账存储：产品、判定快照、事项。全部同步，出错抛 CpError（status 即 HTTP 状态码）
import type { DB } from '../../packages/core/db.ts';
import { alertOf } from './reminders.ts';
import { CATALOG, RULES_VERSION, assess, nextDates, type Answers, type AssessResult } from './rules.ts';

export class CpError extends Error {
  status: 400 | 404 | 409;
  detail?: Record<string, unknown>;
  constructor(status: 400 | 404 | 409, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export type ItemStatus = 'todo' | 'preparing' | 'submitted' | 'done' | 'na';
const STATUSES = new Set<ItemStatus>(['todo', 'preparing', 'submitted', 'done', 'na']);

export interface ProductView { id: number; name: string; description: string; review_id: number | null; created_at: number; updated_at: number }
export interface ItemView {
  id: number; item: string; level: 'required' | 'maybe'; status: ItemStatus; stale: boolean;
  ref_no: string | null; done_at: number | null; due_at: number | null; remind_at: number | null;
  note: string | null; na_reason: string | null; explain: string | null; updated_at: number;
}
export interface AssessmentView { id: number; created_at: number; rules_version: number; answers: Answers; prefilled: string[]; result: AssessResult }

export const NAME_MAX = 60;
export const DESC_MAX = 8000;
export const REF_MAX = 100;
export const NA_REASON_MAX = 200;
export const NOTE_MAX = 2000;
export const EXPLAIN_MAX = 600;

const len = (s: string) => [...s].length;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const ORDER = new Map(CATALOG.map((c, i) => [c.id, i]));

function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function checkName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n || len(n) > NAME_MAX) throw new CpError(400, `产品名需 1–${NAME_MAX} 字`);
  return n;
}
function checkDesc(d: unknown): string {
  if (d === undefined || d === null) return '';
  if (typeof d !== 'string' || len(d) > DESC_MAX) throw new CpError(400, `描述不超过 ${DESC_MAX} 字`);
  return d.trim();
}

const toProduct = (r: Record<string, unknown>): ProductView => ({
  id: Number(r.id), name: String(r.name), description: String(r.description), review_id: num(r.review_id),
  created_at: Number(r.created_at), updated_at: Number(r.updated_at),
});
const toItem = (r: Record<string, unknown>): ItemView => ({
  id: Number(r.id), item: String(r.item), level: String(r.level) as ItemView['level'], status: String(r.status) as ItemStatus,
  stale: Number(r.stale) === 1, ref_no: str(r.ref_no), done_at: num(r.done_at), due_at: num(r.due_at), remind_at: num(r.remind_at),
  note: str(r.note), na_reason: str(r.na_reason), explain: str(r.explain), updated_at: Number(r.updated_at),
});

function productRow(db: DB, id: number): Record<string, unknown> {
  const r = db.prepare('SELECT * FROM cp_products WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!r) throw new CpError(404, '产品不存在');
  return r;
}

export function createProduct(db: DB, input: { name: unknown; description?: unknown }, reviewId?: number | null, now = Date.now()): number {
  const name = checkName(input.name);
  let description = checkDesc(input.description);
  if (reviewId !== undefined && reviewId !== null) {
    const r = db.prepare('SELECT input FROM pm_reviews WHERE id = ?').get(reviewId) as { input: string } | undefined;
    if (!r) throw new CpError(404, '评审不存在');
    if (!description) description = [...String(r.input)].slice(0, DESC_MAX).join('');
  }
  return Number(
    db.prepare('INSERT INTO cp_products(name, description, review_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, description, reviewId ?? null, now, now).lastInsertRowid,
  );
}

export function updateProduct(db: DB, id: number, patch: { name?: unknown; description?: unknown }, now = Date.now()): void {
  const cur = toProduct(productRow(db, id));
  const name = patch.name === undefined ? cur.name : checkName(patch.name);
  const description = patch.description === undefined ? cur.description : checkDesc(patch.description);
  db.prepare('UPDATE cp_products SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(name, description, now, id);
}

export function deleteProduct(db: DB, id: number): void {
  productRow(db, id);
  db.prepare('DELETE FROM cp_products WHERE id = ?').run(id);
}

function itemsOf(db: DB, productId: number): ItemView[] {
  const rows = db.prepare('SELECT * FROM cp_items WHERE product_id = ?').all(productId) as Record<string, unknown>[];
  return rows.map(toItem).sort((a, b) => (ORDER.get(a.item) ?? 99) - (ORDER.get(b.item) ?? 99));
}

export function listProducts(db: DB, now = Date.now()): (ProductView & { required: number; open: number; alerts: number })[] {
  const rows = db.prepare('SELECT * FROM cp_products ORDER BY updated_at DESC, id DESC').all() as Record<string, unknown>[];
  return rows.map((r) => {
    const p = toProduct(r);
    const items = itemsOf(db, p.id);
    return {
      ...p,
      required: items.filter((i) => i.level === 'required').length,
      open: items.filter((i) => i.status !== 'done' && i.status !== 'na').length,
      alerts: items.filter((i) => alertOf(i, now)).length,
    };
  });
}

export function getProduct(db: DB, id: number): { product: ProductView; assessment: AssessmentView | null; items: ItemView[] } {
  const product = toProduct(productRow(db, id));
  const a = db.prepare('SELECT * FROM cp_assessments WHERE product_id = ? ORDER BY id DESC LIMIT 1').get(id) as Record<string, unknown> | undefined;
  const assessment = a
    ? {
        id: Number(a.id), created_at: Number(a.created_at), rules_version: Number(a.rules_version),
        answers: JSON.parse(String(a.answers)) as Answers, prefilled: a.prefilled ? (JSON.parse(String(a.prefilled)) as string[]) : [],
        result: JSON.parse(String(a.result)) as AssessResult,
      }
    : null;
  return { product, assessment, items: itemsOf(db, id) };
}

export function assessAndMerge(db: DB, productId: number, answers: Answers, prefilled: string[], now = Date.now()): { assessmentId: number; result: AssessResult } {
  productRow(db, productId);
  const result = assess(answers);
  return tx(db, () => {
    const assessmentId = Number(
      db.prepare('INSERT INTO cp_assessments(product_id, created_at, rules_version, answers, prefilled, result) VALUES (?, ?, ?, ?, ?, ?)')
        .run(productId, now, RULES_VERSION, JSON.stringify(answers), JSON.stringify(prefilled), JSON.stringify(result)).lastInsertRowid,
    );
    const upsert = db.prepare(
      `INSERT INTO cp_items(product_id, item, level, assessment_id, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(product_id, item) DO UPDATE SET level = excluded.level, assessment_id = excluded.assessment_id, stale = 0, updated_at = excluded.updated_at`,
    );
    const markStale = db.prepare("UPDATE cp_items SET stale = 1, updated_at = ? WHERE product_id = ? AND item = ? AND status != 'na' AND stale = 0");
    for (const it of result.items) {
      if (it.level === 'na') markStale.run(now, productId, it.id);
      else upsert.run(productId, it.id, it.level, assessmentId, now);
    }
    db.prepare('UPDATE cp_products SET updated_at = ? WHERE id = ?').run(now, productId);
    return { assessmentId, result };
  });
}

export interface ItemPatch {
  status?: ItemStatus;
  ref_no?: string | null;
  done_at?: number | null;
  due_at?: number | null;
  remind_at?: number | null;
  note?: string | null;
  na_reason?: string | null;
  keep?: boolean;
}

function textField(v: unknown, max: number, label: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') throw new CpError(400, `${label}格式不对`);
  const s = v.trim();
  if (len(s) > max) throw new CpError(400, `${label}不超过 ${max} 字`);
  return s || null;
}
function dateField(v: unknown, label: string): number | null | undefined {
  if (v === undefined || v === null) return v as null | undefined;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new CpError(400, `${label}格式不对`);
  return v;
}

export function getItem(db: DB, itemId: number): (ItemView & { product_id: number }) | null {
  const r = db.prepare('SELECT * FROM cp_items WHERE id = ?').get(itemId) as Record<string, unknown> | undefined;
  return r ? { ...toItem(r), product_id: Number(r.product_id) } : null;
}

export function updateItem(db: DB, itemId: number, patch: ItemPatch, now = Date.now()): ItemView {
  const cur = getItem(db, itemId);
  if (!cur) throw new CpError(404, '事项不存在');
  if (patch.status !== undefined && !STATUSES.has(patch.status)) throw new CpError(400, '状态不对');
  if (patch.keep !== undefined && typeof patch.keep !== 'boolean') throw new CpError(400, 'keep 格式不对');
  const pick = <T>(v: T | undefined, old: T) => (v === undefined ? old : v);
  const next = {
    status: pick(patch.status, cur.status),
    ref_no: pick(textField(patch.ref_no, REF_MAX, '编号'), cur.ref_no),
    note: pick(textField(patch.note, NOTE_MAX, '备注'), cur.note),
    na_reason: pick(textField(patch.na_reason, NA_REASON_MAX, '不适用原因'), cur.na_reason),
    done_at: pick(dateField(patch.done_at, '办结日期'), cur.done_at),
    due_at: pick(dateField(patch.due_at, '到期日'), cur.due_at),
    remind_at: pick(dateField(patch.remind_at, '提醒日'), cur.remind_at),
    stale: cur.stale,
  };
  if (next.status === 'na' && !next.na_reason) throw new CpError(400, '标为不适用需填写原因');
  if (patch.status === 'done') {
    next.done_at ??= now;
    if (next.due_at === null && next.remind_at === null) Object.assign(next, nextDates(cur.item, next.done_at));
  }
  if (patch.keep === true || next.status === 'na') next.stale = false;
  return tx(db, () => {
    db.prepare(
      `UPDATE cp_items SET status = ?, ref_no = ?, note = ?, na_reason = ?, done_at = ?, due_at = ?, remind_at = ?, stale = ?, updated_at = ? WHERE id = ?`,
    ).run(next.status, next.ref_no, next.note, next.na_reason, next.done_at, next.due_at, next.remind_at, next.stale ? 1 : 0, now, itemId);
    db.prepare('UPDATE cp_products SET updated_at = ? WHERE id = ?').run(now, cur.product_id);
    return getItem(db, itemId)!;
  });
}

export function saveExplain(db: DB, itemId: number, text: string): void {
  const s = [...text.trim()].slice(0, EXPLAIN_MAX).join('');
  db.prepare('UPDATE cp_items SET "explain" = ? WHERE id = ?').run(s || null, itemId);
}
