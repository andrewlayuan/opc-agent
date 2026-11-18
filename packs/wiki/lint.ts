// 体检：程序检查（孤立页、缺页、依据失效、页面过时、无依据、缺少链接）+ 模型检查（矛盾、数据缺口）
// 只自动修复「缺少链接」和「依据失效」，记为一条可撤销的 fix 操作
import type { DB } from '../../packages/core/db.ts';
import type { Llm } from '../../packages/core/llm.ts';
import { Calls, str } from './ingest.ts';
import { ASSET_RE, CITE_RE, LINK_RE, titleKeys } from './parse.ts';
import { conflictPrompt, gapPrompt } from './prompts.ts';
import { citeValid, createOp, finishOp, tx, writePages } from './store.ts';
import type { PageChange, PageDraft } from './store.ts';
import { WIKI_LIMITS } from './types.ts';
import type { PageKind } from './types.ts';

export type LintType = 'orphan' | 'missing' | 'broken_cite' | 'stale' | 'no_cite' | 'missing_link' | 'conflict' | 'gap';
export interface LintIssue {
  type: LintType;
  slug?: string;
  slugs?: string[];
  target?: string;
  refs?: number;
  detail: string;
  fixed?: boolean;
}

const PER_TYPE = 100;
const GROUP_MAX = 5;
const BODY_FOR_MODEL = 3000;
const NO_ORPHAN: ReadonlySet<string> = new Set(['overview', 'source', 'answer']);
const NO_CITE_OK: ReadonlySet<string> = new Set(['overview', 'answer']);

interface Pg {
  id: number;
  slug: string;
  kind: PageKind;
  title: string;
  summary: string;
  body: string;
  updated_at: number;
}

const livePages = (db: DB): Pg[] =>
  (db.prepare('SELECT id, slug, kind, title, summary, body, updated_at FROM wiki_pages WHERE deleted = 0 ORDER BY updated_at DESC').all() as unknown as Pg[]).map((p) => ({
    ...p,
    id: Number(p.id),
    updated_at: Number(p.updated_at),
  }));

