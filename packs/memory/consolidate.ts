// 记忆整理：把交互事件提炼成长期记忆与画像
import { cut } from './events.ts';
import { hasSensitive } from './sensitive.ts';
import { CONTENT_MAX, PROFILE_MAX, isKind, len } from './store.ts';
import type { MemoryKind } from './store.ts';

export const MAX_OPS = 8;
const REASON_MAX = 120;

export type ValidOp =
  | { op: 'add'; kind: MemoryKind; content: string; reason: string; events: number[] }
  | { op: 'update'; id: number; kind: MemoryKind; content: string; reason: string }
  | { op: 'delete'; id: number; reason: string };

export interface OpsState {
  memories: Map<number, { kind: MemoryKind; content: string; manual: boolean }>;
  profile: string;
  rejected: string[];
  batchIds: number[];
}

const norm = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/** 校验模型输出：非法的单条操作直接丢弃，其余照常应用 */
export function validateOps(out: unknown, state: OpsState): { ops: ValidOp[]; profile: string | null } {
  const o = out && typeof out === 'object' && !Array.isArray(out) ? (out as Record<string, unknown>) : {};
  const rawOps = Array.isArray(o.ops) ? o.ops : [];
  const rejected = new Set(state.rejected.map(norm));
  const contents = new Set([...state.memories.values()].map((m) => m.content));
  const batch = new Set(state.batchIds);
  const seenIds = new Set<number>();
  const ops: ValidOp[] = [];
  const okContent = (c: string) => len(c) >= 1 && len(c) <= CONTENT_MAX && !hasSensitive(c) && !rejected.has(c);

  for (const raw of rawOps) {
    if (ops.length >= MAX_OPS) break;
    if (!raw || typeof raw !== 'object') continue;
    const x = raw as Record<string, unknown>;
    const reason = cut(norm(x.reason), REASON_MAX);
    if (x.op === 'add') {
      const content = norm(x.content);
      if (!isKind(x.kind) || !okContent(content) || contents.has(content)) continue;
      const evs = Array.isArray(x.events) ? x.events.filter((e): e is number => typeof e === 'number' && batch.has(e)) : [];
      contents.add(content);
      ops.push({ op: 'add', kind: x.kind, content, reason, events: evs.length ? [...new Set(evs)] : [...state.batchIds] });
      continue;
    }
    if (x.op !== 'update' && x.op !== 'delete') continue;
    const id = x.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || seenIds.has(id)) continue;
    const cur = state.memories.get(id);
    if (!cur) continue;
    if (x.op === 'delete') {
      if (cur.manual) continue;
      seenIds.add(id);
      ops.push({ op: 'delete', id, reason });
      continue;
    }
    if (x.kind !== undefined && !isKind(x.kind)) continue;
    const kind = (x.kind as MemoryKind | undefined) ?? cur.kind;
    const content = norm(x.content);
    if (!okContent(content) || (content === cur.content && kind === cur.kind)) continue;
    seenIds.add(id);
    ops.push({ op: 'update', id, kind, content, reason });
  }

  let profile: string | null = null;
  if (typeof o.profile === 'string') {
    const p = cut(o.profile.trim(), PROFILE_MAX);
    if (p && p !== state.profile.trim() && !hasSensitive(p)) profile = p;
  }
  return { ops, profile };
}
