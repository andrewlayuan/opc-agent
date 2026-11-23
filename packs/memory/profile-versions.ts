// 画像版本：快照、截断、列表与回退。store.ts 与 skills.ts 共用，避免循环依赖
import type { DB } from '../../packages/core/db.ts';
import { PROFILE_MAX, PROFILE_REV_MAX, getProfile, logChange, tx } from './store.ts';
import { MemoryError } from './store.ts';

export type ProfileOrigin = 'auto' | 'manual' | 'restore';

export interface ProfileVersion {
  rev: number;
  content: string;
  origin: ProfileOrigin;
  reason: string;
  event_ids: number[];
  created_at: number;
}

type Row = Record<string, unknown>;

/** 按码点截到 PROFILE_MAX，与 setProfile 的长度校验一致，不切开代理对 */
const clip = (s: string): string => (s.length <= PROFILE_MAX ? s : Array.from(s).slice(0, PROFILE_MAX).join(''));

/** 记一条快照（版本表保存每次写入后的状态，最新一条即当前内容）；与最新一版相同则跳过，超出 50 条删最旧的 */
export function pushProfileVersion(db: DB, content: string, origin: ProfileOrigin, reason: string, eventIds: number[], now: number): void {
  const text = content.trim();
  if (!text) return;
  const last = db.prepare('SELECT content FROM profile_versions ORDER BY rev DESC LIMIT 1').get() as { content: string } | undefined;
  if (last && last.content.trim() === text) return;
  db.prepare('INSERT INTO profile_versions(content, origin, reason, event_ids, created_at) VALUES (?, ?, ?, ?, ?)').run(
    text,
    origin,
    reason.slice(0, 200),
    JSON.stringify(eventIds.slice(0, 100)),
    now,
  );
  db.prepare('DELETE FROM profile_versions WHERE rev <= (SELECT MAX(rev) FROM profile_versions) - ?').run(PROFILE_REV_MAX);
}

/** 升级前已有的画像没有版本：第一次写入前补一条，保证能回退到升级前的内容 */
export function seedProfileVersion(db: DB, current: string, now: number): void {
  if (!current.trim()) return;
  if (db.prepare('SELECT 1 FROM profile_versions LIMIT 1').get()) return;
  pushProfileVersion(db, current, 'auto', '升级前的画像', [], now);
}

export function listProfileVersions(db: DB): ProfileVersion[] {
  return (db.prepare('SELECT * FROM profile_versions ORDER BY rev DESC').all() as Row[]).map((r) => ({
    rev: Number(r.rev),
    content: String(r.content),
    origin: String(r.origin) as ProfileOrigin,
    reason: String(r.reason),
    event_ids: JSON.parse(String(r.event_ids)) as number[],
    created_at: Number(r.created_at),
  }));
}

/** 自动更新的门槛：去掉空白后差异不足 40 字视为没有实质变化 */
export const PROFILE_MIN_DELTA = 40;

/** 去掉空白后，按公共前缀与公共后缀估算改动的字数（线性时间，足够判断「是否有实质变化」） */
export function profileDelta(a: string, b: string): number {
  const x = [...a.replace(/\s+/g, '')];
  const y = [...b.replace(/\s+/g, '')];
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  return Math.max(x.length, y.length) - pre - suf;
}

type WriteOpts = { origin: ProfileOrigin; reason?: string; eventIds?: number[]; manual?: boolean; now?: number };

/** 统一写入：内容与当前相同不写；写入后的内容入版本表；同时记 memory_changes。自动整理与手工保存都走这里 */
export function writeProfile(db: DB, content: unknown, o: WriteOpts): { content: string; written: boolean } {
  return tx(db, () => applyProfile(db, content, o));
}

/** 同 writeProfile，但不开事务：给已经在事务里的调用方（整理落库）用 */
export function applyProfile(db: DB, content: unknown, o: WriteOpts): { content: string; written: boolean } {
  const text = typeof content === 'string' ? clip(content.trim()) : '';
  const now = o.now ?? Date.now();
  const before = getProfile(db);
  if (text === before.content.trim()) return { content: before.content, written: false };
  seedProfileVersion(db, before.content, now);
  pushProfileVersion(db, text, o.origin, o.reason ?? '', o.eventIds ?? [], now);
  const manual = Boolean(o.manual) || before.manual;
  db.prepare('UPDATE profile SET content = ?, updated_at = ?, manual = ? WHERE id = 1').run(text, now, manual ? 1 : 0);
  logChange(
    db,
    {
      op: 'profile',
      before: { content: before.content, manual: before.manual },
      after: { content: text, manual },
      source: o.origin === 'auto' ? 'auto' : 'manual',
      reason: o.reason,
      eventIds: o.eventIds,
    },
    now,
  );
  return { content: text, written: true };
}

/** 回退：把当前内容存一版（origin='restore'），再写回目标内容 */
export function restoreProfile(db: DB, rev: unknown, now = Date.now()): { content: string } {
  const n = typeof rev === 'number' && Number.isSafeInteger(rev) && rev > 0 ? rev : NaN;
  if (!Number.isSafeInteger(n)) throw new MemoryError(400, '版本号不对');
  const r = db.prepare('SELECT content FROM profile_versions WHERE rev = ?').get(n) as { content: string } | undefined;
  if (!r) throw new MemoryError(404, '版本不存在');
  const text = clip(String(r.content));
  tx(db, () => {
    const before = getProfile(db);
    seedProfileVersion(db, before.content, now);
    pushProfileVersion(db, text, 'restore', `回退到版本 ${n}`, [], now);
    db.prepare('UPDATE profile SET content = ?, updated_at = ?, manual = 1 WHERE id = 1').run(text, now);
    logChange(db, { op: 'profile', before: { content: before.content, manual: before.manual }, after: { content: text, manual: true }, source: 'manual', reason: `回退到版本 ${n}` }, now);
  });
  return { content: text };
}
