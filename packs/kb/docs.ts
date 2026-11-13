// 知识库条目：四类入库、正文分块、来源跟随最新版（refreshStale）
import type { DB } from '../../packages/core/db.ts';
import { chunkMarkdown } from './chunk.ts';
import { UNFILED, assertFolder, folderPaths } from './folders.ts';
import { KB_LIMITS, KbError, clipCp, len } from './types.ts';
import type { DocKind, DocStatus } from './types.ts';

export interface DocView {
  id: number;
  kind: DocKind;
  title: string;
  status: DocStatus;
  error: string | null;
  folder_id: number | null;
  path: string;
  review_id: number | null;
  item_id: number | null;
  file_name: string | null;
  file_size: number | null;
  truncated: boolean;
  created_at: number;
  updated_at: number;
}

interface DocRow {
  id: number;
  folder_id: number | null;
  kind: DocKind;
  title: string;
  status: DocStatus;
  error: string | null;
  body: string;
  review_id: number | null;
  item_id: number | null;
  file_name: string | null;
  file_size: number | null;
  storage: string | null;
  truncated: number;
  created_at: number;
  updated_at: number;
}

const NOT_FOUND = '条目不存在';
const COLS = 'id, folder_id, kind, title, status, error, body, review_id, item_id, file_name, file_size, storage, truncated, created_at, updated_at';
const num = (v: unknown) => (v == null ? null : Number(v));

function pathMap(db: DB): Map<number, string> {
  return new Map(folderPaths(db).map((f) => [f.id, f.path]));
}

export function toDocView(r: DocRow, paths: Map<number, string>): DocView {
  const folder = num(r.folder_id);
  return {
    id: Number(r.id),
    kind: r.kind,
    title: r.title,
    status: r.status,
    error: r.error,
    folder_id: folder,
    path: folder == null ? UNFILED : (paths.get(folder) ?? UNFILED),
    review_id: num(r.review_id),
    item_id: num(r.item_id),
    file_name: r.file_name,
    file_size: num(r.file_size),
    truncated: Boolean(r.truncated),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}

function row(db: DB, id: number): DocRow | undefined {
  return db.prepare(`SELECT ${COLS} FROM kb_docs WHERE id = ?`).get(id) as DocRow | undefined;
}

function mustRow(db: DB, id: number): DocRow {
  const r = row(db, id);
  if (!r) throw new KbError(404, NOT_FOUND);
  return r;
}

function cleanTitle(raw: unknown): string {
  const t = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!t || len(t) > KB_LIMITS.title) throw new KbError(400, `标题需为 1–${KB_LIMITS.title} 字`);
  return t;
}

function cleanBody(raw: unknown, kind: 'note' | 'upload'): string {
  if (raw !== undefined && typeof raw !== 'string') throw new KbError(400, '正文格式不正确');
  const b = typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n') : '';
  if (kind === 'note' && !b.trim()) throw new KbError(400, '笔记内容不能为空');
  if (len(b) > KB_LIMITS.bodyChars) throw new KbError(400, '正文最多 20 万字');
  return b;
}

function cleanFolder(db: DB, raw: unknown): number | null {
  if (raw == null) return null;
  if (!Number.isSafeInteger(raw) || (raw as number) <= 0) throw new KbError(400, '目录参数不合法');
  assertFolder(db, raw as number);
  return raw as number;
}

function assertCapacity(db: DB): void {
  const n = Number((db.prepare('SELECT count(*) AS n FROM kb_docs').get() as { n: number }).n);
  if (n >= KB_LIMITS.docs) throw new KbError(400, `知识库最多 ${KB_LIMITS.docs} 个条目`);
}

