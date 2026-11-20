// 材料模板目录：十种材料的顺序、可起草条件、事项到材料的映射。类型与工具见 template-kit.ts
import type { AssessResult, Answers } from './rules.ts';
import type { Chapter, DocTemplate } from './template-kit.ts';
import { AIGC_LABEL_PLAN, ALGO_SELFASSESS, ANTHRO_REPORT, APP_STATEMENT, SECURITY_REPORT } from './templates-filing.ts';
import { ALGO_DISCLOSURE, MINOR_STATEMENT, MODEL_DISCLOSURE, PRIVACY_POLICY, TERMS } from './templates-public.ts';

export * from './template-kit.ts';

/** 整体模板版本：任何模板文字或章节变化时 +1，用于「资料已更新」判断 */
export const TEMPLATES_VERSION = 1;

export const TEMPLATES: DocTemplate[] = [
  PRIVACY_POLICY,
  TERMS,
  APP_STATEMENT,
  ALGO_SELFASSESS,
  ALGO_DISCLOSURE,
  MODEL_DISCLOSURE,
  SECURITY_REPORT,
  ANTHRO_REPORT,
  AIGC_LABEL_PLAN,
  MINOR_STATEMENT,
];

const BY_KIND = new Map(TEMPLATES.map((t) => [t.kind, t]));
export const templateOf = (kind: string): DocTemplate | undefined => BY_KIND.get(kind);

export const chaptersFor = (t: DocTemplate, a: Answers): Chapter[] => t.chapters.filter((c) => !c.when || c.when(a));

export function availability(t: DocTemplate, result: AssessResult | null): { ok: true } | { ok: false; reason: string } {
  if (!result) return { ok: false, reason: '请先完成问卷判定' };
  if (!t.items.length) return { ok: true };
  const hit = result.items.some((x) => t.items.includes(x.id) && x.level !== 'na');
  return hit ? { ok: true } : { ok: false, reason: '当前判定不需要这份材料' };
}

export const kindsForItem = (itemId: string): string[] => TEMPLATES.filter((t) => t.items.includes(itemId)).map((t) => t.kind);
