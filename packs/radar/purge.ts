// 清理情报：删除全部，或删除发布时间落在区间内的条目。
// 保留两类条目并如实报告：已收藏的；已存入知识库的（知识库条目靠它取内容，删了会变成「来源已删除」并清空分块，Wiki 引用随之失效）。
// 被删条目的网址记入 radar_deleted_urls，采集时跳过，否则下一轮又会把仍在信息源里的旧条目采回来。
// 被删条目若是别的条目的「代表条目」，留下的重复条目改指向其中最早的一条，保持分组不丢。
import type { DB } from '../../packages/core/db.ts';

export interface PurgeRange {
  /** 发布时间下限（含），毫秒；都不传表示全部 */
  from?: number;
  /** 发布时间上限（含），毫秒 */
  to?: number;
}

export interface PurgeResult {
  /** 范围内的条目数 */
  matched: number;
  /** 实际删除（dryRun 时为将删除）的条目数 */
  deleted: number;
  keptStarred: number;
  keptInKb: number;
}

const TOMBSTONE_KEEP_MS = 180 * 24 * 3600 * 1000;

/** tombstone=false：不记录已删网址（重新生成时要让这些条目能被再采集回来） */
export function purgeItems(db: DB, range: PurgeRange, o: { dryRun?: boolean; now?: number; tombstone?: boolean } = {}): PurgeResult {
  const now = o.now ?? Date.now();
  const where: string[] = [];
  const args: number[] = [];
  if (range.from != null) (where.push('published_at >= ?'), args.push(range.from));
  if (range.to != null) (where.push('published_at <= ?'), args.push(range.to));
  const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT i.id, i.url, i.starred, EXISTS (SELECT 1 FROM kb_docs d WHERE d.item_id = i.id) AS in_kb FROM items i ${cond.replace(/published_at/g, 'i.published_at')}`)
    .all(...args) as { id: number; url: string; starred: number; in_kb: number }[];
  const del = rows.filter((r) => !r.starred && !r.in_kb);
  const out: PurgeResult = {
    matched: rows.length,
    deleted: del.length,
    keptStarred: rows.filter((r) => r.starred).length,
    keptInKb: rows.filter((r) => !r.starred && r.in_kb).length,
  };
  if (o.dryRun || !del.length) return out;

  const gone = new Set(del.map((r) => r.id));
  db.exec('BEGIN');
  try {
    // 留下的重复条目：改指向其中最早的一条
    const orphans = new Map<number, { id: number; at: number }[]>();
    for (const c of db.prepare('SELECT id, dup_of, published_at FROM items WHERE dup_of IS NOT NULL').all() as { id: number; dup_of: number; published_at: number }[]) {
      if (!gone.has(Number(c.dup_of)) || gone.has(Number(c.id))) continue;
      const l = orphans.get(Number(c.dup_of)) ?? [];
      l.push({ id: Number(c.id), at: Number(c.published_at) });
      orphans.set(Number(c.dup_of), l);
    }
    const setDup = db.prepare('UPDATE items SET dup_of = ? WHERE id = ?');
    for (const kids of orphans.values()) {
      kids.sort((a, b) => a.at - b.at || a.id - b.id);
      setDup.run(null, kids[0].id);
      for (const k of kids.slice(1)) setDup.run(kids[0].id, k.id);
    }
    const tomb = db.prepare('INSERT OR REPLACE INTO radar_deleted_urls(url, at) VALUES (?, ?)');
    const rm = db.prepare('DELETE FROM items WHERE id = ?');
    for (const r of del) {
      if (o.tombstone !== false) tomb.run(r.url, now);
      rm.run(r.id);
    }
    db.prepare('DELETE FROM radar_deleted_urls WHERE at < ?').run(now - TOMBSTONE_KEEP_MS);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return out;
}

export class PurgeInputError extends Error {}

/** 校验请求体：{ all: true } 或 { from, to }（毫秒时间戳，含端点），可带 dryRun */
export function parsePurgeBody(body: Record<string, unknown>): { range: PurgeRange; dryRun: boolean } {
  const ts = (v: unknown): number | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new PurgeInputError('日期不合法');
    return v;
  };
  const from = ts(body.from);
  const to = ts(body.to);
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') throw new PurgeInputError('dryRun 不合法');
  const dryRun = body.dryRun === true;
  if (body.all !== undefined && typeof body.all !== 'boolean') throw new PurgeInputError('all 不合法');
  if (body.all === true) {
    if (from !== undefined || to !== undefined) throw new PurgeInputError('删除全部时不能再指定日期');
    return { range: {}, dryRun };
  }
  if (from === undefined || to === undefined) throw new PurgeInputError('请选择「全部」或指定起止日期');
  if (from > to) throw new PurgeInputError('开始日期不能晚于结束日期');
  return { range: { from, to }, dryRun };
}

/** 重新生成某段时间：必须给起止时间（不允许「全部」），可带 dryRun */
export function parseRegenBody(body: Record<string, unknown>): { range: Required<PurgeRange>; dryRun: boolean } {
  if (body.all !== undefined) throw new PurgeInputError('重新生成只能指定日期范围');
  const p = parsePurgeBody(body);
  return { range: p.range as Required<PurgeRange>, dryRun: p.dryRun };
}
