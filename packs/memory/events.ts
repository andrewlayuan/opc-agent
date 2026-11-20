// 交互事件日志：在操作成功后写入，由记忆整理器消费
import type { DB } from '../../packages/core/db.ts';

export type EventKind =
  | 'item_star'
  | 'item_unstar'
  | 'item_analyze'
  | 'item_translate'
  | 'interests_update'
  | 'brief_generate'
  | 'review_create'
  | 'turn_ask'
  | 'turn_revise'
  | 'version_manual'
  | 'proto_create'
  | 'proto_revise'
  | 'compliance_assess';

/** 产品顾问类事件：每条内容不同，不合并；整理延迟更短 */
export const PM_EVENT_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  'review_create',
  'turn_ask',
  'turn_revise',
  'version_manual',
  'proto_create',
  'proto_revise',
]);

export interface EventInput {
  kind: EventKind;
  refType?: 'item' | 'review' | 'brief' | 'prefs' | 'product';
  refId?: number;
  summary: string;
  payload?: Record<string, unknown>;
}

const MERGE_WINDOW = 10 * 60 * 1000;
const SUMMARY_MAX = 300;
const PAYLOAD_MAX_BYTES = 4096;
const DIFF_MAX = 600;

export const cut = (s: string, n: number): string => {
  const cps = [...s];
  return cps.length > n ? cps.slice(0, n).join('') : s;
};

/** 中和数据里形如 <x> / </x> 的标签片段，防止闭合提示词的外层框架 */
export const fence = (s: string): string => s.replace(/<(\/?[A-Za-z_][\w-]*)[^<>]*>/g, '‹$1›');

function payloadJson(p: Record<string, unknown> | undefined): string {
  const s = JSON.stringify(p ?? {});
  if (Buffer.byteLength(s) <= PAYLOAD_MAX_BYTES) return s;
  let body = [...s];
  let out = '';
  do {
    body = body.slice(0, Math.floor(body.length * 0.8));
    out = JSON.stringify({ _truncated: body.join('') });
  } while (Buffer.byteLength(out) > PAYLOAD_MAX_BYTES);
  return out;
}

/** 写入一条事件；合并或抵消时返回已有 id 或 null */
export function recordEvent(db: DB, e: EventInput, now = Date.now()): number | null {
  const refType = e.refType ?? null;
  const refId = e.refId ?? null;
  const summary = cut(e.summary.replace(/\s+/g, ' ').trim(), SUMMARY_MAX);
  const payload = payloadJson(e.payload);
  if (!PM_EVENT_KINDS.has(e.kind)) {
    const since = now - MERGE_WINDOW;
    const find = (kind: string) =>
      db
        .prepare('SELECT id FROM events WHERE kind = ? AND ref_type IS ? AND ref_id IS ? AND consumed_at IS NULL AND at >= ? ORDER BY id DESC LIMIT 1')
        .get(kind, refType, refId, since) as { id: number } | undefined;
    const opposite = e.kind === 'item_star' ? 'item_unstar' : e.kind === 'item_unstar' ? 'item_star' : null;
    if (opposite) {
      const o = find(opposite);
      if (o) {
        db.prepare('DELETE FROM events WHERE id = ?').run(o.id);
        return null;
      }
    }
    const same = find(e.kind);
    if (same) {
      db.prepare('UPDATE events SET at = ?, summary = ?, payload = ? WHERE id = ?').run(now, summary, payload, same.id);
      return Number(same.id);
    }
  }
  const r = db.prepare('INSERT INTO events(at, kind, ref_type, ref_id, summary, payload) VALUES (?, ?, ?, ?, ?, ?)').run(now, e.kind, refType, refId, summary, payload);
  return Number(r.lastInsertRowid);
}

export function pendingCount(db: DB): number {
  return Number((db.prepare('SELECT count(*) AS n FROM events WHERE consumed_at IS NULL').get() as { n: number }).n);
}

/** 按空行切段后求集合差：删掉了哪些段、补充了哪些段 */
export function paragraphDiff(before: string, after: string): { removed: string; added: string } {
  const paras = (s: string) => s.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const a = paras(before);
  const b = paras(after);
  const sa = new Set(a);
  const sb = new Set(b);
  return {
    removed: cut(a.filter((p) => !sb.has(p)).join('\n\n'), DIFF_MAX),
    added: cut(b.filter((p) => !sa.has(p)).join('\n\n'), DIFF_MAX),
  };
}
