import { GrowthError } from './types.ts';

// 四个平台的字段、字数限制与写作要求。字数限制为平台常见要求，以平台当时规则为准；
// 超出只提示（lengthNotes），不截断、不拦定稿。字数一律按码点、去首尾空白后计。

export type PlatformId = 'xhs' | 'wechat' | 'video' | 'landing';
export type ItemObj = Record<string, string>;
export type Fields = Record<string, string | string[] | ItemObj[]>;

export interface ItemDef {
  key: string;
  label: string;
  max: number;
}

export interface FieldDef {
  key: string;
  label: string;
  kind: 'text' | 'md' | 'tags' | 'items';
  min?: number;
  max?: number;
  minItems?: number;
  maxItems?: number;
  unit?: string;
  item?: ItemDef[];
}

export interface Platform {
  id: PlatformId;
  name: string;
  fields: FieldDef[];
  maxTokens: number;
  guide: string;
  total?: { label: string; paths: (f: Fields) => string[]; min: number; max: number };
}

export const PLATFORMS: Platform[] = [
  {
    id: 'xhs',
    name: '小红书',
    maxTokens: 1500,
    fields: [
      { key: 'title', label: '标题', kind: 'text', max: 20 },
      { key: 'body', label: '正文', kind: 'text', min: 300, max: 800 },
      { key: 'tags', label: '话题标签', kind: 'tags', minItems: 3, maxItems: 8, max: 15, unit: '个' },
    ],
    guide:
      '小红书种草笔记：标题不超过 20 字，抓眼球但不夸张；正文 300–800 字，第一人称、口语化，像朋友分享真实使用体验，分短段落，可以适度使用表情符号；先讲遇到的问题和场景，再讲产品怎么解决，最后给出行动建议；话题标签 3–8 个，与产品和场景相关，不带 # 号。',
  },
  {
    id: 'wechat',
    name: '微信公众号',
    maxTokens: 4500,
    fields: [
      { key: 'title', label: '标题', kind: 'text', max: 64 },
      { key: 'digest', label: '摘要', kind: 'text', max: 120 },
      { key: 'body', label: '正文', kind: 'md', min: 1500, max: 3000 },
    ],
    guide:
      '微信公众号深度文章：标题不超过 64 字；摘要不超过 120 字，概括读者能得到什么；正文 1500–3000 字，使用 Markdown，至少 2 个「## 」小标题，结构为背景与痛点、产品思路与功能、使用场景与示例、如何开始；语气可信、克制，有具体细节。',
  },
  {
    id: 'video',
    name: '抖音 / 视频号口播',
    maxTokens: 1500,
    fields: [
      { key: 'hook', label: '开头 3 秒', kind: 'text', max: 40 },
      {
        key: 'shots',
        label: '分镜',
        kind: 'items',
        minItems: 4,
        maxItems: 8,
        unit: '段',
        item: [
          { key: 'scene', label: '画面', max: 60 },
          { key: 'line', label: '口播', max: 80 },
        ],
      },
      { key: 'cta', label: '结尾引导', kind: 'text', max: 40 },
    ],
    total: {
      label: '口播合计',
      paths: (f) => ['hook', ...(Array.isArray(f.shots) ? f.shots.map((_, i) => `shots.${i}.line`) : []), 'cta'],
      min: 240,
      max: 300,
    },
    guide:
      '60 秒短视频口播脚本：开头 3 秒用一句话抛出痛点或反常识的钩子（不超过 40 字）；分镜 4–8 段，每段写画面（拍什么，不超过 60 字）和口播（说什么，不超过 80 字）；结尾一句引导行动（不超过 40 字）；口播合计 240–300 字，口语、短句、节奏快。',
  },
  {
    id: 'landing',
    name: '发布页 / 应用商店',
    maxTokens: 1200,
    fields: [
      { key: 'slogan', label: '标语', kind: 'text', max: 20 },
      { key: 'subtitle', label: '副标题', kind: 'text', max: 30 },
      {
        key: 'points',
        label: '卖点',
        kind: 'items',
        minItems: 3,
        maxItems: 5,
        unit: '条',
        item: [
          { key: 'title', label: '标题', max: 12 },
          { key: 'desc', label: '说明', max: 40 },
        ],
      },
      { key: 'store_desc', label: '商店简介', kind: 'text', max: 170 },
    ],
    guide:
      '产品发布页与应用商店描述：标语不超过 20 字，一句话说清价值；副标题不超过 30 字，补充对象或场景；卖点 3–5 条，每条一个不超过 12 字的短标题加一句不超过 40 字的说明，写具体能力而不是形容词；商店简介不超过 170 字，适合直接贴到应用商店。',
  },
];

