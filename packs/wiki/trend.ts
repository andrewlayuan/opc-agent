// 趋势预测：按 Wiki 一级分类（领域），结合该领域已有页面与最近的情报，每个领域生成一页「趋势：领域」。
// 一次操作覆盖所有够格的领域，页面在一个事务里一起提交，可整体撤销（与摄入同一套版本机制）。
import type { DB } from '../../packages/core/db.ts';
import type { Llm } from '../../packages/core/llm.ts';
import { Calls, str } from './ingest.ts';
import { slugify } from './parse.ts';
import { trendPrompt } from './prompts.ts';
import type { TrendItem } from './prompts.ts';
import { finishOp, getPageRow, tx, writePages } from './store.ts';
import type { PageChange, PageDraft } from './store.ts';
import { placePage } from './tree.ts';
import { WIKI_LIMITS } from './types.ts';

const DAY = 86_400_000;
const SYSTEM_NODES = new Set(['资料摘要', '问答']);
const PREVIOUS_MAX = 3000;
const ITEM_SUMMARY = 160;
const POOL = 800;

export interface Domain {
  id: number;
  title: string;
  pages: { id: number; slug: string; title: string; summary: string }[];
}

export interface Pooled {
  id: number;
  url: string;
  title: string;
  summary: string;
  published_at: number;
  source: string;
  importance: number;
  hay: string;
}

const cp = (s: string, n: number): string => {
  const a = [...s];
  return a.length > n ? a.slice(0, n).join('') : s;
};
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const ymd = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
/** 外部文本进入页面正文前：折叠换行，并把方括号换成全角圆括号（防止伪造 [[链接]]、[^引用]、[n] 标记） */
const plain = (s: string): string => oneLine(s).replace(/[[\]]/g, (c) => (c === '[' ? '（' : '）'));

/** 总长不超过 80 个字符（页面名上限）；名称太长时截断，仍保持同名领域得到同一个页面名 */
export const trendSlug = (domain: string): string => {
  const s = [...slugify(domain)].slice(0, WIKI_LIMITS.slugMax - 6).join('').replace(/-+$/, '');
  return s ? `trend-${s}` : '';
};

/**
 * 趋势的「领域」：有二级分类的一级分类，每个二级分类（含子孙）是一个领域，名称写成「一级 / 二级」；
 * 没有子分类的一级分类自己是一个领域。直接挂在有子分类的一级分类下的页面不归任何领域。
 * 系统节点与 source / answer / trend 页不算。
 */
export function trendDomains(db: DB): Domain[] {
  const nodes = db.prepare('SELECT id, parent_id, title FROM wiki_nodes ORDER BY sort, id').all() as { id: number; parent_id: number | null; title: string }[];
  const pages = db
    .prepare(
      `SELECT p.id, p.slug, p.title, p.summary, pn.node_id FROM wiki_pages p JOIN wiki_page_node pn ON pn.page_id = p.id
       WHERE p.deleted = 0 AND p.kind NOT IN ('source', 'answer', 'trend') ORDER BY p.updated_at DESC`,
    )
    .all() as { id: number; slug: string; title: string; summary: string; node_id: number }[];
  const byId = new Map(nodes.map((n) => [Number(n.id), n]));
  const hasKids = new Set(nodes.filter((n) => n.parent_id != null).map((n) => Number(n.parent_id)));
  /** 从根到该节点的链 */
  const chain = (id: number): { id: number; parent_id: number | null; title: string }[] => {
    const out: { id: number; parent_id: number | null; title: string }[] = [];
    for (let cur = byId.get(id), g = 0; cur && g < 10; cur = cur.parent_id == null ? undefined : byId.get(Number(cur.parent_id)), g++) out.unshift(cur);
    return out;
  };
  const out = new Map<number, Domain>();
  for (const p of pages) {
    const c = chain(Number(p.node_id));
    if (!c.length || SYSTEM_NODES.has(c[0].title)) continue;
    const root = c[0];
    const node = c.length >= 2 ? c[1] : hasKids.has(Number(root.id)) ? null : root;
    if (!node) continue;
    const d = out.get(Number(node.id)) ?? { id: Number(node.id), title: node === root ? root.title : `${root.title} / ${node.title}`, pages: [] };
    d.pages.push({ id: Number(p.id), slug: p.slug, title: p.title, summary: p.summary });
    out.set(d.id, d);
  }
  return [...out.values()];
}

