/** pm_prototypes 的读写。状态更新一律带 status = 'running'，返回是否命中（评审被删或已结束时返回 false） */
import type { DB } from '../../packages/core/db.ts';
import { PROTO_LIMITS, ProtoError, RESTART_MSG, type Outline, type Progress, type ProtoMeta, type ProtoPage, type ProtoRow } from './types.ts';

interface RawRow extends Omit<ProtoRow, 'progress' | 'outline' | 'pages'> {
  progress: string;
  outline: string;
  pages: string;
}

const QUEUED = JSON.stringify({ stage: 'queued', done: 0, total: 0 } satisfies Progress);

function decode(r: RawRow): ProtoRow {
  return { ...r, progress: JSON.parse(r.progress) as Progress, outline: JSON.parse(r.outline) as Outline | null, pages: JSON.parse(r.pages) as ProtoPage[] };
}

export function toMeta(r: ProtoRow): ProtoMeta {
  const { outline, pages, ...rest } = r;
  return {
    ...rest,
    product: outline?.product ?? null,
    device: outline?.device ?? null,
    pages: pages.map((p) => ({ slug: p.slug, title: p.title, error: p.error })),
  };
}

const hasRunning = (db: DB, reviewId: number) =>
  db.prepare("SELECT 1 FROM pm_prototypes WHERE review_id = ? AND status = 'running' LIMIT 1").get(reviewId) != null;

function byId(db: DB, id: number): ProtoRow {
  return decode(db.prepare('SELECT * FROM pm_prototypes WHERE id = ?').get(id) as unknown as RawRow);
}

export function getVersion(db: DB, reviewId: number, n: number): ProtoRow | null {
  const r = db.prepare('SELECT * FROM pm_prototypes WHERE review_id = ? AND n = ?').get(reviewId, n) as unknown as RawRow | undefined;
  return r ? decode(r) : null;
}

export function listVersions(db: DB, reviewId: number): ProtoMeta[] {
  return (db.prepare('SELECT * FROM pm_prototypes WHERE review_id = ? ORDER BY n').all(reviewId) as unknown as RawRow[]).map((r) => toMeta(decode(r)));
}

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

/**
 * 新建一个 running 版本。n 取现有最大 n + 1：裁剪从不删除最新一版，所以版本号不会复用。
 * 超出版本上限时删掉 n > 1 中最小的非 running 版本（v1 永久保留）
 */
export function createVersion(db: DB, reviewId: number, v: { baseVersionN: number; fromN: number | null; request: string }): ProtoRow {
  return tx(db, () => {
    if (hasRunning(db, reviewId)) throw new ProtoError(409, '原型正在生成');
    const max = (db.prepare('SELECT max(n) AS m FROM pm_prototypes WHERE review_id = ?').get(reviewId) as { m: number | null }).m ?? 0;
    const id = Number(
      db
        .prepare('INSERT INTO pm_prototypes(review_id, n, created_at, base_version_n, from_n, request) VALUES (?, ?, ?, ?, ?, ?)')
        .run(reviewId, max + 1, Date.now(), v.baseVersionN, v.fromN, v.request).lastInsertRowid,
    );
    const count = () => (db.prepare('SELECT count(*) AS c FROM pm_prototypes WHERE review_id = ?').get(reviewId) as { c: number }).c;
    const drop = db.prepare(
      "DELETE FROM pm_prototypes WHERE id = (SELECT id FROM pm_prototypes WHERE review_id = ? AND n > 1 AND status != 'running' ORDER BY n LIMIT 1)",
    );
    while (count() > PROTO_LIMITS.versionsMax && Number(drop.run(reviewId).changes) > 0);
    return byId(db, id);
  });
}

const hit = (r: { changes: number | bigint }) => Number(r.changes) > 0;

export function setProgress(db: DB, id: number, p: Progress): boolean {
  return hit(db.prepare("UPDATE pm_prototypes SET progress = ? WHERE id = ? AND status = 'running'").run(JSON.stringify(p), id));
}

export function saveOutline(db: DB, id: number, o: Outline): boolean {
  return hit(db.prepare("UPDATE pm_prototypes SET outline = ? WHERE id = ? AND status = 'running'").run(JSON.stringify(o), id));
}

export function savePages(db: DB, id: number, pages: ProtoPage[]): boolean {
  return hit(db.prepare("UPDATE pm_prototypes SET pages = ? WHERE id = ? AND status = 'running'").run(JSON.stringify(pages), id));
}

export function finish(db: DB, id: number, r: { status: 'done' | 'error'; note?: string; error?: string | null }): boolean {
  return hit(
    db
      .prepare("UPDATE pm_prototypes SET status = ?, note = coalesce(?, note), error = ?, finished_at = ? WHERE id = ? AND status = 'running'")
      .run(r.status, r.note ?? null, r.error ?? null, Date.now(), id),
  );
}

/** 失败版本在原版本号上重新跑：状态改回 running，清空 error 与进度 */
export function restart(db: DB, reviewId: number, n: number): ProtoRow {
  return tx(db, () => {
    const row = getVersion(db, reviewId, n);
    if (!row) throw new ProtoError(404, '原型版本不存在');
    if (row.status !== 'error') throw new ProtoError(409, '只能重试失败的版本');
    if (hasRunning(db, reviewId)) throw new ProtoError(409, '原型正在生成');
    db.prepare("UPDATE pm_prototypes SET status = 'running', error = NULL, finished_at = NULL, progress = ? WHERE id = ? AND status = 'error'").run(QUEUED, row.id);
    return byId(db, row.id);
  });
}

/** 服务启动时调用：上次进程留下的 running 一律记为中断 */
export function recover(db: DB): number {
  return Number(db.prepare("UPDATE pm_prototypes SET status = 'error', error = ?, finished_at = ? WHERE status = 'running'").run(RESTART_MSG, Date.now()).changes);
}
