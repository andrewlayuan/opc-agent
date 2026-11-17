// 向 Wiki 提问：先选页，再依据页面和它们引用的原文回答；好的回答可存为问答页
import type { DB } from '../../packages/core/db.ts';
import type { Llm } from '../../packages/core/llm.ts';
import { recallTerms } from '../kb/search.ts';
import { Calls, citedChunks, str } from './ingest.ts';
import { CITE_RE, slugify } from './parse.ts';
import { answerPrompt, selectPrompt } from './prompts.ts';
import { catalog, createOp, finishOp, getPage, getPageRow, listPages, tx, writePages } from './store.ts';
import type { PageView } from './store.ts';
import { WIKI_LIMITS, WikiError } from './types.ts';

export const EMPTY_ANSWER = '知识库 Wiki 还没有内容，先在「资料」里编入一些资料吧。';

export interface AskResult {
  answer: string;
  pages: { slug: string; title: string }[];
  cites: { doc: number; ord: number; title: string; heading: string }[];
  opId: number;
}

function cleanQuestion(raw: unknown): string {
  const q = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!q) throw new WikiError(400, '问题不能为空');
  if ([...q].length > WIKI_LIMITS.questionChars) throw new WikiError(400, `问题最多 ${WIKI_LIMITS.questionChars} 字`);
  return q;
}

export async function askWiki(db: DB, llm: Llm, question: unknown, o: { usedToday?: () => number; limit?: number } = {}): Promise<AskResult> {
  const q = cleanQuestion(question);
  if (o.usedToday && o.limit != null && o.usedToday() >= o.limit) throw new WikiError(429, '今日额度已用完');
  if (!db.prepare('SELECT 1 FROM wiki_pages WHERE deleted = 0 LIMIT 1').get()) return { answer: EMPTY_ANSWER, pages: [], cites: [], opId: 0 };
  const cat = catalog(db, recallTerms(q), WIKI_LIMITS.askIndex);
  // 检索命中不足时用最近更新的页面补足目录，小规模 Wiki 等于给出完整目录
  if (cat.length < WIKI_LIMITS.askIndex) {
    const have = new Set(cat.map((c) => c.slug));
    for (const p of listPages(db, { limit: WIKI_LIMITS.askIndex })) {
      if (cat.length >= WIKI_LIMITS.askIndex) break;
      if (!have.has(p.slug)) cat.push({ slug: p.slug, kind: p.kind, title: p.title, summary: p.summary });
    }
  }
  const calls = new Calls(llm);
  const opId = createOp(db, 'ask', { status: 'running' });
  try {
    let slugs: string[] = [];
    if (cat.length) {
      const sel = await calls.json<{ slugs?: unknown }>(selectPrompt(q, cat), 800);
      const known = new Set(cat.map((c) => c.slug));
      slugs = (Array.isArray(sel.slugs) ? sel.slugs : []).map((s) => slugify(String(s))).filter((s) => known.has(s));
      slugs = [...new Set(slugs)].slice(0, 5);
      if (!slugs.length) slugs = cat.slice(0, 3).map((c) => c.slug);
    }
    const pages = slugs.map((s) => getPage(db, s)).filter((p): p is PageView => p != null);
    const chunks = citedChunks(
      db,
      pages.map((p) => p.id),
      WIKI_LIMITS.askSrcBudget,
    );
    const answer = (await calls.text(answerPrompt(q, pages, chunks), 3000)).trim();
    const seen = new Set<string>();
    const cites: AskResult['cites'] = [];
    for (const m of answer.matchAll(CITE_RE)) {
      const k = `${m[1]}:${m[2]}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const r = db
        .prepare('SELECT d.title, c.heading FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id WHERE c.doc_id = ? AND c.ord = ?')
        .get(Number(m[1]), Number(m[2])) as { title: string; heading: string } | undefined;
      if (r) cites.push({ doc: Number(m[1]), ord: Number(m[2]), title: r.title, heading: r.heading });
    }
    finishOp(db, opId, { status: 'done', llmCalls: calls.n, note: [...q].slice(0, 100).join('') });
    return { answer, pages: pages.map((p) => ({ slug: p.slug, title: p.title })), cites, opId };
  } catch (e) {
    finishOp(db, opId, { status: 'error', llmCalls: calls.n, note: [...q].slice(0, 100).join(''), error: (e as Error).message });
    throw e;
  }
}

export function saveAnswer(db: DB, question: unknown, answer: unknown): { slug: string; opId: number } {
  const q = cleanQuestion(question);
  const a = typeof answer === 'string' ? answer.trim() : '';
  if (!a) throw new WikiError(400, '回答不能为空');
  const base = [...slugify(`q-${q}`)].slice(0, WIKI_LIMITS.slugMax - 4).join('').replace(/-+$/, '');
  let slug = base;
  for (let i = 2; getPageRow(db, slug); i++) slug = `${base}-${i}`;
  return tx(db, () => {
    const opId = createOp(db, 'query_save', { status: 'running' });
    const { changes } = writePages(db, opId, [{ slug, kind: 'answer', title: str(q, WIKI_LIMITS.titleChars), summary: str(q, 60), body: `## 问题\n${q}\n\n## 回答\n${a}` }]);
    finishOp(db, opId, { status: 'done', pages: changes, note: `存为问答页「${str(q, 40)}」` });
    return { slug, opId };
  });
}
