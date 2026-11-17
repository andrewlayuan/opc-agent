// Wiki 正文解析：slug 规范化，[[链接]]、[^doc:ord] 引用、![](asset:ID) 图片
import { WIKI_LIMITS } from './types.ts';

export interface Cite {
  doc: number;
  ord: number;
}

export const LINK_RE = /\[\[([^[\]|\n]{1,120})(?:\|([^[\]\n]{0,120}))?\]\]/g;
export const CITE_RE = /\[\^(\d{1,9}):(\d{1,6})\]/g;
export const ASSET_RE = /!\[[^\]\n]*\]\(asset:(\d{1,9})\)/g;

/** NFKC → 小写 → 空白、标点、符号换成 - → 去首尾 - → 最长 80 个码点；结果可能为空 */
export function slugify(raw: string): string {
  const s = String(raw).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '-').replace(/^-+|-+$/g, '');
  const cps = [...s];
  return (cps.length > WIKI_LIMITS.slugMax ? cps.slice(0, WIKI_LIMITS.slugMax).join('') : s).replace(/-+$/, '');
}

const uniqCites = (list: Cite[]): Cite[] => {
  const seen = new Set<string>();
  return list.filter((c) => {
    const k = `${c.doc}:${c.ord}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

export function parseBody(body: string): { links: string[]; cites: Cite[]; assets: number[] } {
  const links = new Set<string>();
  for (const m of body.matchAll(LINK_RE)) {
    const s = slugify(m[1]);
    if (s) links.add(s);
  }
  const cites = uniqCites([...body.matchAll(CITE_RE)].map((m) => ({ doc: Number(m[1]), ord: Number(m[2]) })));
  const assets = [...new Set([...body.matchAll(ASSET_RE)].map((m) => Number(m[1])))];
  return { links: [...links], cites, assets };
}

/** 链接改写为 [[slug]] 或 [[slug|显示文字]]；删除 validCite 不认可的引用 */
export function normalizeBody(body: string, validCite: (doc: number, ord: number) => boolean): { body: string; links: string[]; cites: Cite[]; dropped: string[] } {
  const dropped: string[] = [];
  let out = body.replace(LINK_RE, (_all, target: string, label: string | undefined) => {
    const s = slugify(target);
    const text = (label ?? target).trim();
    if (!s) return text;
    return text === s ? `[[${s}]]` : `[[${s}|${text}]]`;
  });
  out = out.replace(CITE_RE, (all, d: string, o: string) => {
    if (validCite(Number(d), Number(o))) return all;
    dropped.push(all);
    return '';
  });
  const p = parseBody(out);
  return { body: out, links: p.links, cites: p.cites, dropped };
}
