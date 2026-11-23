// 技能：校验、增删改、状态、版本与回退；画像版本与写入（设计第 4、5、6 节）
import type { DB } from '../../packages/core/db.ts';
import { len, tx } from './store.ts';
import { MemoryError } from './store.ts';

export const SKILL_LIMITS = {
  max: 40,
  revMax: 20,
  nameMin: 8,
  nameMax: 40,
  sceneMin: 20,
  sceneMax: 200,
  stepsMin: 2,
  stepsMax: 8,
  stepMax: 200,
  cautionsMax: 5,
  cautionMax: 120,
  exampleMax: 600,
} as const;

export const SKILL_STATUS = ['candidate', 'active', 'retired'] as const;
export type SkillStatus = (typeof SKILL_STATUS)[number];
export type SkillOrigin = 'auto' | 'manual' | 'restore';

export const STATUS_LABELS: Record<SkillStatus, string> = { candidate: '候选', active: '启用', retired: '停用' };

export interface SkillInput {
  name: string;
  scene: string;
  steps: string[];
  cautions: string[];
  example: string;
}

export interface Skill extends SkillInput {
  id: number;
  source: 'auto' | 'manual';
  status: SkillStatus;
  manual: boolean;
  /** 手改过的技能遇到沉淀出的新版本时暂存于此，由用户决定采用或忽略 */
  pending: SkillInput | null;
  uses: number;
  hits: number;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
  /** 当前版本号（单调递增，截断旧版本后也不回退） */
  rev: number;
  /** 仍保存着的版本数（最多 20） */
  revisions: number;
}

export interface SkillRevision {
  rev: number;
  origin: SkillOrigin;
  reason: string;
  created_at: number;
  skill: SkillInput;
}

type Row = Record<string, unknown>;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strOf = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const between = (label: string, s: string, min: number, max: number): string => {
  const n = len(s);
  if (n < min || n > max) throw new MemoryError(400, `${label}需在 ${min}–${max} 字之间`);
  return s;
};

function list(v: unknown, label: string, min: number, max: number, eachMax: number): string[] {
  const arr = Array.isArray(v) ? v.map(strOf).filter(Boolean) : [];
  if (arr.length < min || arr.length > max) throw new MemoryError(400, `${label}需在 ${min}–${max} 条之间`);
  for (const x of arr) if (len(x) > eachMax) throw new MemoryError(400, `${label}需在 ${min}–${max} 条之间`);
  return arr;
}

/** 字段校验：长度与条数不合法时抛 400，文案固定 */
export function validateSkill(input: unknown): SkillInput {
  const o = isObj(input) ? input : {};
  const name = between('技能名', strOf(o.name), SKILL_LIMITS.nameMin, SKILL_LIMITS.nameMax);
  const scene = between('何时用', strOf(o.scene), SKILL_LIMITS.sceneMin, SKILL_LIMITS.sceneMax);
  const steps = list(o.steps, '步骤', SKILL_LIMITS.stepsMin, SKILL_LIMITS.stepsMax, SKILL_LIMITS.stepMax);
  const cautionsRaw = Array.isArray(o.cautions) ? o.cautions.map(strOf).filter(Boolean) : [];
  if (cautionsRaw.length > SKILL_LIMITS.cautionsMax) throw new MemoryError(400, '注意最多 5 条');
  const cautions = list(cautionsRaw, '注意', 0, SKILL_LIMITS.cautionsMax, SKILL_LIMITS.cautionMax);
  const example = strOf(o.example);
  if (len(example) > SKILL_LIMITS.exampleMax) throw new MemoryError(400, '示例需在 0–600 字之间');
  return { name, scene, steps, cautions, example };
}