export function loadPool(db: DB, now: number): Pooled[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.url, i.title, i.title_zh, i.summary_zh, i.published_at, i.importance, s.name AS source
       FROM items i JOIN sources s ON s.id = i.source_id
       WHERE i.dup_of IS NULL AND i.analyzed_at IS NOT NULL AND i.published_at >= ? AND coalesce(i.importance, 0) >= 3
       ORDER BY i.importance DESC, i.published_at DESC LIMIT ?`,
    )
    .all(now - WIKI_LIMITS.trendDays * DAY, POOL) as Record<string, unknown>[];
  return rows
    .filter((r) => /^https?:\/\//.test(String(r.url)))
    .map((r) => {
      const title = String(r.title_zh || r.title);
      const summary = cp(oneLine(String(r.summary_zh ?? '')), ITEM_SUMMARY);
      return {
        id: Number(r.id),
        url: String(r.url),
        title,
        summary,
        published_at: Number(r.published_at),
        source: String(r.source),
        importance: Number(r.importance ?? 0),
        hay: `${title} ${String(r.title)} ${summary}`.toLowerCase(),
      };
    });
}

const STOP = new Set(['the', 'and', 'for', 'new', 'with', 'from', 'that', 'this', 'into', 'over', 'about', 'using', 'based', 'are', 'was', 'not', 'use', 'how', 'what', 'why', 'can', 'its', 'has', 'have', 'will', 'more', 'than']);
const MIN_HITS = 2;

/** 切词：英文取整词（去常见虚词、长词去掉复数 s），中文取相邻两字；用于粗筛，真正的相关性由模型判断 */
function tokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(/\p{Script=Han}+|[a-z0-9]+/gu)) {
    const t = m[0];
    if (/^\p{Script=Han}/u.test(t)) {
      const cps = [...t];
      if (cps.length === 2) out.push(t);
      for (let i = 0; i + 2 <= cps.length && cps.length > 2; i++) out.push(cps.slice(i, i + 2).join(''));
    } else if (t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t)) {
      out.push(t.length >= 5 && t.endsWith('s') ? t.slice(0, -1) : t);
    }
  }
  return out;
}

/** 领域关键词：领域名在前，再加各页面标题，最多 150 个 */
function domainTerms(d: Domain): string[] {
  const out = new Set<string>();
  for (const t of [d.title, ...d.pages.slice(0, 40).map((p) => p.title)]) {
    for (const x of tokens(t)) {
      if (out.size >= 150) return [...out];
      out.add(x);
    }
  }
  return [...out];
}

/** 与领域相关的情报：至少命中 2 个不同的关键词，按命中数与重要度排序，取前 trendItems 条 */
export function pickItems(pool: Pooled[], d: Domain): Pooled[] {
  const terms = domainTerms(d);
  if (!terms.length) return [];
  return pool
    .map((it) => ({ it, score: terms.reduce((n, t) => n + (it.hay.includes(t) ? 1 : 0), 0) }))
    .filter((x) => x.score >= MIN_HITS)
    .sort((a, b) => b.score - a.score || b.it.importance - a.it.importance || b.it.published_at - a.it.published_at)
    .slice(0, WIKI_LIMITS.trendItems)
    .map((x) => x.it);
}

/** 「依据」小节：只列出被正文或 evidence 用到的情报，编号与提示词里一致；标题与来源名都过滤方括号 */
function sourcesBlock(items: Pooled[], used: Set<number>): string {
  const lines = [...used]
    .sort((a, b) => a - b)
    .map((n) => `${n}. ${plain(items[n - 1].title)} · ${plain(items[n - 1].source)} · ${ymd(items[n - 1].published_at)} · ${items[n - 1].url}`);
  return lines.length ? `\n\n## 依据\n${lines.join('\n')}` : '';
}

