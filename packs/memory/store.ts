// 记忆条目、画像与变更记录：手动修改、淘汰、撤销、清空、导出
import type { DB } from '../../packages/core/db.ts';
import { hasSensitive } from './sensitive.ts';

export const MEMORY_KINDS = ['fact', 'preference', 'decision', 'interest'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const KIND_LABELS: Record<MemoryKind, string> = { fact: '事实', preference: '偏好', decision: '决定', interest: '关注' };
export const MAX_MEMORIES = 60;
export const CONTENT_MAX = 200;
export const PROFILE_MAX = 1500;
export const UNDO_DAYS = 30;
const UNDO_MS = UNDO_DAYS * 86_400_000;

export const SENSITIVE_MSG = '看起来包含敏感信息（如 Key、手机号），没有保存';

export class MemoryError extends Error {
  status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Memory {
  id: number;
  kind: MemoryKind;
  content: string;
  manual: boolean;
  created_at: number;
  updated_at: number;
  hits: number;
  last_used_at: number | null;
}

export interface Profile {
  content: string;
  updated_at: number;
  manual: boolean;
}

type Row = Record<string, unknown>;
type ChangeOp = 'add' | 'update' | 'delete' | 'profile';
type ChangeSource = 'auto' | 'manual' | 'undo' | 'evict';

export const isKind = (v: unknown): v is MemoryKind => typeof v === 'string' && (MEMORY_KINDS as readonly string[]).includes(v);
export const len = (s: string): number => [...s].length;

export function tx<T>(db: DB, fn: () => T): T {
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

function toMemory(r: Row): Memory {
  return {
    id: Number(r.id),
    kind: String(r.kind) as MemoryKind,
    content: String(r.content),
    manual: Boolean(r.manual),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
    hits: Number(r.hits),
    last_used_at: r.last_used_at == null ? null : Number(r.last_used_at),
  };
}

export function listMemories(db: DB): Memory[] {
  return (db.prepare('SELECT * FROM memories ORDER BY kind, updated_at DESC, id DESC').all() as Row[]).map(toMemory);
}

function getMemory(db: DB, id: number): Memory | null {
  const r = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Row | undefined;
  return r ? toMemory(r) : null;
}

export function getProfile(db: DB): Profile {
  const r = db.prepare('SELECT content, updated_at, manual FROM profile WHERE id = 1').get() as Row | undefined;
  return { content: String(r?.content ?? ''), updated_at: Number(r?.updated_at ?? 0), manual: Boolean(r?.manual) };
}

const snap = (m: { kind: string; content: string; manual: boolean }) => ({ kind: m.kind, content: m.content, manual: m.manual });

/** 写一条变更记录（不开事务，由调用方负责） */
export function logChange(
  db: DB,
  c: { op: ChangeOp; memoryId?: number | null; kind?: string | null; before?: object | null; after?: object | null; reason?: string | null; source: ChangeSource; eventIds?: number[] },
  now: number,
): number {
  const r = db
    .prepare('INSERT INTO memory_changes(at, op, memory_id, kind, before, after, reason, source, event_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      now,
      c.op,
      c.memoryId ?? null,
      c.kind ?? null,
      c.before ? JSON.stringify(c.before) : null,
      c.after ? JSON.stringify(c.after) : null,
      c.reason ?? null,
      c.source,
      JSON.stringify(c.eventIds ?? []),
    );
  return Number(r.lastInsertRowid);
}

/** 超出上限时淘汰：自动条目优先，其次最近没用过的、命中少的、早的（不开事务） */
export function evictOverflow(db: DB, now: number): number {
  const total = Number((db.prepare('SELECT count(*) AS n FROM memories').get() as { n: number }).n);
  const over = total - MAX_MEMORIES;
  if (over <= 0) return 0;
  const victims = (
    db.prepare('SELECT * FROM memories ORDER BY manual ASC, coalesce(last_used_at, updated_at) ASC, hits ASC, id ASC LIMIT ?').all(over) as Row[]
  ).map(toMemory);
  for (const m of victims) {
    db.prepare('DELETE FROM memories WHERE id = ?').run(m.id);
    logChange(db, { op: 'delete', memoryId: m.id, kind: m.kind, before: snap(m), reason: `超过 ${MAX_MEMORIES} 条上限`, source: 'evict' }, now);
  }
  return victims.length;
}

function cleanContent(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  const n = len(s);
  if (n < 1 || n > CONTENT_MAX) throw new MemoryError(400, `内容需在 1–${CONTENT_MAX} 字之间`);
  if (hasSensitive(s)) throw new MemoryError(400, SENSITIVE_MSG);
  return s;
}

function checkKind(v: unknown): MemoryKind {
  if (!isKind(v)) throw new MemoryError(400, '记忆类型不合法');
  return v;
}

const FULL_MSG = `记忆已满 ${MAX_MEMORIES} 条，请先删除不需要的`;

/** 已满且全是手动条目：再加一条只能淘汰手动条目，因此拒绝 */
function isFull(db: DB): boolean {
  const r = db.prepare('SELECT count(*) AS n, sum(manual = 0) AS auto FROM memories').get() as { n: number; auto: number | null };
  return Number(r.n) >= MAX_MEMORIES && !Number(r.auto ?? 0);
}

export function addMemory(db: DB, kind: unknown, content: unknown, now = Date.now()): number {
  const k = checkKind(kind);
  const c = cleanContent(content);
  return tx(db, () => {
    if (isFull(db)) throw new MemoryError(409, FULL_MSG);
    const id = Number(db.prepare('INSERT INTO memories(kind, content, manual, created_at, updated_at) VALUES (?, ?, 1, ?, ?)').run(k, c, now, now).lastInsertRowid);
    logChange(db, { op: 'add', memoryId: id, kind: k, after: { kind: k, content: c, manual: true }, source: 'manual' }, now);
    evictOverflow(db, now);
    return id;
  });
}

export function updateMemory(db: DB, id: number, input: { kind?: unknown; content: unknown }, now = Date.now()): void {
  const c = cleanContent(input.content);
  const kIn = input.kind === undefined ? undefined : checkKind(input.kind);
  tx(db, () => {
    const m = getMemory(db, id);
    if (!m) throw new MemoryError(404, '记忆不存在');
    const k = kIn ?? m.kind;
    db.prepare('UPDATE memories SET kind = ?, content = ?, manual = 1, updated_at = ? WHERE id = ?').run(k, c, now, id);
    logChange(db, { op: 'update', memoryId: id, kind: k, before: snap(m), after: { kind: k, content: c, manual: true }, source: 'manual' }, now);
  });
}

export function deleteMemory(db: DB, id: number, now = Date.now()): void {
  tx(db, () => {
    const m = getMemory(db, id);
    if (!m) throw new MemoryError(404, '记忆不存在');
    db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    logChange(db, { op: 'delete', memoryId: id, kind: m.kind, before: snap(m), source: 'manual' }, now);
  });
}

export function setProfile(db: DB, content: unknown, now = Date.now()): void {
  if (typeof content !== 'string') throw new MemoryError(400, '画像内容不合法');
  const c = content.trim();
  if (len(c) > PROFILE_MAX) throw new MemoryError(400, `画像最多 ${PROFILE_MAX} 字`);
  if (hasSensitive(c)) throw new MemoryError(400, SENSITIVE_MSG);
  tx(db, () => {
    const p = getProfile(db);
    db.prepare('UPDATE profile SET content = ?, manual = 1, updated_at = ? WHERE id = 1').run(c, now);
    logChange(db, { op: 'profile', before: { content: p.content, manual: p.manual }, after: { content: c, manual: true }, source: 'manual' }, now);
  });
}

interface ChangeRow {
  id: number;
  at: number;
  op: ChangeOp;
  memory_id: number | null;
  kind: string | null;
  before: string | null;
  after: string | null;
  reason: string | null;
  source: ChangeSource;
  event_ids: string;
  undone_at: number | null;
}

function parseObj(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 返回不能撤销的原因；可以撤销时返回 null */
function undoBlocker(db: DB, c: ChangeRow, now: number): string | null {
  if (c.source === 'undo') return '这条记录不能撤销';
  if (c.undone_at != null) return '已撤销';
  if (now - c.at > UNDO_MS) return `超过 ${UNDO_DAYS} 天，无法撤销`;
  const later =
    c.op === 'profile'
      ? db.prepare("SELECT 1 FROM memory_changes WHERE id > ? AND op = 'profile' AND undone_at IS NULL AND source != 'undo' LIMIT 1").get(c.id)
      : db.prepare("SELECT 1 FROM memory_changes WHERE id > ? AND memory_id = ? AND op != 'profile' AND undone_at IS NULL AND source != 'undo' LIMIT 1").get(c.id, c.memory_id);
  return later ? '已被后续修改，请直接编辑' : null;
}

const CONFLICT = '已被后续修改，请直接编辑';

export function undoChange(db: DB, id: number, now = Date.now()): void {
  tx(db, () => {
    const c = db.prepare('SELECT * FROM memory_changes WHERE id = ?').get(id) as ChangeRow | undefined;
    if (!c) throw new MemoryError(404, '变更不存在');
    const why = undoBlocker(db, c, now);
    if (why) throw new MemoryError(409, why);
    const before = parseObj(c.before);
    const after = parseObj(c.after);
    if (c.op === 'profile') {
      db.prepare('UPDATE profile SET content = ?, manual = ?, updated_at = ? WHERE id = 1').run(String(before?.content ?? ''), before?.manual ? 1 : 0, now);
    } else {
      const mid = Number(c.memory_id);
      const exists = Boolean(getMemory(db, mid));
      if (c.op === 'add') {
        if (!exists) throw new MemoryError(409, CONFLICT);
        db.prepare('DELETE FROM memories WHERE id = ?').run(mid);
      } else if (c.op === 'update') {
        if (!exists || !before || !isKind(before.kind)) throw new MemoryError(409, CONFLICT);
        db.prepare('UPDATE memories SET kind = ?, content = ?, manual = ?, updated_at = ? WHERE id = ?').run(before.kind, String(before.content), before.manual ? 1 : 0, now, mid);
      } else {
        if (exists || !before || !isKind(before.kind)) throw new MemoryError(409, CONFLICT);
        if (isFull(db)) throw new MemoryError(409, FULL_MSG);
        db.prepare('INSERT INTO memories(id, kind, content, manual, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(mid, before.kind, String(before.content), before.manual ? 1 : 0, now, now);
      }
    }
    logChange(db, { op: c.op, memoryId: c.memory_id, kind: c.kind, before: after, after: before, reason: `撤销 #${c.id}`, source: 'undo' }, now);
    db.prepare('UPDATE memory_changes SET undone_at = ? WHERE id = ?').run(now, c.id);
    if (c.op === 'delete') evictOverflow(db, now);
  });
}

export function clearMemory(db: DB, confirm: unknown, now = Date.now()): void {
  if (confirm !== '清空') throw new MemoryError(400, '请输入「清空」确认');
  tx(db, () => {
    db.exec('DELETE FROM memories; DELETE FROM memory_changes; DELETE FROM events;');
    db.prepare("UPDATE profile SET content = '', manual = 0, updated_at = ? WHERE id = 1").run(now);
  });
}

export interface ChangeView {
  id: number;
  at: number;
  op: ChangeOp;
  memory_id: number | null;
  kind: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  source: ChangeSource;
  events: string[];
  undone_at: number | null;
  undoable: boolean;
}

export function recentChanges(db: DB, limit = 50, now = Date.now()): ChangeView[] {
  const rows = db.prepare('SELECT * FROM memory_changes ORDER BY id DESC LIMIT ?').all(Math.min(500, Math.max(1, limit))) as unknown as ChangeRow[];
  const ev = db.prepare('SELECT summary FROM events WHERE id = ?');
  return rows.map((c) => {
    let ids: number[] = [];
    try {
      ids = (JSON.parse(c.event_ids) as unknown[]).filter((x): x is number => Number.isSafeInteger(x));
    } catch {
      ids = [];
    }
    const events = ids
      .slice(0, 5)
      .map((i) => (ev.get(i) as { summary: string } | undefined)?.summary)
      .filter((s): s is string => Boolean(s));
    return {
      id: Number(c.id),
      at: Number(c.at),
      op: c.op,
      memory_id: c.memory_id == null ? null : Number(c.memory_id),
      kind: c.kind,
      before: parseObj(c.before),
      after: parseObj(c.after),
      reason: c.reason,
      source: c.source,
      events,
      undone_at: c.undone_at == null ? null : Number(c.undone_at),
      undoable: undoBlocker(db, c, now) === null,
    };
  });
}

export function exportMemory(db: DB, now = Date.now()): { exported_at: number; profile: Profile; memories: Memory[]; changes: ChangeView[] } {
  return { exported_at: now, profile: getProfile(db), memories: listMemories(db), changes: recentChanges(db, 500, now) };
}

/** 给 MCP 的只读视图：画像 + 按类分组的记忆，按码点截到 maxChars；无数据（含旧库缺表）返回「暂无记忆」 */
export function profileMarkdown(db: DB, maxChars = 6000): string {
  let profile = '';
  let mems: Memory[] = [];
  try {
    profile = getProfile(db).content.trim();
    mems = listMemories(db);
  } catch {
    return '暂无记忆';
  }
  if (!profile && !mems.length) return '暂无记忆';
  const parts: string[] = [];
  if (profile) parts.push(`## 画像\n${profile}`);
  for (const k of MEMORY_KINDS) {
    const ms = mems.filter((m) => m.kind === k);
    if (ms.length) parts.push(`## ${KIND_LABELS[k]}\n${ms.map((m) => `- ${m.content.replace(/\s+/g, ' ')}`).join('\n')}`);
  }
  const text = parts.join('\n\n');
  const cps = [...text];
  return cps.length <= maxChars ? text : cps.slice(0, maxChars - 1).join('') + '…';
}