function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 重建分块（不改 body 列），状态置为 ready */
function reindex(db: DB, id: number, text: string, now: number): void {
  const { chunks, truncated } = chunkMarkdown(text);
  db.prepare('DELETE FROM kb_chunks WHERE doc_id = ?').run(id);
  const ins = db.prepare('INSERT INTO kb_chunks(doc_id, ord, heading, body) VALUES (?, ?, ?, ?)');
  chunks.forEach((c, i) => ins.run(id, i, c.heading, c.body));
  db.prepare("UPDATE kb_docs SET truncated = ?, status = 'ready', error = NULL, updated_at = ? WHERE id = ?").run(truncated ? 1 : 0, now, id);
}

const ITEM_REV = 'CAST(max(coalesce(i.translated_at, 0), coalesce(i.analyzed_at, 0), i.fetched_at) AS TEXT)';

export function sourceText(db: DB, kind: 'review' | 'item', id: number): { title: string; text: string; rev: string } | null {
  if (kind === 'review') {
    const r = db
      .prepare('SELECT r.input, v.n, v.content FROM pm_reviews r JOIN pm_versions v ON v.review_id = r.id WHERE r.id = ? ORDER BY v.n DESC LIMIT 1')
      .get(id) as { input: string; n: number; content: string } | undefined;
    if (!r) return null;
    return { title: clipCp(String(r.input).replace(/\s+/g, ' ').trim(), 40) || `评审 #${id}`, text: String(r.content), rev: String(r.n) };
  }
  const it = db
    .prepare(`SELECT i.title, i.title_zh, i.url, i.summary_zh, i.analysis_zh, i.translation_zh, i.content, ${ITEM_REV} AS rev FROM items i WHERE i.id = ?`)
    .get(id) as Record<string, string | null> | undefined;
  if (!it) return null;
  const title = clipCp((it.title_zh || it.title || `资讯 #${id}`).replace(/\s+/g, ' ').trim(), KB_LIMITS.title);
  const parts = [`# ${title}`, `来源：${it.url}`];
  if (it.summary_zh?.trim()) parts.push(`## 摘要\n${it.summary_zh.trim()}`);
  if (it.analysis_zh?.trim()) parts.push(`## 分析\n${it.analysis_zh.trim()}`);
  const body = (it.translation_zh || it.content || '').trim();
  if (body) parts.push(`## 正文\n${body}`);
  return { title, text: parts.join('\n\n'), rev: String(it.rev) };
}

export function findBySource(db: DB, src: { reviewId?: number; itemId?: number }): number | null {
  let r: unknown;
  if (src.reviewId != null) r = db.prepare('SELECT id FROM kb_docs WHERE review_id = ?').get(src.reviewId);
  else if (src.itemId != null) r = db.prepare('SELECT id FROM kb_docs WHERE item_id = ?').get(src.itemId);
  return r ? Number((r as { id: number }).id) : null;
}

/** 来源唯一约束冲突时转成 409，并带上已有条目 */
function dupGuard<T>(db: DB, src: { reviewId?: number; itemId?: number }, fn: () => T): T {
  const existing = findBySource(db, src);
  if (existing != null) throw new KbError(409, '已在知识库中', existing);
  try {
    return fn();
  } catch (e) {
    if (e instanceof Error && !(e instanceof KbError) && /UNIQUE/.test(e.message)) {
      const id = findBySource(db, src);
      if (id != null) throw new KbError(409, '已在知识库中', id);
    }
    throw e;
  }
}

