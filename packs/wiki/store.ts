// Wiki 存储：页面、版本、链接、引用、操作记录。写函数不自己开事务，调用方用 tx() 包起来
import type { DB } from '../../packages/core/db.ts';
import { ftsSegments } from '../memory/context.ts';
import { normalizeBody, parseBody, slugify } from './parse.ts';
import type { Cite } from './parse.ts';
import { WIKI_LIMITS, WikiError, isPageKind } from './types.ts';
import type { OpKind, OpStatus, PageKind } from './types.ts';

export interface PageRow {
  id: number;
  slug: string;
  kind: PageKind;
  title: string;
  summary: string;
  body: string;
  source_doc: number | null;
  edited_by_user: 0 | 1;
  deleted: 0 | 1;
  rev: number;
  created_at: number;
  updated_at: number;
}

export interface PageChange {
  page_id: number;
  slug: string;
  from_rev: number;
  to_rev: number;
}

export interface PageDraft {
  slug: string;
  kind: PageKind;
  title: string;
  summary: string;
  body: string;
  sourceDoc?: number;
}

export interface OpRow {
  id: number;
  kind: OpKind;
  doc_id: number | null;
  target_op: number | null;
  status: OpStatus;
  pages: PageChange[];
  note: string;
  error: string | null;
  llm_calls: number;
  created_at: number;
  finished_at: number | null;
}

export type PageBrief = Pick<PageRow, 'id' | 'slug' | 'kind' | 'title' | 'summary' | 'updated_at'>;
export interface PageView extends PageRow {
  backlinks: { slug: string; title: string }[];
  cites: { doc: number; ord: number; title: string; heading: string; valid: boolean }[];
}

const TRUNC_NOTE = '\n\n> （内容过长已截断）';
const cp = (s: string) => [...s];
const clip = (s: string, n: number) => {
  const a = cp(s);
  return a.length > n ? a.slice(0, n).join('') : s;
};

const depth = new WeakMap<DB, number>();
/** 可嵌套的事务：只有最外层真正 BEGIN / COMMIT */
export function tx<T>(db: DB, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  if (d > 0) {
    depth.set(db, d + 1);
    try {
      return fn();
    } finally {
      depth.set(db, d);
    }
  }
  db.exec('BEGIN');
  depth.set(db, 1);
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth.set(db, 0);
  }
}

// ---------------- 操作记录 ----------------

