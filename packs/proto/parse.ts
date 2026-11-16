/** 模型输出解析：原型大纲、改动计划、页面 HTML（spec 4.1、4.2、8.1） */
import { PROTO_LIMITS, ProtoError, THEMES, type Device, type Outline, type OutlinePage, type Theme } from './types.ts';

const L = PROTO_LIMITS;
const MISUNDERSTOOD = '没理解修改要求，请换个说法';
const TOO_BIG = '改动太大，建议按新 PRD 重新生成';
const NOTE_MAX = 200;
const CHANGE_MAX = 400;

const isObj = (v: unknown): v is Record<string, unknown> => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const cut = (s: string, max: number) => [...s].slice(0, max).join('');
const key = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** 校验并修正大纲；没有可用页面时返回 null */
export function parseOutline(raw: unknown): Outline | null {
  if (!isObj(raw) || !Array.isArray(raw.pages)) return null;
  const src = raw.pages.filter(isObj).slice(0, L.pagesMax);
  if (!src.length) return null;

  // 先定每页的新 slug：合法且未占用的保留，其余按位置命名为 p<序号>；旧名 → 第一页的新名
  const used = new Set<string>();
  const rename = new Map<string, string>();
  const slugs = src.map((p) => {
    const k = key(p.slug);
    if (L.slugRe.test(k) && !used.has(k)) {
      used.add(k);
      return k;
    }
    return '';
  });
  slugs.forEach((s, i) => {
    if (s) return;
    let name = `p${i + 1}`;
    for (let k = 2; used.has(name); k++) name = `p${i + 1}-${k}`;
    used.add(name);
    slugs[i] = name;
  });
  src.forEach((p, i) => {
    const k = key(p.slug);
    if (k && !rename.has(k)) rename.set(k, slugs[i]);
  });
  const ref = (v: unknown) => rename.get(key(v)) ?? (used.has(key(v)) ? key(v) : null);
  const refs = (v: unknown, max: number) => {
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return [];
    const out: string[] = [];
    for (const x of v) {
      const s = ref(x);
      if (s && !out.includes(s)) out.push(s);
    }
    return out.slice(0, max);
  };

  const pages: OutlinePage[] = src.map((p, i) => ({
    slug: slugs[i],
    title: cut(str(p.title), L.titleMax) || `页面 ${i + 1}`,
    purpose: cut(str(p.purpose), L.purposeMax),
    content: cut(str(p.content), L.purposeMax),
    links: refs(p.links, L.pagesMax),
  }));

  let data: Record<string, unknown> = isObj(raw.data) ? raw.data : {};
  if (Buffer.byteLength(JSON.stringify(data)) > L.dataBytes) data = {};

  return {
    product: cut(str(raw.product), L.productMax),
    device: raw.device === 'phone' || raw.device === 'desktop' ? (raw.device as Device) : 'desktop',
    theme: (THEMES as readonly string[]).includes(raw.theme as string) ? (raw.theme as Theme) : 'blue',
    nav: refs(raw.nav, L.navMax),
    data,
    pages,
  };
}

export interface Plan {
  note: string;
  outline: Outline;
  pages: { slug: string; change: string }[];
}

/**
 * 校验改动计划：页面必须在新大纲里；新大纲里新增的页面自动加入。
 * 新大纲原本就超过页数上限时报「改动太大」，不像首次生成那样静默截断
 */
export function parsePlan(raw: unknown, current: Outline): Plan {
  if (!isObj(raw)) throw new ProtoError(400, MISUNDERSTOOD);
  if (isObj(raw.outline) && Array.isArray(raw.outline.pages) && raw.outline.pages.filter(isObj).length > L.pagesMax) throw new ProtoError(400, TOO_BIG);
  const outline = parseOutline(raw.outline);
  if (!outline) throw new ProtoError(400, MISUNDERSTOOD);
  const exists = new Set(outline.pages.map((p) => p.slug));
  const had = new Set(current.pages.map((p) => p.slug));
  const pages: Plan['pages'] = [];
  for (const p of Array.isArray(raw.pages) ? raw.pages.filter(isObj) : []) {
    const slug = key(p.slug);
    if (!exists.has(slug) || pages.some((x) => x.slug === slug)) continue;
    pages.push({ slug, change: cut(str(p.change), CHANGE_MAX) || '按修改要求调整这一页' });
  }
  for (const p of outline.pages) if (!had.has(p.slug) && !pages.some((x) => x.slug === p.slug)) pages.push({ slug: p.slug, change: '新页面' });
  const note = cut(str(raw.note), NOTE_MAX);
  if (!note || !pages.length) throw new ProtoError(400, MISUNDERSTOOD);
  if (pages.length > L.revisePagesMax) throw new ProtoError(400, TOO_BIG);
  return { note, outline, pages };
}

/** 找名为 tag 的开标签：返回开标签起点与其 `>` 之后的位置；没写完的开标签 end 为 -1 */
function findOpen(s: string, tag: string): { start: number; end: number } | null {
  const m = new RegExp(`<${tag}(?=[\\s>/]|$)`, 'i').exec(s);
  if (!m) return null;
  const gt = s.indexOf('>', m.index);
  return { start: m.index, end: gt < 0 ? -1 : gt + 1 };
}

function lastClose(s: string, tag: string): number {
  const re = new RegExp(`</${tag}\\s*>`, 'gi');
  let last = -1;
  for (let m = re.exec(s); m; m = re.exec(s)) last = m.index;
  return last;
}

/**
 * 页面输出：去掉代码块标记，取第一个 <main …> 到最后一个 </main> 之间的内容。
 * 有 <main 却没有 </main> 视为截断（llm.chat 不返回 finish_reason）。
 * 没有 main 时取 <body> 里的内容（整份文档的写法，不算截断）；都没有时整段返回。
 */
export function extractPage(text: string): { html: string; truncated: boolean } {
  const s = text.replace(/^\s*```[A-Za-z]*[^\n]*\n?/, '').replace(/\n?\s*```\s*$/, '');
  const main = findOpen(s, 'main');
  if (main) {
    const close = lastClose(s, 'main');
    if (main.end < 0 || close < main.end) return { html: main.end < 0 ? '' : s.slice(main.end).trim(), truncated: true };
    return { html: s.slice(main.end, close).trim(), truncated: false };
  }
  const body = findOpen(s, 'body');
  if (body && body.end >= 0) {
    const close = lastClose(s, 'body');
    return { html: (close >= body.end ? s.slice(body.end, close) : s.slice(body.end)).trim(), truncated: false };
  }
  return { html: s.trim(), truncated: false };
}
