// 单份资料的摄入：找候选页 → 规划 → 分批撰写 → 校验 → 一个事务提交。失败时不写入任何页面
import crypto from 'node:crypto';
import type { DB } from '../../packages/core/db.ts';
import { LlmError } from '../../packages/core/llm.ts';
import type { ChatMessage, Llm } from '../../packages/core/llm.ts';
import { recallTerms } from '../kb/search.ts';
import { slugify } from './parse.ts';
import { digestPrompt, generatePrompt, planPrompt, renderChunks, writePrompt } from './prompts.ts';
import type { SrcChunk, WriteTarget } from './prompts.ts';
import { catalog, citeValid, finishOp, getPageRow, tx, writePages } from './store.ts';
import type { CatalogEntry, PageChange, PageDraft } from './store.ts';
import { placeIngested, renderTree } from './tree.ts';
import { WIKI_LIMITS, WikiError } from './types.ts';
import type { PageKind } from './types.ts';

export interface IngestResult {
  changes: PageChange[];
  llmCalls: number;
  note: string;
}

const WRITE_SRC_BUDGET = 24_000;
const len = (s: string) => [...s].length;

export const srcSlug = (docId: number) => `src-${docId}`;

export function loadChunks(db: DB, docId: number): SrcChunk[] {
  const rows = db.prepare('SELECT ord, heading, body FROM kb_chunks WHERE doc_id = ? ORDER BY ord').all(docId) as { ord: number; heading: string; body: string }[];
  return rows.map((c) => ({ doc: docId, ord: Number(c.ord), heading: c.heading, body: c.body }));
}

export function docHash(db: DB, docId: number): string {
  const h = crypto.createHash('sha256');
  for (const c of loadChunks(db, docId)) h.update(`${c.ord}\u0001${c.heading}\u0001${c.body}\u0002`);
  return h.digest('hex').slice(0, 16);
}

export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

/** 统计调用次数的模型包装；JSON 无法解析时重试一次 */
export class Calls {
  n = 0;
  private readonly llm: Llm;
  constructor(llm: Llm) {
    this.llm = llm;
  }
  async text(msgs: ChatMessage[], maxTokens: number): Promise<string> {
    this.n++;
    return this.llm.chat(msgs, { maxTokens });
  }
  async json<T>(msgs: ChatMessage[], maxTokens: number, long = false): Promise<T> {
    for (let i = 0; i < 2; i++) {
      this.n++;
      const raw = long ? (await this.llm.chatLong(msgs, { json: true, maxTokens })).content : await this.llm.chat(msgs, { json: true, maxTokens });
      const v = parseJson(raw);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as T;
    }
    throw new LlmError('模型未返回合法 JSON');
  }
}

export const str = (v: unknown, max = 200): string => (typeof v === 'string' ? [...v.trim()].slice(0, max).join('') : '');

const ordsOf = (v: unknown, valid: Set<number>): number[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is number => Number.isSafeInteger(x) && valid.has(x as number)))].slice(0, 40) : [];

/** 把分段按顺序分成 k 份，每份大约 total/k 字 */
function splitParts(chunks: SrcChunk[], total: number): SrcChunk[][] {
  const k = Math.ceil(total / WIKI_LIMITS.chunkPart);
  const target = total / k;
  const parts: SrcChunk[][] = [[]];
  let size = 0;
  for (const c of chunks) {
    if (size >= target && parts.length < k) {
      parts.push([]);
      size = 0;
    }
    parts[parts.length - 1].push(c);
    size += len(c.body);
  }
  return parts;
}

/** 按 ords 取分段，累计不超过 budget 字；want 为空时按顺序取 */
function pickChunks(chunks: SrcChunk[], want: Set<number>, budget: number): SrcChunk[] {
  const out: SrcChunk[] = [];
  let used = 0;
  for (const c of chunks) {
    if (want.size && !want.has(c.ord)) continue;
    const l = len(c.body);
    if (used + l > budget && out.length) break;
    out.push(c);
    used += l;
  }
  return out;
}