export function getPlatform(id: unknown): Platform {
  const p = PLATFORMS.find((x) => x.id === id);
  if (!p) throw new GrowthError(400, '不支持的平台');
  return p;
}

export const cps = (s: string): number => Array.from(s.trim()).length;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function textPaths(p: Platform, f: Fields): string[] {
  const out: string[] = [];
  for (const d of p.fields) {
    const v = f[d.key];
    if (d.kind === 'tags') (Array.isArray(v) ? v : []).forEach((_, i) => out.push(`${d.key}.${i}`));
    else if (d.kind === 'items') (Array.isArray(v) ? v : []).forEach((_, i) => d.item!.forEach((it) => out.push(`${d.key}.${i}.${it.key}`)));
    else out.push(d.key);
  }
  return out;
}

export function textAt(f: Fields, path: string): string | null {
  let cur: unknown = f;
  for (const k of path.split('.')) {
    if (Array.isArray(cur)) cur = /^\d+$/.test(k) ? cur[Number(k)] : undefined;
    else if (isObj(cur)) cur = Object.hasOwn(cur, k) ? cur[k] : undefined;
    else return null;
  }
  return typeof cur === 'string' ? cur : null;
}

export function setTextAt(f: Fields, path: string, v: string): Fields {
  if (textAt(f, path) == null) throw new Error(`no text at ${path}`);
  const out = structuredClone(f);
  const ks = path.split('.');
  let cur: Record<string, unknown> | unknown[] = out;
  for (const k of ks.slice(0, -1)) cur = (cur as Record<string, unknown>)[k] as Record<string, unknown> | unknown[];
  (cur as Record<string, unknown>)[ks.at(-1)!] = v;
  return out;
}

/** 规整字段类型；任一文本超过 max × factor 时报「字段过长：路径」 */
export function validateFields(p: Platform, raw: unknown, factor: number): Fields {
  if (!isObj(raw)) throw new GrowthError(400, '文案格式不对');
  const out: Fields = {};
  const guard = (path: string, s: string, max: number | undefined) => {
    if (max != null && cps(s) > max * factor) throw new GrowthError(400, `字段过长：${path}`);
    return s;
  };
  for (const d of p.fields) {
    const v = raw[d.key];
    if (d.kind === 'tags') {
      const seen = new Set<string>();
      const tags: string[] = [];
      for (const t of Array.isArray(v) ? v : []) {
        const s = str(t).replace(/^#+/, '').trim();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        tags.push(s);
      }
      out[d.key] = tags.slice(0, d.maxItems).map((s, i) => guard(`${d.key}.${i}`, s, d.max));
    } else if (d.kind === 'items') {
      out[d.key] = (Array.isArray(v) ? v : []).slice(0, d.maxItems).map((x, i) => {
        const o: ItemObj = {};
        for (const it of d.item!) o[it.key] = guard(`${d.key}.${i}.${it.key}`, str(isObj(x) ? x[it.key] : ''), it.max);
        return o;
      });
    } else {
      out[d.key] = guard(d.key, str(v), d.max);
    }
  }
  return out;
}

/** 字段路径的中文名：`points.0.desc` → 「卖点 1 说明」 */
export function pathLabel(p: Platform, path: string): string {
  const [k, i, sub] = path.split('.');
  const d = p.fields.find((x) => x.key === k);
  if (!d) return path;
  if (i === undefined) return d.label;
  const head = `${d.label} ${Number(i) + 1}`;
  return sub === undefined ? head : `${head} ${d.item?.find((x) => x.key === sub)?.label ?? sub}`;
}

const tooLong = (label: string, n: number, max: number) => `${label} ${n} 字，超过 ${max} 字`;
const tooShort = (label: string, n: number, min: number) => `${label} ${n} 字，少于 ${min} 字`;

export function lengthNotes(p: Platform, f: Fields): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const text = (path: string, label: string, s: string, min?: number, max?: number) => {
    const n = cps(s);
    if (max != null && n > max) out.push({ path, text: tooLong(label, n, max) });
    else if (min != null && n > 0 && n < min) out.push({ path, text: tooShort(label, n, min) });
  };
  for (const d of p.fields) {
    const v = f[d.key];
    if (d.kind === 'tags' || d.kind === 'items') {
      const arr = Array.isArray(v) ? v : [];
      if (d.minItems != null && arr.length < d.minItems) out.push({ path: d.key, text: `${d.label} ${arr.length} ${d.unit}，少于 ${d.minItems} ${d.unit}` });
      if (d.maxItems != null && arr.length > d.maxItems) out.push({ path: d.key, text: `${d.label} ${arr.length} ${d.unit}，超过 ${d.maxItems} ${d.unit}` });
      if (d.kind === 'tags') arr.forEach((t, i) => text(`${d.key}.${i}`, `${d.label} ${i + 1}`, String(t), undefined, d.max));
      else
        arr.forEach((x, i) => {
          for (const it of d.item!) text(`${d.key}.${i}.${it.key}`, `${d.label} ${i + 1} ${it.label}`, isObj(x) ? str(x[it.key]) : '', undefined, it.max);
        });
    } else {
      text(d.key, d.label, typeof v === 'string' ? v : '', d.min, d.max);
    }
  }
  if (p.total) {
    const n = p.total.paths(f).reduce((s, path) => s + cps(textAt(f, path) ?? ''), 0);
    if (n < p.total.min) out.push({ path: '', text: tooShort(p.total.label, n, p.total.min) });
    else if (n > p.total.max) out.push({ path: '', text: tooLong(p.total.label, n, p.total.max) });
  }
  return out;
}

