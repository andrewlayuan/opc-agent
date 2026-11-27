// 职业档案：每个档案对应一组默认启用的内置信息源、一组主题和一套分析口径。
// 切换档案只改内置源的启用状态，自定义添加的源不受影响。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '../../packages/core/db.ts';
import { loadSourceDefs } from './collect.ts';
import { DEFAULT_PROFILE, isLegacyProfileId, normalizeProfileId, profilesOf } from './profile-id.ts';
import type { Lens, Topic } from './text.ts';

export { DEFAULT_PROFILE, profilesOf };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREF_KEY = 'source_profile';

export interface Profile {
  id: string;
  name: string;
  /** 适用人群 */
  who: string;
  /** 关注点 */
  focus: string[];
  /** 为什么选这些信息源 */
  why: string;
  /** 以下用于分析与简报提示词 */
  role: string;
  brief: string;
  importance: string;
  angle: string;
  sections: string;
}

export function loadProfiles(): Profile[] {
  return (JSON.parse(fs.readFileSync(path.join(HERE, 'profiles.json'), 'utf8')) as { profiles: Profile[] }).profiles;
}

/** 内置源 / 主题所属的档案；省略 profiles 的只属于默认档案 */
export function getActiveProfile(db: DB): string {
  const row = db.prepare('SELECT value FROM prefs WHERE key = ?').get(PREF_KEY) as { value: string } | undefined;
  const id = normalizeProfileId(row?.value);
  return loadProfiles().some((p) => p.id === id) ? id : DEFAULT_PROFILE;
}

/** 当前档案可选的主题（主题栏、「我的关注」、分析提示词只用这些）；一个都没有时退回全部 */
export function topicsOfProfile(topics: Topic[], id: string): Topic[] {
  const mine = topics.filter((t) => profilesOf(t).includes(id));
  return mine.length ? mine : topics;
}

/** 当前档案的完整定义（含提示词口径） */
export function activeProfile(db: DB): Profile {
  const id = getActiveProfile(db);
  const all = loadProfiles();
  return all.find((p) => p.id === id) ?? all[0];
}

/** 当前档案的分析口径 */
export function lensFor(db: DB, topics: Topic[]): Lens {
  const p = activeProfile(db);
  return { role: p.role, brief: p.brief, importance: p.importance, angle: p.angle, sections: p.sections, topics: topicsOfProfile(topics, p.id) };
}

/** 信息源列表附带「是否属于当前档案」：自定义源总是属于；内置源看 sources.json 里的归属 */
export function withProfileFlag<T extends { id: string; custom: number }>(db: DB, rows: T[]): (T & { in_profile: boolean })[] {
  const active = getActiveProfile(db);
  const mine = new Set(loadSourceDefs().filter((d) => profilesOf(d).includes(active)).map((d) => d.id));
  return rows.map((r) => ({ ...r, in_profile: !!r.custom || mine.has(r.id) }));
}

/** 档案列表，附带各自包含的内置源数量与主题数量 */
export function listProfiles(db: DB, topics: Topic[] = []): { profiles: (Profile & { count: number; topicCount: number })[]; active: string } {
  const defs = loadSourceDefs();
  return {
    profiles: loadProfiles().map((p) => ({
      ...p,
      count: defs.filter((d) => profilesOf(d).includes(p.id)).length,
      topicCount: topics.filter((t) => profilesOf(t).includes(p.id)).length,
    })),
    active: getActiveProfile(db),
  };
}

export class ProfileError extends Error {}

/** 切换档案：启用该档案的内置源，停用其它内置源；自定义源保持原样。整个切换在一个事务里完成 */
export function applyProfile(db: DB, id: unknown, now = Date.now()): { id: string; name: string; enabled: number; disabled: number } {
  const profile = typeof id === 'string' ? loadProfiles().find((p) => p.id === id) : undefined;
  if (!profile) throw new ProfileError('职业档案不存在');
  const inProfile = new Set(loadSourceDefs().filter((d) => profilesOf(d).includes(profile.id)).map((d) => d.id));
  const rows = db.prepare('SELECT id FROM sources WHERE custom = 0').all() as { id: string }[];
  const set = db.prepare('UPDATE sources SET enabled = ? WHERE id = ?');
  let enabled = 0;
  let disabled = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const on = inProfile.has(r.id);
      set.run(on ? 1 : 0, r.id);
      if (on) enabled++;
      else disabled++;
    }
    db.prepare('INSERT INTO prefs(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(PREF_KEY, profile.id, now);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { id: profile.id, name: profile.name, enabled, disabled };
}

/** 早期版本保存的身份（ai / dev / investor）迁移到新的身份：重新应用一次，让合并后的信息源生效。没有需要迁移的返回 null */
export function migrateLegacyProfile(db: DB, now = Date.now()): string | null {
  const row = db.prepare('SELECT value FROM prefs WHERE key = ?').get(PREF_KEY) as { value: string } | undefined;
  if (!row || !isLegacyProfileId(row.value)) return null;
  return applyProfile(db, normalizeProfileId(row.value), now).id;
}