interface PlanPage {
  slug: string;
  kind: PageKind;
  title: string;
  reason: string;
  ords: number[];
  /** 模型给的分类路径，未校验；能不能用由 tree.ts 的 cleanPath 决定 */
  path: unknown;
}

const PLAN_KINDS: ReadonlySet<string> = new Set(['entity', 'concept', 'compare', 'overview']);

function readPlan(raw: Record<string, unknown>, docTitle: string, valid: Set<number>): { source: { title: string; summary: string }; pages: PlanPage[]; conflicts: string[] } {
  const s = (raw.source && typeof raw.source === 'object' ? raw.source : {}) as Record<string, unknown>;
  const pages: PlanPage[] = [];
  const seen = new Set<string>();
  for (const p of Array.isArray(raw.pages) ? (raw.pages as Record<string, unknown>[]) : []) {
    if (!p || typeof p !== 'object') continue;
    const title = str(p.title, WIKI_LIMITS.titleChars);
    const slug = slugify(str(p.slug) || title);
    if (!slug || slug.startsWith('src-') || seen.has(slug)) continue;
    seen.add(slug);
    const kind = (PLAN_KINDS.has(String(p.kind)) ? p.kind : 'concept') as PageKind;
    pages.push({ slug, kind, title: title || slug, reason: str(p.reason), ords: ordsOf(p.ords, valid), path: p.path });
    if (pages.length >= WIKI_LIMITS.ingestPages - 1) break;
  }
  const conflicts = (Array.isArray(raw.conflicts) ? (raw.conflicts as Record<string, unknown>[]) : [])
    .map((c) => (c && typeof c === 'object' ? `${str(c.slug, 80)}：${str(c.claim, 200)}` : ''))
    .filter((x) => x.length > 1)
    .slice(0, 10);
  return { source: { title: str(s.title, WIKI_LIMITS.titleChars) || docTitle, summary: str(s.summary) }, pages, conflicts };
}

/** 给本次写入的页面落位；整体出错时回滚到 SAVEPOINT，全部记为未能分类 */
function placeInSavepoint(db: DB, drafts: PageDraft[], planned: PlanPage[], now: number): { placed: number; failed: string[] } {
  const path = new Map(planned.map((p) => [p.slug, p.path]));
  const items = drafts.map((d) => ({ slug: d.slug, kind: d.kind, path: path.get(d.slug) }));
  db.exec('SAVEPOINT place_pages');
  try {
    const r = placeIngested(db, items, now);
    db.exec('RELEASE place_pages');
    return r;
  } catch {
    db.exec('ROLLBACK TO place_pages');
    db.exec('RELEASE place_pages');
    return { placed: 0, failed: items.map((i) => i.slug) };
  }
}

/** 防截断：已有页面的新正文不到旧正文一半时，保留旧正文，把新内容追加到末尾 */
function guardShrink(current: string, next: string): string {
  if (!current.trim() || len(next) * 2 >= len(current)) return next;
  return `${current.trimEnd()}\n\n## 新增信息\n${next.trim()}`;
}