const toSkill = (r: Row, rev: number, revisions: number): Skill => ({
  id: Number(r.id),
  name: String(r.name),
  scene: String(r.scene),
  steps: JSON.parse(String(r.steps)) as string[],
  cautions: JSON.parse(String(r.cautions)) as string[],
  example: String(r.example),
  source: String(r.source) === 'auto' ? 'auto' : 'manual',
  status: (SKILL_STATUS as readonly string[]).includes(String(r.status)) ? (String(r.status) as SkillStatus) : 'candidate',
  manual: Number(r.manual) === 1,
  pending: r.pending == null ? null : (JSON.parse(String(r.pending)) as SkillInput),
  uses: Number(r.uses),
  hits: Number(r.hits),
  last_used_at: r.last_used_at == null ? null : Number(r.last_used_at),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at),
  rev,
  revisions,
});

function revInfo(db: DB, id: number): { rev: number; count: number } {
  const r = db.prepare('SELECT COALESCE(MAX(rev), 0) AS rev, COUNT(*) AS n FROM skill_revisions WHERE skill_id = ?').get(id) as { rev: number; n: number };
  return { rev: Number(r.rev), count: Number(r.n) };
}

function skillRow(db: DB, id: number): Row {
  const r = db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new MemoryError(404, '技能不存在');
  return r;
}

export function getSkill(db: DB, id: number): Skill {
  const { rev, count } = revInfo(db, id);
  return toSkill(skillRow(db, id), rev, count);
}

export function listSkills(db: DB, o: { status?: SkillStatus } = {}): Skill[] {
  const rows = (
    o.status
      ? db.prepare('SELECT * FROM skills WHERE status = ? ORDER BY updated_at DESC, id DESC').all(o.status)
      : db.prepare('SELECT * FROM skills ORDER BY updated_at DESC, id DESC').all()
  ) as Row[];
  if (!rows.length) return [];
  const info = new Map<number, { rev: number; n: number }>();
  for (const c of db.prepare('SELECT skill_id, MAX(rev) AS rev, COUNT(*) AS n FROM skill_revisions GROUP BY skill_id').all() as { skill_id: number; rev: number; n: number }[]) {
    info.set(Number(c.skill_id), { rev: Number(c.rev), n: Number(c.n) });
  }
  return rows.map((r) => {
    const x = info.get(Number(r.id));
    return toSkill(r, x?.rev ?? 0, x?.n ?? 0);
  });
}

/** 写一条版本快照；顺带按 20 截断 */
function writeSkillRev(db: DB, id: number, skill: SkillInput, rev: number, origin: SkillOrigin, reason: string, now: number): void {
  db.prepare('INSERT INTO skill_revisions(skill_id, rev, content, origin, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    rev,
    JSON.stringify(skill),
    origin,
    reason.slice(0, 200),
    now,
  );
  db.prepare('DELETE FROM skill_revisions WHERE skill_id = ? AND rev <= ?').run(id, rev - SKILL_LIMITS.revMax);
}

/** 新建技能，返回 id（与 addMemory 一致） */
export function createSkill(db: DB, input: unknown, o: { source: 'auto' | 'manual'; status?: SkillStatus; now?: number }): number {
  const s = validateSkill(input);
  const now = o.now ?? Date.now();
  const id = tx(db, () => {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM skills').get() as { n: number }).n;
    if (Number(n) >= SKILL_LIMITS.max) throw new MemoryError(409, '技能最多 40 条');
    const status = o.status ?? 'candidate';
    const r = db.prepare(
      "INSERT INTO skills(name, scene, steps, cautions, example, source, status, manual, uses, hits, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)",
    ).run(s.name, s.scene, JSON.stringify(s.steps), JSON.stringify(s.cautions), s.example, o.source, status, o.source === 'manual' ? 1 : 0, now, now);
    const newId = Number(r.lastInsertRowid);
    writeSkillRev(db, newId, s, 1, o.source, o.source === 'auto' ? '自动沉淀' : '手工新建', now);
    return newId;
  });
  return id;
}