/** 链接、引用、图片、代码块所在的区间：这些位置里出现的标题不算「缺少链接」 */
function protectedRanges(body: string): [number, number][] {
  const out: [number, number][] = [];
  for (const re of [/```[\s\S]*?```/g, /`[^`\n]*`/g, LINK_RE, CITE_RE, ASSET_RE]) {
    for (const m of body.matchAll(new RegExp(re.source, 'g'))) out.push([m.index!, m.index! + m[0].length]);
  }
  return out;
}

/** 标题在正文中第一次出现、且不在受保护区间里的位置；没有时返回 -1 */
export function firstMention(body: string, title: string): number {
  const ranges = protectedRanges(body);
  for (let i = body.indexOf(title); i >= 0; i = body.indexOf(title, i + 1)) {
    const end = i + title.length;
    if (!ranges.some(([a, b]) => i < b && end > a)) return i;
  }
  return -1;
}

export function lintChecks(db: DB): LintIssue[] {
  const pages = livePages(db);
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const out: LintIssue[] = [];
  const count = new Map<LintType, number>();
  const push = (i: LintIssue) => {
    const n = count.get(i.type) ?? 0;
    if (n >= PER_TYPE) return;
    count.set(i.type, n + 1);
    out.push(i);
  };
  const links = db.prepare('SELECT l.from_page, l.to_slug FROM wiki_links l JOIN wiki_pages p ON p.id = l.from_page WHERE p.deleted = 0').all() as { from_page: number; to_slug: string }[];
  const inbound = new Map<string, Set<number>>();
  const outLinks = new Map<number, Set<string>>();
  for (const l of links) {
    const from = Number(l.from_page);
    if (!inbound.has(l.to_slug)) inbound.set(l.to_slug, new Set());
    inbound.get(l.to_slug)!.add(from);
    if (!outLinks.has(from)) outLinks.set(from, new Set());
    outLinks.get(from)!.add(l.to_slug);
  }
  // 缺页
  const missing = [...inbound.entries()].filter(([s]) => !bySlug.has(s)).sort((a, b) => b[1].size - a[1].size);
  for (const [s, from] of missing) push({ type: 'missing', target: s, refs: from.size, detail: `「${s}」被 ${from.size} 个页面链接，但还不存在` });
  // 孤立页
  for (const p of pages) {
    if (NO_ORPHAN.has(p.kind)) continue;
    const inb = [...(inbound.get(p.slug) ?? [])].filter((id) => id !== p.id);
    if (!inb.length) push({ type: 'orphan', slug: p.slug, detail: `「${p.title}」没有被任何页面链接` });
  }
  // 引用：失效、过时、无依据
  const cites = db
    .prepare(
      `SELECT c.page_id, c.doc_id, c.ord, d.updated_at AS doc_updated FROM wiki_cites c JOIN wiki_pages p ON p.id = c.page_id AND p.deleted = 0
       LEFT JOIN kb_docs d ON d.id = c.doc_id`,
    )
    .all() as { page_id: number; doc_id: number; ord: number; doc_updated: number | null }[];
  const byPage = new Map<number, typeof cites>();
  for (const c of cites) {
    const k = Number(c.page_id);
    if (!byPage.has(k)) byPage.set(k, []);
    byPage.get(k)!.push(c);
  }
  for (const p of pages) {
    const cs = byPage.get(p.id) ?? [];
    if (!cs.length) {
      if (!NO_CITE_OK.has(p.kind)) push({ type: 'no_cite', slug: p.slug, detail: `「${p.title}」没有任何原文出处` });
      continue;
    }
    const broken = cs.filter((c) => !citeValid(db, Number(c.doc_id), Number(c.ord)));
    if (broken.length) push({ type: 'broken_cite', slug: p.slug, refs: broken.length, detail: `「${p.title}」有 ${broken.length} 处出处已失效（资料或段落已删除）` });
    const stale = cs.some((c) => c.doc_updated != null && Number(c.doc_updated) > p.updated_at && citeValid(db, Number(c.doc_id), Number(c.ord)));
    if (stale) push({ type: 'stale', slug: p.slug, detail: `「${p.title}」引用的资料在页面更新后又有改动` });
  }
  // 缺少链接
  const titled = pages.filter((p) => [...p.title].length >= 3);
  for (const p of pages) {
    const linked = outLinks.get(p.id) ?? new Set<string>();
    for (const t of titled) {
      if (t.id === p.id || linked.has(t.slug)) continue;
      if (firstMention(p.body, t.title) >= 0) push({ type: 'missing_link', slug: p.slug, target: t.slug, detail: `「${p.title}」提到了「${t.title}」但没有链接` });
    }
  }
  return out;
}

/** 自动修复：给缺少链接的标题第一次出现处加链接，重写含失效出处的页面（writePages 会删除失效引用） */
function autoFix(db: DB, issues: LintIssue[]): number | null {
  const pages = new Map(livePages(db).map((p) => [p.slug, p]));
  const bodies = new Map<string, string>();
  // 缺页其实是已有页面的标题：重新保存链到它的页面，写入时会把链接解析成该页 slug
  const byTitle = new Map<string, string>();
  for (const p of pages.values()) for (const k of titleKeys(p.title)) if (!byTitle.has(k)) byTitle.set(k, p.slug);
  for (const i of issues) {
    if (i.type !== 'missing' || !i.target || !byTitle.has(i.target)) continue;
    const from = db.prepare('SELECT p.slug FROM wiki_links l JOIN wiki_pages p ON p.id = l.from_page AND p.deleted = 0 WHERE l.to_slug = ?').all(i.target) as { slug: string }[];
    for (const f of from) if (pages.has(f.slug) && !bodies.has(f.slug)) bodies.set(f.slug, pages.get(f.slug)!.body);
    if (from.length) i.fixed = true;
  }
  for (const i of issues) {
    if (i.type !== 'missing_link' && i.type !== 'broken_cite') continue;
    const p = pages.get(i.slug!);
    if (!p) continue;
    let body = bodies.get(p.slug) ?? p.body;
    if (i.type === 'missing_link') {
      const t = pages.get(i.target!);
      if (!t) continue;
      const at = firstMention(body, t.title);
      if (at < 0) continue;
      body = `${body.slice(0, at)}[[${t.slug}|${t.title}]]${body.slice(at + t.title.length)}`;
    }
    bodies.set(p.slug, body);
    i.fixed = true;
  }
  if (!bodies.size) return null;
  return tx(db, () => {
    const opId = createOp(db, 'fix', { status: 'running' });
    const drafts: PageDraft[] = [...bodies.entries()].map(([slug, body]) => {
      const p = pages.get(slug)!;
      return { slug, kind: p.kind, title: p.title, summary: p.summary, body };
    });
    const { changes } = writePages(db, opId, drafts);
    finishOp(db, opId, { status: 'done', pages: changes, note: `体检自动修复 ${changes.length} 页（补链接、按标题修正链接、删除失效出处）` });
    return opId;
  });
}

/** 按链接关系把页面分组：从最近更新的页面开始，取它的邻居凑成 2–5 页一组 */
function groups(db: DB): Pg[][] {
  const pages = livePages(db);
  const byId = new Map(pages.map((p) => [p.id, p]));
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const adj = new Map<number, Set<number>>();
  const add = (a: number, b: number) => {
    if (a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const l of db.prepare('SELECT from_page, to_slug FROM wiki_links').all() as { from_page: number; to_slug: string }[]) {
    const t = bySlug.get(l.to_slug);
    if (!t || !byId.has(Number(l.from_page))) continue;
    add(Number(l.from_page), t.id);
    add(t.id, Number(l.from_page));
  }
  const used = new Set<number>();
  const out: Pg[][] = [];
  for (const p of pages) {
    if (used.has(p.id)) continue;
    const g = [p];
    for (const n of adj.get(p.id) ?? []) {
      if (g.length >= GROUP_MAX) break;
      if (!used.has(n)) g.push(byId.get(n)!);
    }
    if (g.length < 2) continue;
    for (const x of g) used.add(x.id);
    out.push(g);
  }
  return out;
}

export async function runLint(db: DB, llm: Llm, opId: number, o: { maxCalls?: number; now?: number } = {}): Promise<{ llmCalls: number; note: string; changes: PageChange[] }> {
  const maxCalls = o.maxCalls ?? WIKI_LIMITS.lintCalls;
  const issues = lintChecks(db);
  const fixOp = autoFix(db, issues);
  const calls = new Calls(llm);
  let modelError: string | undefined;
  try {
    for (const g of groups(db)) {
      if (calls.n >= maxCalls - 1) break;
      const out = await calls.json<{ conflicts?: unknown }>(conflictPrompt(g.map((p) => ({ slug: p.slug, title: p.title, body: [...p.body].slice(0, BODY_FOR_MODEL).join('') }))), 2000);
      const inGroup = new Set(g.map((p) => p.slug));
      for (const c of Array.isArray(out.conflicts) ? (out.conflicts as Record<string, unknown>[]) : []) {
        if (!c || typeof c !== 'object') continue;
        const slugs = (Array.isArray(c.slugs) ? c.slugs : []).map(String).filter((s) => inGroup.has(s));
        const claim = str(c.claim, 200);
        if (!claim) continue;
        const cites = (Array.isArray(c.cites) ? c.cites : []).map((x) => str(x, 30)).filter(Boolean).slice(0, 6);
        issues.push({ type: 'conflict', slugs: slugs.length ? slugs : [...inGroup], detail: `${claim}${cites.length ? `（${cites.join(' ')}）` : ''}` });
      }
    }
    if (calls.n < maxCalls) {
      const overviews = livePages(db).filter((p) => p.kind === 'overview').slice(0, 20);
      const missing = issues.filter((i) => i.type === 'missing').slice(0, 20).map((i) => ({ slug: i.target!, refs: i.refs ?? 0 }));
      const nPages = livePages(db).length;
      const nDocs = Number((db.prepare('SELECT count(*) AS n FROM wiki_docs WHERE state = \'done\'').get() as { n: number }).n);
      const out = await calls.json<{ gaps?: unknown }>(gapPrompt(overviews, missing, `${nPages} 个页面，已编入 ${nDocs} 份资料`), 1500);
      for (const g of (Array.isArray(out.gaps) ? (out.gaps as Record<string, unknown>[]) : []).slice(0, 5)) {
        if (g && typeof g === 'object' && str(g.topic)) issues.push({ type: 'gap', detail: `${str(g.topic, 80)}：${str(g.why, 200)}` });
      }
    }
  } catch (e) {
    modelError = `模型检查失败：${(e as Error).message}`;
  }
  const note = JSON.stringify({ issues, fixOp, ...(modelError ? { modelError } : {}) });
  finishOp(db, opId, { status: 'done', note, llmCalls: calls.n, now: o.now });
  return { llmCalls: calls.n, note, changes: [] };
}