export async function ingestDoc(db: DB, llm: Llm, opId: number, docId: number, o: { now?: number } = {}): Promise<IngestResult> {
  const doc = db.prepare('SELECT id, title, status FROM kb_docs WHERE id = ?').get(docId) as { id: number; title: string; status: string } | undefined;
  if (!doc) throw new WikiError(404, '资料不存在');
  if (doc.status !== 'ready') throw new WikiError(409, '资料尚未就绪');
  const chunks = loadChunks(db, docId);
  if (!chunks.length) throw new WikiError(409, '资料没有正文');
  const valid = new Set(chunks.map((c) => c.ord));
  const calls = new Calls(llm);
  const hash = docHash(db, docId);
  const sslug = srcSlug(docId);

  // 1. 候选页
  const terms = recallTerms(`${doc.title} ${chunks.map((c) => c.heading).filter(Boolean).join(' ')}`);
  const cat: CatalogEntry[] = catalog(db, terms, WIKI_LIMITS.candidates);
  const srcPage = getPageRow(db, sslug);
  if (srcPage && !srcPage.deleted && !cat.some((c) => c.slug === sslug)) cat.push({ slug: sslug, kind: srcPage.kind, title: srcPage.title, summary: srcPage.summary });

  // 2. 规划（超长资料先分块提炼要点）
  const total = chunks.reduce((s, c) => s + len(c.body), 0);
  let digest = '';
  if (total > WIKI_LIMITS.chunkLimit) {
    const parts = splitParts(chunks, total);
    const outs: string[] = [];
    for (let i = 0; i < parts.length; i++) outs.push((await calls.text(digestPrompt(doc.title, renderChunks(parts[i]), i, parts.length), 3000)).trim());
    digest = outs.join('\n\n');
  }
  const rawPlan = await calls.json<Record<string, unknown>>(planPrompt(doc, digest || renderChunks(chunks), cat, Boolean(digest), renderTree(db)), 4000);
  const plan = readPlan(rawPlan, doc.title, valid);

  // 3. 分批撰写，资料摘要页在第一批
  const current = (slug: string) => {
    const p = getPageRow(db, slug);
    return p && !p.deleted ? p.body : '';
  };
  // 规划只能选 entity/concept/compare/overview；已有的问答页等其他类型保留原类型
  const keepKind = (p: PlanPage): PageKind => {
    const old = getPageRow(db, p.slug);
    return old && !old.deleted && !PLAN_KINDS.has(old.kind) ? old.kind : p.kind;
  };
  const targets: (WriteTarget & { kind: PageKind })[] = [
    { slug: sslug, kind: 'source', title: plan.source.title, reason: '这份资料的摘要页', current: current(sslug), ords: [] },
    ...plan.pages.map((p) => ({ ...p, kind: keepKind(p), current: current(p.slug) })),
  ];
  const drafts: PageDraft[] = [];
  for (let i = 0; i < targets.length; i += WIKI_LIMITS.writeBatch) {
    const batch = targets.slice(i, i + WIKI_LIMITS.writeBatch);
    const hasSource = batch.some((t) => t.kind === 'source');
    const want = hasSource ? new Set<number>() : new Set(batch.flatMap((t) => t.ords));
    const out = await calls.json<{ pages?: unknown }>(writePrompt(doc, batch, pickChunks(chunks, want, WRITE_SRC_BUDGET), hasSource ? digest : ''), 16_000, true);
    const got = new Map<string, Record<string, unknown>>();
    for (const p of Array.isArray(out.pages) ? (out.pages as Record<string, unknown>[]) : []) {
      if (p && typeof p === 'object') got.set(slugify(str(p.slug, 200)), p);
    }
    for (const t of batch) {
      const p = got.get(t.slug);
      const body = typeof p?.body === 'string' ? p.body : '';
      if (!p || !body.trim()) continue;
      drafts.push({
        slug: t.slug,
        kind: t.kind,
        title: str(p.title, WIKI_LIMITS.titleChars) || t.title,
        summary: str(p.summary, WIKI_LIMITS.summaryChars) || (t.kind === 'source' ? plan.source.summary : ''),
        body: guardShrink(t.current, body),
        ...(t.kind === 'source' ? { sourceDoc: docId } : {}),
      });
    }
  }
  if (!drafts.length) throw new LlmError('模型没有写出任何页面');

  // 4–5. 校验并在一个事务里提交
  const now = o.now ?? Date.now();
  return tx(db, () => {
    const { changes, dropped } = writePages(db, opId, drafts, { now });
    // 分类只影响侧栏位置，出错不能连累页面与摄入结果：放进 SAVEPOINT，失败只回滚这一步
    const placed = placeInSavepoint(db, drafts, plan.pages, now);
    const notes = [`编入《${doc.title}》：改动 ${changes.length} 页`];
    if (placed.failed.length) notes.push(`${placed.failed.length} 个页面未能分类`);
    if (dropped.length) notes.push(`已删除 ${dropped.length} 处无效引用`);
    if (plan.conflicts.length) notes.push(`可能的矛盾：${plan.conflicts.join('；')}`);
    const note = notes.join('。');
    finishOp(db, opId, { status: 'done', pages: changes, note, llmCalls: calls.n, now });
    db.prepare(
      `INSERT INTO wiki_docs(doc_id, body_hash, state, fails, ingested_at) VALUES (?, ?, 'done', 0, ?)
       ON CONFLICT(doc_id) DO UPDATE SET body_hash = excluded.body_hash, state = 'done', fails = 0, ingested_at = excluded.ingested_at`,
    ).run(docId, hash, now);
    return { changes, llmCalls: calls.n, note };
  });
}