export interface TrendResult {
  changes: PageChange[];
  llmCalls: number;
  note: string;
}

export async function generateTrends(db: DB, llm: Llm, opId: number, o: { now?: number } = {}): Promise<TrendResult> {
  const now = o.now ?? Date.now();
  const calls = new Calls(llm);
  const pool = loadPool(db, now);
  const skipped: string[] = [];
  const failed: string[] = [];
  const drafts: (PageDraft & { node: number })[] = [];
  let firstError: unknown = null;

  // 没有趋势页的领域优先，其次是趋势页最久没更新的：领域多于单次上限时轮流覆盖
  const age = (d: Domain): number => {
    const r = getPageRow(db, trendSlug(d.title));
    return r && !r.deleted ? r.updated_at : -1;
  };
  const domains = trendDomains(db)
    .map((d) => ({ d, age: age(d) }))
    .sort((x, y) => x.age - y.age)
    .map((x) => x.d);
  for (const d of domains) {
    const slug = trendSlug(d.title);
    if (!slug) continue;
    if (d.pages.length < WIKI_LIMITS.trendMinPages) {
      skipped.push(`${d.title}（页面不足）`);
      continue;
    }
    const items = pickItems(pool, d);
    if (items.length < WIKI_LIMITS.trendMinItems) {
      skipped.push(`${d.title}（近 ${WIKI_LIMITS.trendDays} 天相关情报不足）`);
      continue;
    }
    if (calls.n >= WIKI_LIMITS.trendCalls) {
      skipped.push(`${d.title}（本次调用已达上限）`);
      continue;
    }
    const prev = getPageRow(db, slug);
    const previous = prev && !prev.deleted ? cp(prev.body.replace(/\n## 依据[\s\S]*$/, ''), PREVIOUS_MAX) : '';
    const view: TrendItem[] = items.map((it, i) => ({ n: i + 1, date: ymd(it.published_at), source: it.source, title: it.title, summary: it.summary }));
    try {
      const out = await calls.json<Record<string, unknown>>(trendPrompt(d.title, d.pages.slice(0, WIKI_LIMITS.trendPages), view, previous, ymd(now)), 8000, true);
      const text = typeof out.body === 'string' ? out.body.trim() : '';
      if (!text) throw new Error('模型没有写出正文');
      const used = new Set<number>();
      const mark = (v: unknown) => {
        if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= items.length) used.add(v);
      };
      if (Array.isArray(out.evidence)) out.evidence.forEach(mark);
      for (const m of text.matchAll(/\[(\d{1,3})\]/g)) mark(Number(m[1]));
      drafts.push({
        slug,
        kind: 'trend',
        title: `趋势：${cp(d.title, 60)}`,
        summary: str(out.summary, WIKI_LIMITS.summaryChars) || `${d.title}领域的趋势判断`,
        body: text + sourcesBlock(items, used),
        node: d.id,
      });
    } catch (e) {
      failed.push(d.title);
      firstError ??= e;
    }
  }

  if (!drafts.length && failed.length) throw firstError instanceof Error ? firstError : new Error('趋势生成失败');

  return tx(db, () => {
    const { changes, dropped } = drafts.length ? writePages(db, opId, drafts, { now }) : { changes: [] as PageChange[], dropped: [] as string[] };
    for (const d of drafts) {
      const row = getPageRow(db, d.slug);
      // 放进所属领域并固定位置：整理目录不会把它挪走
      if (row) placePage(db, row.id, d.node, { manual: true });
    }
    const notes = [drafts.length ? `生成 ${drafts.length} 个领域的趋势页` : '没有够格的领域（需要页面与近期情报都足够）'];
    if (failed.length) notes.push(`失败：${failed.join('、')}`);
    if (skipped.length) notes.push(`跳过：${skipped.join('、')}`);
    if (dropped.length) notes.push(`已删除 ${dropped.length} 处无效引用`);
    const note = notes.join('。');
    finishOp(db, opId, { status: 'done', pages: changes, note, llmCalls: calls.n, now });
    return { changes, llmCalls: calls.n, note };
  });
}