/** 编辑：写新版本；origin 为 manual 时置 manual=1，自动流程不再覆盖 */
export function updateSkill(db: DB, id: number, input: unknown, o: { origin: SkillOrigin; reason?: string; now?: number }): Skill {
  const s = validateSkill(input);
  const now = o.now ?? Date.now();
  tx(db, () => {
    const r = skillRow(db, id);
    const rev = revInfo(db, id).rev + 1;
    db.prepare('UPDATE skills SET name = ?, scene = ?, steps = ?, cautions = ?, example = ?, manual = ?, updated_at = ? WHERE id = ?').run(
      s.name,
      s.scene,
      JSON.stringify(s.steps),
      JSON.stringify(s.cautions),
      s.example,
      o.origin === 'manual' || Number(r.manual) === 1 ? 1 : 0,
      now,
      id,
    );
    writeSkillRev(db, id, s, rev, o.origin, o.reason ?? (o.origin === 'manual' ? '手工修改' : '自动沉淀'), now);
  });
  return getSkill(db, id);
}

export function setSkillStatus(db: DB, id: number, status: unknown, now = Date.now()): Skill {
  if (typeof status !== 'string' || !(SKILL_STATUS as readonly string[]).includes(status)) throw new MemoryError(400, '技能状态不对');
  skillRow(db, id);
  db.prepare('UPDATE skills SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
  return getSkill(db, id);
}

/** 暂存或清除待采用的新版本 */
export function setPending(db: DB, id: number, skill: SkillInput | null, now = Date.now()): void {
  skillRow(db, id);
  db.prepare('UPDATE skills SET pending = ?, updated_at = ? WHERE id = ?').run(skill ? JSON.stringify(skill) : null, now, id);
}

/** 采用暂存的新版本：写新版本（origin=auto），清空 pending；没有暂存时 409 */
export function acceptPending(db: DB, id: number, now = Date.now()): Skill {
  const r = skillRow(db, id);
  if (r.pending == null) throw new MemoryError(409, '没有待采用的新版本');
  const s = updateSkill(db, id, JSON.parse(String(r.pending)), { origin: 'auto', reason: '采用沉淀出的新版本', now });
  db.prepare('UPDATE skills SET pending = NULL WHERE id = ?').run(id);
  return { ...s, pending: null };
}

/** 召回计数：同一轮只调用一次 */
export function touchSkill(db: DB, id: number, hit: boolean, now = Date.now()): void {
  db.prepare('UPDATE skills SET uses = uses + 1, hits = hits + ?, last_used_at = ? WHERE id = ?').run(hit ? 1 : 0, now, id);
}

export function deleteSkill(db: DB, id: number): void {
  skillRow(db, id);
  db.prepare('DELETE FROM skills WHERE id = ?').run(id);
}

export function listSkillRevisions(db: DB, id: number): SkillRevision[] {
  skillRow(db, id);
  return (db.prepare('SELECT * FROM skill_revisions WHERE skill_id = ? ORDER BY rev DESC').all(id) as Row[]).map((r) => ({
    rev: Number(r.rev),
    origin: String(r.origin) as SkillOrigin,
    reason: String(r.reason),
    created_at: Number(r.created_at),
    skill: JSON.parse(String(r.content)) as SkillInput,
  }));
}

export function restoreSkill(db: DB, id: number, rev: unknown, now = Date.now()): Skill {
  const n = typeof rev === 'number' && Number.isSafeInteger(rev) && rev > 0 ? rev : NaN;
  if (!Number.isSafeInteger(n)) throw new MemoryError(400, '版本号不对');
  skillRow(db, id);
  const r = db.prepare('SELECT content FROM skill_revisions WHERE skill_id = ? AND rev = ?').get(id, n) as { content: string } | undefined;
  if (!r) throw new MemoryError(404, '版本不存在');
  return updateSkill(db, id, JSON.parse(r.content), { origin: 'restore', reason: `回退到 v${n}`, now });
}