/** 取若干页面引用的原文分段（只取仍然有效的），累计不超过 budget 字 */
export function citedChunks(db: DB, pageIds: number[], budget: number): SrcChunk[] {
  if (!pageIds.length) return [];
  const cites = db
    .prepare(`SELECT DISTINCT doc_id AS doc, ord FROM wiki_cites WHERE page_id IN (${pageIds.map(() => '?').join(',')}) ORDER BY doc_id, ord`)
    .all(...pageIds) as { doc: number; ord: number }[];
  const out: SrcChunk[] = [];
  let used = 0;
  for (const c of cites) {
    if (!citeValid(db, Number(c.doc), Number(c.ord))) continue;
    const ch = db.prepare('SELECT heading, body FROM kb_chunks WHERE doc_id = ? AND ord = ?').get(c.doc, c.ord) as { heading: string; body: string };
    if (used + len(ch.body) > budget && out.length) break;
    out.push({ doc: Number(c.doc), ord: Number(c.ord), heading: ch.heading, body: ch.body });
    used += len(ch.body);
  }
  return out;
}

/** 生成缺页：依据链接到它的页面所引用的原文 */
export async function generatePage(db: DB, llm: Llm, opId: number, rawSlug: string, o: { now?: number } = {}): Promise<IngestResult> {
  const slug = slugify(rawSlug);
  if (!slug) throw new WikiError(400, '页面名称不合法');
  const exists = getPageRow(db, slug);
  if (exists && !exists.deleted) throw new WikiError(409, '页面已存在');
  const refs = db
    .prepare('SELECT DISTINCT p.id, p.title, p.summary FROM wiki_links l JOIN wiki_pages p ON p.id = l.from_page WHERE l.to_slug = ? AND p.deleted = 0 LIMIT 20')
    .all(slug) as { id: number; title: string; summary: string }[];
  if (!refs.length) throw new WikiError(400, '没有可依据的资料');
  const chunks = citedChunks(
    db,
    refs.map((r) => Number(r.id)),
    WIKI_LIMITS.askSrcBudget,
  );
  if (!chunks.length) throw new WikiError(400, '没有可依据的资料');
  const calls = new Calls(llm);
  const label = exists?.title || rawSlug.trim() || slug;
  const out = await calls.json<Record<string, unknown>>(generatePrompt(slug, label, chunks, refs), 8000, true);
  const body = typeof out.body === 'string' ? out.body : '';
  if (!body.trim()) throw new LlmError('模型没有写出正文');
  const kind = (['entity', 'concept', 'compare'].includes(String(out.kind)) ? out.kind : 'concept') as PageKind;
  const now = o.now ?? Date.now();
  return tx(db, () => {
    const draft: PageDraft = { slug, kind, title: str(out.title, WIKI_LIMITS.titleChars) || label, summary: str(out.summary), body };
    const { changes, dropped } = writePages(db, opId, [draft], { now });
    const note = `生成页面「${draft.title}」${dropped.length ? `。已删除 ${dropped.length} 处无效引用` : ''}`;
    finishOp(db, opId, { status: 'done', pages: changes, note, llmCalls: calls.n, now });
    return { changes, llmCalls: calls.n, note };
  });
}
