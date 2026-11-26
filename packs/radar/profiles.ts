// 职业档案：每个档案对应一组默认启用的内置信息源。切换档案只改内置源的启用状态，自定义添加的源不受影响。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '../../packages/core/db.ts';
import { loadSourceDefs } from './collect.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREF_KEY = 'source_profile';
export const DEFAULT_PROFILE = 'ai';

export interface Profile {
  id: string;
  name: string;
  desc: string;
}

export function loadProfiles(): Profile[] {
  return (JSON.parse(fs.readFileSync(path.join(HERE, 'profiles.json'), 'utf8')) as { profiles: Profile[] }).profiles;
}

/** 内置源所属的档案；省略 profiles 的源只属于默认档案 */
export function profilesOf(def: { profiles?: string[] }): string[] {
  return def.profiles?.length ? def.profiles : [DEFAULT_PROFILE];
}

export function getActiveProfile(db: DB): string {
  const row = db.prepare('SELECT value FROM prefs WHERE key = ?').get(PREF_KEY) as { value: string } | undefined;
  return row && loadProfiles().some((p) => p.id === row.value) ? row.value : DEFAULT_PROFILE;
}

/** 档案列表，附带各自包含的内置源数量 */
export function listProfiles(db: DB): { profiles: (Profile & { count: number })[]; active: string } {
  const defs = loadSourceDefs();
  return {
    profiles: loadProfiles().map((p) => ({ ...p, count: defs.filter((d) => profilesOf(d).includes(p.id)).length })),
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