export function createDoc(
  db: DB,
  input: { kind: 'note' | 'review' | 'item'; title?: unknown; folderId?: number | null; body?: unknown; reviewId?: number; itemId?: number },
  now: number = Date.now(),
): number {
  assertCapacity(db);
  if (input.kind === 'note') {
    const body = cleanBody(input.body, 'note');
    const first = body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
    const title = cleanTitle(input.title == null ? clipCp(first, 40) : input.title);
    const folder = cleanFolder(db, input.folderId);
    return tx(db, () => {
      const id = Number(
        db.prepare("INSERT INTO kb_docs(folder_id, kind, title, body, created_at, updated_at) VALUES (?, 'note', ?, ?, ?, ?)").run(folder, title, body, now, now).lastInsertRowid,
      );
      reindex(db, id, body, now);
      return id;
    });
  }
  const kind = input.kind;
  const srcId = kind === 'review' ? input.reviewId : input.itemId;
  if (!Number.isSafeInteger(srcId) || (srcId as number) <= 0) throw new KbError(400, '来源参数不合法');
  const sid = srcId as number;
  return dupGuard(db, kind === 'review' ? { reviewId: sid } : { itemId: sid }, () => {
    const s = sourceText(db, kind, sid);
    if (!s) throw new KbError(404, kind === 'review' ? '评审不存在或尚未完成' : '资讯不存在');
    const title = input.title == null ? s.title : cleanTitle(input.title);
    const folder = cleanFolder(db, input.folderId);
    return tx(db, () => {
      const id = Number(
        db
          .prepare(`INSERT INTO kb_docs(folder_id, kind, title, ${kind}_id, indexed_rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(folder, kind, title, sid, s.rev, now, now).lastInsertRowid,
      );
      reindex(db, id, s.text, now);
      return id;
    });
  });
}

export function insertUpload(
  db: DB,
  f: { title: string; folderId: number | null; fileName: string; mime: string; size: number; storage: string },
  now: number = Date.now(),
): number {
  assertCapacity(db);
  const folder = cleanFolder(db, f.folderId);
  const sql =
    "INSERT INTO kb_docs(folder_id, kind, title, status, file_name, file_mime, file_size, storage, created_at, updated_at) VALUES (?, 'upload', ?, 'processing', ?, ?, ?, ?, ?, ?)";
  return Number(db.prepare(sql).run(folder, cleanTitle(f.title), f.fileName, f.mime, f.size, f.storage, now, now).lastInsertRowid);
}

/** 写入 upload / note 的正文并重建分块，状态置为 ready */
export function setBody(db: DB, id: number, body: string, now: number = Date.now()): void {
  tx(db, () => {
    db.prepare('UPDATE kb_docs SET body = ? WHERE id = ?').run(body, id);
    reindex(db, id, body, now);
  });
}

export function updateDoc(db: DB, id: number, patch: { title?: unknown; folderId?: number | null; body?: unknown }, now: number = Date.now()): void {
  const r = mustRow(db, id);
  const edits = patch.title !== undefined || patch.body !== undefined;
  if (edits && r.status === 'orphan') throw new KbError(400, '来源已删除，只能移动或删除');
  if (edits && r.status === 'processing') throw new KbError(400, '文件仍在处理中');
  if (patch.body !== undefined && (r.kind === 'review' || r.kind === 'item')) throw new KbError(400, '来源类条目不能在知识库中编辑');
  const title = patch.title !== undefined ? cleanTitle(patch.title) : null;
  const body = patch.body !== undefined ? cleanBody(patch.body, r.kind === 'note' ? 'note' : 'upload') : null;
  const folder = patch.folderId !== undefined ? cleanFolder(db, patch.folderId) : undefined;
  tx(db, () => {
    if (title !== null) db.prepare('UPDATE kb_docs SET title = ?, updated_at = ? WHERE id = ?').run(title, now, id);
    if (folder !== undefined) db.prepare('UPDATE kb_docs SET folder_id = ?, updated_at = ? WHERE id = ?').run(folder, now, id);
    if (body !== null) {
      db.prepare('UPDATE kb_docs SET body = ? WHERE id = ?').run(body, id);
      reindex(db, id, body, now);
    }
  });
}

export function deleteDoc(db: DB, id: number): { storage: string | null } {
  const r = mustRow(db, id);
  db.prepare('DELETE FROM kb_docs WHERE id = ?').run(id);
  return { storage: r.storage };
}

export function getDoc(db: DB, id: number): { doc: DocView; body: string | null; chunks: { ord: number; heading: string; body: string }[] } | null {
  const r = row(db, id);
  if (!r) return null;
  const chunks = (db.prepare('SELECT ord, heading, body FROM kb_chunks WHERE doc_id = ? ORDER BY ord').all(id) as { ord: number; heading: string; body: string }[]).map((c) => ({
    ord: Number(c.ord),
    heading: c.heading,
    body: c.body,
  }));
  return { doc: toDocView(r, pathMap(db)), body: r.kind === 'upload' || r.kind === 'note' ? r.body : null, chunks };
}

/** 条目的原文件信息（upload） */
export function docFile(db: DB, id: number): { storage: string; name: string; mime: string } | null {
  const r = db.prepare('SELECT storage, file_name, file_mime FROM kb_docs WHERE id = ?').get(id) as { storage: string | null; file_name: string | null; file_mime: string | null } | undefined;
  return r?.storage ? { storage: r.storage, name: r.file_name ?? 'file', mime: r.file_mime ?? 'application/octet-stream' } : null;
}

export function listDocs(db: DB, folder: number | 'none' | null, limit = 50): DocView[] {
  const where = folder === 'none' ? 'WHERE folder_id IS NULL' : folder == null ? '' : 'WHERE folder_id = ?';
  const args = typeof folder === 'number' ? [folder, limit] : [limit];
  const rows = db.prepare(`SELECT ${COLS} FROM kb_docs ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...args) as unknown as DocRow[];
  const paths = pathMap(db);
  return rows.map((r) => toDocView(r, paths));
}

/** 按 id 批量取视图（保持传入顺序，跳过不存在的） */
export function docViews(db: DB, ids: number[]): Map<number, DocView> {
  const out = new Map<number, DocView>();
  if (!ids.length) return out;
  const uniq = [...new Set(ids)];
  const rows = db.prepare(`SELECT ${COLS} FROM kb_docs WHERE id IN (${uniq.map(() => '?').join(',')})`).all(...uniq) as unknown as DocRow[];
  const paths = pathMap(db);
  for (const r of rows) out.set(Number(r.id), toDocView(r, paths));
  return out;
}

/** 来源类条目：版本变化时重建，来源消失时置 orphan 并清分块；每次最多处理 20 条 */
export function refreshStale(db: DB, now: number = Date.now()): { refreshed: number; orphaned: number } {
  const stale = db
    .prepare(
      `SELECT id, kind, review_id, item_id FROM (
         SELECT d.id, d.kind, d.review_id, d.item_id, d.indexed_rev,
           CASE d.kind
             WHEN 'review' THEN (SELECT CAST(max(v.n) AS TEXT) FROM pm_versions v WHERE v.review_id = d.review_id)
             ELSE (SELECT ${ITEM_REV} FROM items i WHERE i.id = d.item_id)
           END AS cur
         FROM kb_docs d WHERE d.kind IN ('review', 'item') AND d.status != 'orphan'
       ) WHERE cur IS NULL OR indexed_rev IS NULL OR cur != indexed_rev
       ORDER BY id LIMIT ?`,
    )
    .all(KB_LIMITS.refreshBatch) as { id: number; kind: 'review' | 'item'; review_id: number | null; item_id: number | null }[];
  let refreshed = 0;
  let orphaned = 0;
  for (const d of stale) {
    const id = Number(d.id);
    const s = sourceText(db, d.kind, Number(d.kind === 'review' ? d.review_id : d.item_id));
    tx(db, () => {
      if (!s) {
        db.prepare('DELETE FROM kb_chunks WHERE doc_id = ?').run(id);
        db.prepare("UPDATE kb_docs SET status = 'orphan', indexed_rev = NULL, updated_at = ? WHERE id = ?").run(now, id);
        orphaned++;
      } else {
        reindex(db, id, s.text, now);
        db.prepare('UPDATE kb_docs SET indexed_rev = ? WHERE id = ?').run(s.rev, id);
        refreshed++;
      }
    });
  }
  return { refreshed, orphaned };
}