/** 必填但为空的叶子，以及条数不足的数组（报数组键） */
export function missingPaths(p: Platform, f: Fields): string[] {
  const out: string[] = [];
  for (const d of p.fields) {
    const v = f[d.key];
    if (d.kind === 'tags' || d.kind === 'items') {
      const arr = Array.isArray(v) ? v : [];
      if (arr.length < (d.minItems ?? 1)) {
        out.push(d.key);
        continue;
      }
      if (d.kind === 'tags') arr.forEach((t, i) => !str(t) && out.push(`${d.key}.${i}`));
      else arr.forEach((x, i) => d.item!.forEach((it) => !str(isObj(x) ? x[it.key] : '') && out.push(`${d.key}.${i}.${it.key}`)));
    } else if (!str(v)) out.push(d.key);
  }
  return out;
}

const s = (f: Fields, k: string): string => (typeof f[k] === 'string' ? (f[k] as string) : '');
const arr = <T>(f: Fields, k: string): T[] => (Array.isArray(f[k]) ? (f[k] as T[]) : []);

/** 字段渲染成固定格式的 Markdown：用于差异、AI 复核与导出 */
export function renderCopy(p: Platform, f: Fields): string {
  switch (p.id) {
    case 'xhs':
      return `### ${s(f, 'title')}\n\n${s(f, 'body')}\n\n${arr<string>(f, 'tags').map((t) => `#${t}`).join(' ')}`;
    case 'wechat':
      return `### ${s(f, 'title')}\n\n> ${s(f, 'digest')}\n\n${s(f, 'body')}`;
    case 'video':
      return [
        `**开头 3 秒**：${s(f, 'hook')}`,
        arr<ItemObj>(f, 'shots').map((x, i) => `${i + 1}. 画面：${x.scene ?? ''}／口播：${x.line ?? ''}`).join('\n'),
        `**结尾**：${s(f, 'cta')}`,
      ].join('\n\n');
    case 'landing':
      return [
        `### ${s(f, 'slogan')}`,
        s(f, 'subtitle'),
        arr<ItemObj>(f, 'points').map((x) => `- **${x.title ?? ''}**：${x.desc ?? ''}`).join('\n'),
        `**商店简介**：${s(f, 'store_desc')}`,
      ].join('\n\n');
  }
}
