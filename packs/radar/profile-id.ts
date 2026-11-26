// 职业档案 id 的约定（无依赖，供 collect / profiles / prefs 共用）
export const DEFAULT_PROFILE = 'tech';
/** 早期版本的档案 id：ai、dev 合并为 tech，investor 并入 founder */
const LEGACY: Record<string, string> = { ai: 'tech', dev: 'tech', investor: 'founder' };

/** 把库里保存的档案 id 规范成当前 id；空值返回默认档案 */
export function normalizeProfileId(v: string | null | undefined): string {
  if (!v) return DEFAULT_PROFILE;
  return LEGACY[v] ?? v;
}
export const isLegacyProfileId = (v: string | null | undefined): boolean => !!v && v in LEGACY;
