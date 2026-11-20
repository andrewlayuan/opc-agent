// 合规材料逐章生成：组装提示、调用模型、清洗输出（去标题、限制网址、截断）
import type { ChatMessage, Llm } from '../../packages/core/llm.ts';
import { ENTITY_FIELDS, FACT_FIELDS } from './facts.ts';
import { answerText, ph, v, type Chapter, type Ctx, type DocTemplate } from './templates.ts';

export const CHAPTER_MAX = 6000;

const URL_RE = /https?:\/\/[^\s<>"'`()\[\]（）【】「」『』，。；、！？]+/g;
const TRAIL_RE = /[.,;:!?。，；：！？、）)」』'"]+$/;
const trimUrl = (u: string) => u.replace(TRAIL_RE, '');

function strings(x: unknown, out: string[]): string[] {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) x.forEach((y) => strings(y, out));
  else if (x && typeof x === 'object') Object.values(x).forEach((y) => strings(y, out));
  return out;
}

/** 资料（主体 + 产品资料，含 SDK 各列）中出现过的网址 */
export function allowedUrls(ctx: Ctx): Set<string> {
  const out = new Set<string>();
  for (const s of strings([ctx.entity, ctx.facts], [])) for (const m of s.matchAll(URL_RE)) {
    const u = trimUrl(m[0]);
    if (/^https?:\/\/./.test(u)) out.add(u);
  }
  return out;
}

export function sanitizeChapter(text: string, allowed: Set<string>): string {
  let s = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```[^\n]*\n?/, '');
    s = s.replace(/\n?```\s*$/, '');
  }
  s = s.split('\n').filter((l) => !/^\s{0,3}#{1,2}(\s|$)/.test(l)).join('\n');
  // NUL 用作保留链接的占位符，先从模型输出里去掉
  s = s.replace(/\u0000/g, '');
  /** 删除不在资料里的裸网址（协议不区分大小写） */
  const bare = (x: string) => x.replace(/([ \t]?)(https?:\/\/[^\s<>"'`()\[\]（）【】「」『』，。；、！？]+)/gi, (_m, sp: string, raw: string) => {
    const url = trimUrl(raw);
    return allowed.has(url) ? sp + raw : raw.slice(url.length);
  });
  const keep: string[] = [];
  s = s.replace(/\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/gi, (_m, label: string, url: string) => {
    if (!allowed.has(url)) return bare(label);
    keep.push(`[${bare(label)}](${url})`);
    return `\u0000${keep.length - 1}\u0000`;
  });
  s = bare(s);
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => keep[Number(i)] ?? '');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  // 截断后不留半个占位，否则定稿检查识别不到
  s = [...s].slice(0, CHAPTER_MAX).join('').replace(/【(待(填(：[^】\n]*)?)?)?$/, '').trim();
  if (!s) throw new Error('模型没有返回内容');
  return s;
}

const angle = (s: string) => s.replace(/&/g, '＆').replace(/</g, '＜').replace(/>/g, '＞');

function factsJson(ctx: Ctx): string {
  const out: Record<string, unknown> = {};
  for (const f of ENTITY_FIELDS) out[f.label] = v(ctx, `entity.${f.key}`);
  for (const f of FACT_FIELDS) {
    if (f.type === 'sdks') {
      const sdks = ctx.facts.sdks;
      out[f.label] = Array.isArray(sdks)
        ? (sdks.length ? sdks.map((x) => ({ 名称: x.name, 用途: x.purpose, 收集的信息: x.data, 隐私政策: x.policy_url })) : '未接入第三方 SDK')
        : ph(f.label);
    } else if (f.type === 'select') {
      const val = ctx.facts[f.key];
      const opt = f.options?.find(([k]) => k && k === val);
      out[f.label] = opt ? opt[1] : ph(f.label);
    } else out[f.label] = v(ctx, `facts.${f.key}`);
  }
  // 网址中的 & 要保留，便于模型原样引用；只替换尖括号防止闭合标签
  return JSON.stringify(out, null, 2).replace(/</g, '＜').replace(/>/g, '＞');
}

const SYSTEM = [
  '你是中国互联网产品合规文书的起草助手，按给定的章节标题与写作要点，起草一份合规材料中的一章。',
  '输出要求：',
  '- 只输出本章正文（Markdown），不要写章标题，不要开场白或结束语，不要用代码块包裹；需要分节时用三级标题（###）。',
  '- 只使用 <facts>、<assessment>、<product> 中给出的信息，不编造公司信息、数据、认证、网址或承诺。',
  '- 资料中缺失的信息原样输出占位，格式为【待填：字段名】，例如【待填：联系邮箱】；资料里已是占位的值照抄。',
  '- 不输出链接，除非该网址在资料中出现过。',
  '- 引用法规只写法规全称；写作要点里给出的条款编号可以照用，其他条款编号不要写。',
  '- 语言正式、清晰，面向普通用户或监管部门，使用简体中文。',
].join('\n');

export function chapterMessages(t: DocTemplate, ch: Chapter, ctx: Ctx, reasons: string[]): ChatMessage[] {
  const chapter = [`材料：${t.name}`, `章节：${ch.title}`, '写作要点：', ...(ch.points ?? []).map((p, i) => `${i + 1}. ${p}`)].join('\n');
  const assessment = [
    '问卷答案：', ...answerText(ctx.answers).map((x) => `- ${x}`),
    '判定理由：', ...(reasons.length ? reasons.map((x) => `- ${x}`) : ['- （无）']),
  ].join('\n');
  const user = [
    `<chapter>\n${angle(chapter)}\n</chapter>`,
    `<facts>\n${factsJson(ctx)}\n</facts>`,
    `<assessment>\n${angle(assessment)}\n</assessment>`,
    `<product>\n名称：${angle(ctx.product.name)}\n描述：${angle(ctx.product.description || '（无）')}\n</product>`,
    '请起草本章正文。',
  ].join('\n\n');
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
}

export type GenerateFn = (llm: Llm, g: { template: DocTemplate; chapter: Chapter; ctx: Ctx; reasons: string[] }) => Promise<string>;

export const generateChapter: GenerateFn = async (llm, g) => {
  const text = await llm.chat(chapterMessages(g.template, g.chapter, g.ctx, g.reasons), { temperature: 0.3, maxTokens: 2500 });
  return sanitizeChapter(text, allowedUrls(g.ctx));
};