export function createOp(db: DB, kind: OpKind, o: { docId?: number; targetOp?: number; status?: OpStatus; now?: number } = {}): number {
  return Number(
    db
      .prepare('INSERT INTO wiki_ops(kind, doc_id, target_op, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(kind, o.docId ?? null, o.targetOp ?? null, o.status ?? 'queued', o.now ?? Date.now()).lastInsertRowid,
  );
}

/** queued → running；不是 queued 时返回 false */
export function startOp(db: DB, id: number): boolean {
  return Number(db.prepare("UPDATE wiki_ops SET status = 'running' WHERE id = ? AND status = 'queued'").run(id).changes) > 0;
}

export function finishOp(
  db: DB,
  id: number,
  o: { status: 'done' | 'error'; pages?: PageChange[]; note?: string; error?: string; llmCalls?: number; now?: number },
): void {
  db.prepare('UPDATE wiki_ops SET status = ?, pages = ?, note = ?, error = ?, llm_calls = ?, finished_at = ? WHERE id = ?').run(
    o.status,
    JSON.stringify(o.pages ?? []),
    o.note ?? '',
    o.error ?? null,
    o.llmCalls ?? 0,
    o.now ?? Date.now(),
    id,
  );
}

const toOp = (r: Record<string, unknown>): OpRow => {
  let pages: PageChange[] = [];
  try {
    const v = JSON.parse(String(r.pages ?? '[]')) as unknown;
    if (Array.isArray(v)) pages = v as PageChange[];
  } catch {
    // 损坏的记录按无改动处理
  }
  return {
    id: Number(r.id),
    kind: r.kind as OpKind,
    doc_id: r.doc_id == null ? null : Number(r.doc_id),
    target_op: r.target_op == null ? null : Number(r.target_op),
    status: r.status as OpStatus,
    pages,
    note: String(r.note ?? ''),
    error: r.error == null ? null : String(r.error),
    llm_calls: Number(r.llm_calls ?? 0),
    created_at: Number(r.created_at),
    finished_at: r.finished_at == null ? null : Number(r.finished_at),
  };
};

export function getOp(db: DB, id: number): OpRow | null {
  const r = db.prepare('SELECT * FROM wiki_ops WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? toOp(r) : null;
}

export function listOps(db: DB, o: { before?: number; limit: number; includeAsk?: boolean }): OpRow[] {
  const rows = db
    .prepare(`SELECT * FROM wiki_ops WHERE id < ? ${o.includeAsk ? '' : "AND kind != 'ask'"} ORDER BY id DESC LIMIT ?`)
    .all(o.before ?? Number.MAX_SAFE_INTEGER, o.limit) as Record<string, unknown>[];
  return rows.map(toOp);
}

// ---------------- 页面写入 ----------------

const pageBySlug = (db: DB, slug: string) => db.prepare('SELECT * FROM wiki_pages WHERE slug = ?').get(slug) as PageRow | undefined;
const pageById = (db: DB, id: number) => db.prepare('SELECT * FROM wiki_pages WHERE id = ?').get(id) as PageRow | undefined;

export function citeValid(db: DB, doc: number, ord: number): boolean {
  return (
    db.prepare("SELECT 1 FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id WHERE c.doc_id = ? AND c.ord = ? AND d.status = 'ready'").get(doc, ord) != null
  );
}

function setRefs(db: DB, pageId: number, links: string[], cites: Cite[]): void {
  db.prepare('DELETE FROM wiki_links WHERE from_page = ?').run(pageId);
  db.prepare('DELETE FROM wiki_cites WHERE page_id = ?').run(pageId);
  const insL = db.prepare('INSERT OR IGNORE INTO wiki_links(from_page, to_slug) VALUES (?, ?)');
  for (const l of links) insL.run(pageId, l);
  const insC = db.prepare('INSERT OR IGNORE INTO wiki_cites(page_id, doc_id, ord) VALUES (?, ?, ?)');
  for (const c of cites) insC.run(pageId, c.doc, c.ord);
}

function addRevision(db: DB, pageId: number, rev: number, opId: number, p: { title: string; summary: string; body: string }, deleted: 0 | 1, now: number): void {
  db.prepare('INSERT INTO wiki_revisions(page_id, rev, op_id, title, summary, body, deleted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    pageId,
    rev,
    opId,
    p.title,
    p.summary,
    p.body,
    deleted,
    now,
  );
}

const livePages = (db: DB) => Number((db.prepare('SELECT count(*) AS n FROM wiki_pages WHERE deleted = 0').get() as { n: number }).n);

/** 写入一批页面（新建、更新或恢复已删除页）。同一批里重复的 slug 合并为一条改动记录 */
export function writePages(db: DB, opId: number, drafts: PageDraft[], o: { byUser?: boolean; now?: number } = {}): { changes: PageChange[]; dropped: string[] } {
  const now = o.now ?? Date.now();
  const changes = new Map<string, PageChange>();
  const dropped: string[] = [];
  for (const d of drafts) {
    if (!isPageKind(d.kind)) throw new WikiError(400, '页面类型不合法');
    const slug = slugify(String(d.slug ?? ''));
    if (!slug) throw new WikiError(400, '页面名称不合法');
    const title = clip(String(d.title ?? '').replace(/\s+/g, ' ').trim(), WIKI_LIMITS.titleChars);
    if (!title) throw new WikiError(400, '页面标题不能为空');
    const summary = clip(String(d.summary ?? '').replace(/\s+/g, ' ').trim(), WIKI_LIMITS.summaryChars);
    const norm = normalizeBody(String(d.body ?? '').replace(/\r\n?/g, '\n'), (doc, ord) => citeValid(db, doc, ord));
    dropped.push(...norm.dropped);
    let body = norm.body;
    if (cp(body).length > WIKI_LIMITS.bodyChars) body = clip(body, WIKI_LIMITS.bodyChars) + TRUNC_NOTE;
    const { links, cites } = parseBody(body);
    const old = pageBySlug(db, slug);
    let id: number;
    let from: number;
    let rev: number;
    if (!old) {
      if (livePages(db) >= WIKI_LIMITS.pages) throw new WikiError(400, `Wiki 最多 ${WIKI_LIMITS.pages} 页`);
      id = Number(
        db
          .prepare('INSERT INTO wiki_pages(slug, kind, title, summary, body, edited_by_user, rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)')
          .run(slug, d.kind, title, summary, body, o.byUser ? 1 : 0, now, now).lastInsertRowid,
      );
      from = 0;
      rev = 1;
    } else {
      if (old.deleted && livePages(db) >= WIKI_LIMITS.pages) throw new WikiError(400, `Wiki 最多 ${WIKI_LIMITS.pages} 页`);
      id = old.id;
      from = old.rev;
      rev = old.rev + 1;
      db.prepare('UPDATE wiki_pages SET kind = ?, title = ?, summary = ?, body = ?, deleted = 0, edited_by_user = ?, rev = ?, updated_at = ? WHERE id = ?').run(
        d.kind,
        title,
        summary,
        body,
        old.edited_by_user || o.byUser ? 1 : 0,
        rev,
        now,
        id,
      );
    }
    if (d.sourceDoc != null) {
      db.prepare('UPDATE wiki_pages SET source_doc = NULL WHERE source_doc = ? AND id != ?').run(d.sourceDoc, id);
      db.prepare('UPDATE wiki_pages SET source_doc = ? WHERE id = ?').run(d.sourceDoc, id);
    }
    addRevision(db, id, rev, opId, { title, summary, body }, 0, now);
    setRefs(db, id, links, cites);
    if (rev > WIKI_LIMITS.revisionsKept) pruneRevisions(db, id);
    const prev = changes.get(slug);
    changes.set(slug, { page_id: id, slug, from_rev: prev ? prev.from_rev : from, to_rev: rev });
  }
  return { changes: [...changes.values()], dropped };
}

/** 软删除：写一版 deleted=1，清掉链接、引用和全文索引；已删除时不做改动 */
export function softDelete(db: DB, opId: number, pageId: number, now = Date.now()): PageChange {
  const p = pageById(db, pageId);
  if (!p) throw new WikiError(404, '页面不存在');
  if (p.deleted) return { page_id: p.id, slug: p.slug, from_rev: p.rev, to_rev: p.rev };
  const rev = p.rev + 1;
  db.prepare('UPDATE wiki_pages SET deleted = 1, rev = ?, updated_at = ? WHERE id = ?').run(rev, now, p.id);
  addRevision(db, p.id, rev, opId, p, 1, now);
  setRefs(db, p.id, [], []);
  return { page_id: p.id, slug: p.slug, from_rev: p.rev, to_rev: rev };
}

/** 把指定版本的快照写成新版本；该版本是删除版时等同于软删除 */
export function restoreSnapshot(db: DB, opId: number, pageId: number, rev: number, now = Date.now()): PageChange {
  const p = pageById(db, pageId);
  if (!p) throw new WikiError(404, '页面不存在');
  const r = getRevision(db, pageId, rev);
  if (!r) throw new WikiError(404, '版本不存在');
  if (r.deleted) return softDelete(db, opId, pageId, now);
  const next = p.rev + 1;
  db.prepare('UPDATE wiki_pages SET title = ?, summary = ?, body = ?, deleted = 0, rev = ?, updated_at = ? WHERE id = ?').run(r.title, r.summary, r.body, next, now, p.id);
  addRevision(db, p.id, next, opId, r, 0, now);
  const { links, cites } = parseBody(r.body);
  setRefs(db, p.id, links, cites);
  return { page_id: p.id, slug: p.slug, from_rev: p.rev, to_rev: next };
}

// ---------------- 读取 ----------------

export function getPageRow(db: DB, slug: string): PageRow | null {
  return pageBySlug(db, slug) ?? null;
}

export function getPage(db: DB, slug: string): PageView | null {
  const p = pageBySlug(db, slug);
  if (!p || p.deleted) return null;
  const backlinks = db
    .prepare('SELECT p.slug, p.title FROM wiki_links l JOIN wiki_pages p ON p.id = l.from_page WHERE l.to_slug = ? AND p.deleted = 0 AND p.id != ? ORDER BY p.title')
    .all(slug, p.id) as { slug: string; title: string }[];
  const cites = (
    db
      .prepare(
        `SELECT c.doc_id AS doc, c.ord, coalesce(d.title, '') AS title, coalesce(ch.heading, '') AS heading,
                (d.status = 'ready' AND ch.id IS NOT NULL) AS valid
         FROM wiki_cites c LEFT JOIN kb_docs d ON d.id = c.doc_id LEFT JOIN kb_chunks ch ON ch.doc_id = c.doc_id AND ch.ord = c.ord
         WHERE c.page_id = ? ORDER BY c.doc_id, c.ord`,
      )
      .all(p.id) as { doc: number; ord: number; title: string; heading: string; valid: number | null }[]
  ).map((c) => ({ doc: Number(c.doc), ord: Number(c.ord), title: c.title, heading: c.heading, valid: Boolean(c.valid) }));
  return { ...p, backlinks: backlinks.map((b) => ({ slug: b.slug, title: b.title })), cites };
}

const ftsMatch = (terms: string[]) => terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');

export function listPages(db: DB, o: { kind?: PageKind; q?: string; limit?: number } = {}): PageBrief[] {
  const limit = o.limit ?? 500;
  const q = (o.q ?? '').trim().slice(0, 200);
  const kindSql = o.kind ? 'AND p.kind = ?' : '';
  const kindArg = o.kind ? [o.kind] : [];
  const cols = 'p.id, p.slug, p.kind, p.title, p.summary, p.updated_at';
  if (!q) {
    return db.prepare(`SELECT ${cols} FROM wiki_pages p WHERE p.deleted = 0 ${kindSql} ORDER BY p.updated_at DESC LIMIT ?`).all(...kindArg, limit) as unknown as PageBrief[];
  }
  const segs = ftsSegments(q);
  if (segs.length) {
    try {
      return db
        .prepare(`SELECT ${cols} FROM wiki_fts JOIN wiki_pages p ON p.id = wiki_fts.rowid WHERE wiki_fts MATCH ? AND p.deleted = 0 ${kindSql} ORDER BY bm25(wiki_fts) LIMIT ?`)
        .all(ftsMatch(segs), ...kindArg, limit) as unknown as PageBrief[];
    } catch {
      // 查询语法异常时退回 LIKE
    }
  }
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db
    .prepare(
      `SELECT ${cols} FROM wiki_pages p WHERE p.deleted = 0 ${kindSql} AND (p.title LIKE ? ESCAPE '\\' OR p.summary LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\') ORDER BY p.updated_at DESC LIMIT ?`,
    )
    .all(...kindArg, like, like, like, limit) as unknown as PageBrief[];
}

export type CatalogEntry = { slug: string; kind: PageKind; title: string; summary: string };

/** 页面目录：三元组检索前 limit 页，加上全部总览页 */
export function catalog(db: DB, terms: string[], limit: number): CatalogEntry[] {
  const out = new Map<string, CatalogEntry>();
  if (terms.length) {
    try {
      const rows = db
        .prepare('SELECT p.slug, p.kind, p.title, p.summary FROM wiki_fts JOIN wiki_pages p ON p.id = wiki_fts.rowid WHERE wiki_fts MATCH ? AND p.deleted = 0 ORDER BY bm25(wiki_fts) LIMIT ?')
        .all(ftsMatch(terms), limit) as CatalogEntry[];
      for (const r of rows) out.set(r.slug, { slug: r.slug, kind: r.kind, title: r.title, summary: r.summary });
    } catch {
      // 忽略查询异常，只返回总览页
    }
  }
  for (const r of db.prepare("SELECT slug, kind, title, summary FROM wiki_pages WHERE kind = 'overview' AND deleted = 0 ORDER BY updated_at DESC LIMIT 50").all() as CatalogEntry[]) {
    if (!out.has(r.slug)) out.set(r.slug, { slug: r.slug, kind: r.kind, title: r.title, summary: r.summary });
  }
  return [...out.values()];
}

export interface RevisionRow {
  page_id: number;
  rev: number;
  op_id: number | null;
  title: string;
  summary: string;
  body: string;
  deleted: 0 | 1;
  created_at: number;
}

export function listRevisions(db: DB, pageId: number): Omit<RevisionRow, 'body' | 'summary'>[] {
  return db
    .prepare('SELECT page_id, rev, op_id, title, deleted, created_at FROM wiki_revisions WHERE page_id = ? ORDER BY rev DESC')
    .all(pageId) as unknown as Omit<RevisionRow, 'body' | 'summary'>[];
}

export function getRevision(db: DB, pageId: number, rev: number): RevisionRow | null {
  return (db.prepare('SELECT * FROM wiki_revisions WHERE page_id = ? AND rev = ?').get(pageId, rev) as RevisionRow | undefined) ?? null;
}

/** 只有最近这么多条操作引用的版本受保护；更早的操作撤销时会报告「历史版本已清理」 */
export const OPS_PROTECTED = 200;

/** 只保留最近 revisionsKept 个版本，以及最近 OPS_PROTECTED 条操作引用到的版本 */
export function pruneRevisions(db: DB, pageId: number): number {
  const keep = new Set<number>(
    (db.prepare('SELECT rev FROM wiki_revisions WHERE page_id = ? ORDER BY rev DESC LIMIT ?').all(pageId, WIKI_LIMITS.revisionsKept) as { rev: number }[]).map((r) => Number(r.rev)),
  );
  const refs = db
    .prepare(
      `SELECT json_extract(j.value, '$.from_rev') AS f, json_extract(j.value, '$.to_rev') AS t
       FROM wiki_ops o, json_each(o.pages) j
       WHERE o.id > (SELECT coalesce(max(id), 0) FROM wiki_ops) - ? AND json_valid(o.pages) AND json_extract(j.value, '$.page_id') = ?`,
    )
    .all(OPS_PROTECTED, pageId) as { f: number | null; t: number | null }[];
  for (const r of refs) {
    if (r.f != null) keep.add(Number(r.f));
    if (r.t != null) keep.add(Number(r.t));
  }
  const all = (db.prepare('SELECT rev FROM wiki_revisions WHERE page_id = ?').all(pageId) as { rev: number }[]).map((r) => Number(r.rev));
  const del = db.prepare('DELETE FROM wiki_revisions WHERE page_id = ? AND rev = ?');
  let n = 0;
  for (const rev of all) {
    if (!keep.has(rev)) {
      del.run(pageId, rev);
      n++;
    }
  }
  return n;
}
