// 台账到期提醒：remind_at 与 due_at 取较早的非空值；30 天内为快到期，已过为逾期
import type { DB } from '../../packages/core/db.ts';
import { CATALOG } from './rules.ts';

export const REMIND_DAYS = 30;
const DAY = 86_400_000;

export interface Reminder {
  itemId: number;
  productId: number;
  productName: string;
  item: string;
  name: string;
  kind: 'soon' | 'overdue';
  date: number;
}

export function alertOf(
  it: { status: string; remind_at: number | null; due_at: number | null },
  now: number,
): { kind: 'soon' | 'overdue'; date: number } | null {
  if (it.status === 'na') return null;
  const dates = [it.remind_at, it.due_at].filter((d): d is number => d !== null && d !== undefined);
  if (!dates.length) return null;
  const date = Math.min(...dates);
  if (date < now) return { kind: 'overdue', date };
  if (date - now <= REMIND_DAYS * DAY) return { kind: 'soon', date };
  return null;
}

const NAME = new Map(CATALOG.map((c) => [c.id, c.name]));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export function listReminders(db: DB, now = Date.now()): Reminder[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.product_id, p.name AS product_name, i.item, i.status, i.remind_at, i.due_at
       FROM cp_items i JOIN cp_products p ON p.id = i.product_id
       WHERE i.status != 'na' AND (i.remind_at IS NOT NULL OR i.due_at IS NOT NULL)`,
    )
    .all() as Record<string, unknown>[];
  const out: Reminder[] = [];
  for (const r of rows) {
    const a = alertOf({ status: String(r.status), remind_at: num(r.remind_at), due_at: num(r.due_at) }, now);
    if (!a) continue;
    const item = String(r.item);
    out.push({ itemId: Number(r.id), productId: Number(r.product_id), productName: String(r.product_name), item, name: NAME.get(item) ?? item, ...a });
  }
  return out.sort((x, y) => (x.kind === y.kind ? x.date - y.date : x.kind === 'overdue' ? -1 : 1));
}
