// 合规材料：起草、模板同步、章级版本、定稿锁定。模型调用不在这里（见 docs-gen.ts），只负责读写
import { createHash } from 'node:crypto';
import type { DB } from '../../packages/core/db.ts';
import { lineDiff, type DiffLine } from '../wiki/diff.ts';
import { getEntity, getFacts } from './facts.ts';
import type { AssessResult } from './rules.ts';
import { CpError, getProduct } from './store.ts';
import { TEMPLATES, TEMPLATES_VERSION, availability, chaptersFor, placeholdersIn, templateOf, type Chapter, type Ctx, type DocTemplate } from './templates.ts';

export const SECTION_MAX = 20000;
export const REVISIONS_KEEP = 50;

export type Origin = 'fixed' | 'generate' | 'edit' | 'restore';

export interface SectionView {
  key: string; title: string; mode: 'fixed' | 'model'; ord: number; body: string; rev: number; origin: Origin | null;
  stale: boolean; removed: boolean; placeholders: string[]; updated_at: number;
}
export interface DocView {
  id: number; product_id: number; kind: string; name: string; usage: 'public' | 'filing'; status: 'draft' | 'final';
  template_version: number; finalized_at: number | null; created_at: number; updated_at: number; sections: SectionView[];
}
export interface DocCard {
  kind: string; name: string; usage: 'public' | 'filing'; items: string[]; available: boolean; reason: string | null;
  doc: { id: number; status: 'draft' | 'final'; placeholders: number; stale: number; pending: number } | null;
}
export interface GenContext { doc: DocView; template: DocTemplate; chapter: Chapter; ctx: Ctx; reasons: string[]; hash: string }

type Row = Record<string, unknown>;

const FINAL_MSG = '材料已定稿，先取消定稿';
const len = (s: string) => [...s].length;

function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function loadCtx(db: DB, productId: number): { ctx: Ctx; result: AssessResult | null } {
  const { product, assessment } = getProduct(db, productId);
  const ctx: Ctx = {
    entity: getEntity(db),
    facts: getFacts(db, productId),
    answers: assessment?.answers ?? {},
    product: { name: product.name, description: product.description },
  };
  return { ctx, result: assessment?.result ?? null };
}

function reasonsFor(t: DocTemplate, result: AssessResult | null): string[] {
  const out = new Set<string>();
  for (const it of result?.items ?? []) if (t.items.includes(it.id) && it.level !== 'na') for (const r of it.reasons) out.add(r);
  return [...out];
}

function useValue(ctx: Ctx, path: string): unknown {
  const [scope, key] = path.split('.');
  return (scope === 'entity' ? ctx.entity : ctx.facts)[key] ?? null;
}

/** 章节输入摘要：模板版本、章 key、用到的资料值；模型章另含答案、判定理由、产品；固定章另含渲染结果 */
export function inputHash(t: DocTemplate, ch: Chapter, ctx: Ctx, reasons: string[]): string {
  const payload: Record<string, unknown> = {
    tv: TEMPLATES_VERSION, dv: t.version, key: ch.key,
    uses: Object.fromEntries(ch.uses.map((u) => [u, useValue(ctx, u)])),
  };
  if (ch.mode === 'model') Object.assign(payload, { answers: ctx.answers, reasons, product: ctx.product, public_name: ctx.facts.public_name ?? null });
  else payload.out = ch.render!(ctx);
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function docRow(db: DB, docId: number): Row {
  const r = db.prepare('SELECT * FROM cp_docs WHERE id = ?').get(docId) as Row | undefined;
  if (!r) throw new CpError(404, '材料不存在');
  return r;
}

export function docProductId(db: DB, docId: number): number {
  return Number(docRow(db, docId).product_id);
}

function templateOfRow(r: Row): DocTemplate {
  const t = templateOf(String(r.kind));
  if (!t) throw new CpError(404, '材料不存在');
  return t;
}

function insertRevision(db: DB, sectionId: number, n: number, body: string, origin: Origin, hash: string | null, now: number): void {
  db.prepare('INSERT INTO cp_doc_revisions(section_id, n, body, origin, input_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sectionId, n, body, origin, hash, now);
  db.prepare('DELETE FROM cp_doc_revisions WHERE section_id = ? AND n <= ?').run(sectionId, n - REVISIONS_KEEP);
}

/** 让库里的章与当前模板 + 答案一致：补建、标记移除、恢复、重排。已定稿材料不动 */
function syncSections(db: DB, doc: Row, t: DocTemplate, ctx: Ctx, now: number): void {
  if (doc.status === 'final') return;
  const docId = Number(doc.id);
  const want = chaptersFor(t, ctx.answers);
  const rows = db.prepare('SELECT id, key, ord, removed FROM cp_doc_sections WHERE doc_id = ?').all(docId) as Row[];
  const byKey = new Map(rows.map((r) => [String(r.key), r]));
  const wantKeys = new Set(want.map((c) => c.key));
  const tplOrder = new Map(t.chapters.map((c, i) => [c.key, i]));
  const gone = rows.filter((r) => !wantKeys.has(String(r.key)))
    .sort((a, b) => (tplOrder.get(String(a.key)) ?? 999) - (tplOrder.get(String(b.key)) ?? 999) || Number(a.ord) - Number(b.ord));
  const plan: { key: string; ord: number; removed: number }[] = [
    ...want.map((c, i) => ({ key: c.key, ord: i, removed: 0 })),
    ...gone.map((r, i) => ({ key: String(r.key), ord: want.length + i, removed: 1 })),
  ];
  const changed = plan.some((p) => { const r = byKey.get(p.key); return !r || Number(r.ord) !== p.ord || Number(r.removed) !== p.removed; })
    || Number(doc.template_version) !== t.version;
  if (!changed) return;
  tx(db, () => {
    const ins = db.prepare('INSERT INTO cp_doc_sections(doc_id, key, ord, updated_at) VALUES (?, ?, ?, ?)');
    const upd = db.prepare('UPDATE cp_doc_sections SET ord = ?, removed = ? WHERE id = ?');
    for (const p of plan) {
      const r = byKey.get(p.key);
      if (!r) ins.run(docId, p.key, p.ord, now);
      else if (Number(r.ord) !== p.ord || Number(r.removed) !== p.removed) upd.run(p.ord, p.removed, Number(r.id));
    }
    db.prepare('UPDATE cp_docs SET template_version = ? WHERE id = ?').run(t.version, docId);
  });
}

function sectionView(t: DocTemplate, r: Row, ctx: Ctx, reasons: string[]): SectionView {
  const ch = t.chapters.find((c) => c.key === r.key);
  const removed = Number(r.removed) === 1 || !ch;
  const rev = Number(r.rev);
  const body = String(r.body);
  return {
    key: String(r.key), title: ch?.title ?? String(r.key), mode: ch?.mode ?? 'model', ord: Number(r.ord), body, rev,
    origin: (r.origin as Origin | null) ?? null,
    stale: !removed && rev > 0 && inputHash(t, ch!, ctx, reasons) !== r.input_hash,
    removed, placeholders: placeholdersIn(body), updated_at: Number(r.updated_at),
  };
}

function buildView(db: DB, doc: Row, t: DocTemplate, ctx: Ctx, reasons: string[]): DocView {
  const rows = db.prepare('SELECT * FROM cp_doc_sections WHERE doc_id = ? ORDER BY ord, id').all(Number(doc.id)) as Row[];
  return {
    id: Number(doc.id), product_id: Number(doc.product_id), kind: t.kind, name: t.name, usage: t.usage,
    status: doc.status === 'final' ? 'final' : 'draft', template_version: Number(doc.template_version),
    finalized_at: doc.finalized_at === null || doc.finalized_at === undefined ? null : Number(doc.finalized_at),
    created_at: Number(doc.created_at), updated_at: Number(doc.updated_at),
    sections: rows.map((r) => sectionView(t, r, ctx, reasons)),
  };
}

interface Loaded { doc: Row; t: DocTemplate; ctx: Ctx; reasons: string[]; view: DocView }

function load(db: DB, docId: number, now: number): Loaded {
  let doc = docRow(db, docId);
  const t = templateOfRow(doc);
  const { ctx, result } = loadCtx(db, Number(doc.product_id));
  const reasons = reasonsFor(t, result);
  syncSections(db, doc, t, ctx, now);
  doc = docRow(db, docId);
  return { doc, t, ctx, reasons, view: buildView(db, doc, t, ctx, reasons) };
}

export function getDoc(db: DB, docId: number, now = Date.now()): DocView {
  return load(db, docId, now).view;
}

const active = (d: DocView) => d.sections.filter((s) => !s.removed);
const countFields = (d: DocView) => new Set(active(d).flatMap((s) => s.placeholders)).size;

export function listDocs(db: DB, productId: number): DocCard[] {
  const { result } = loadCtx(db, productId);
  const ids = new Map((db.prepare('SELECT id, kind FROM cp_docs WHERE product_id = ?').all(productId) as Row[]).map((r) => [String(r.kind), Number(r.id)]));
  return TEMPLATES.map((t) => {
    const av = availability(t, result);
    const id = ids.get(t.kind);
    let doc: DocCard['doc'] = null;
    if (id !== undefined) {
      const d = getDoc(db, id);
      const act = active(d);
      doc = { id, status: d.status, placeholders: countFields(d), stale: act.filter((s) => s.stale).length, pending: act.filter((s) => s.rev === 0).length };
    }
    return { kind: t.kind, name: t.name, usage: t.usage, items: [...t.items], available: av.ok, reason: av.ok ? null : av.reason, doc };
  });
}

export function createDoc(db: DB, productId: number, kind: unknown, now = Date.now()): DocView {
  const t = typeof kind === 'string' ? templateOf(kind) : undefined;
  if (!t) throw new CpError(400, '未知材料');
  const { ctx, result } = loadCtx(db, productId);
  const av = availability(t, result);
  if (!av.ok) throw new CpError(400, av.reason);
  const reasons = reasonsFor(t, result);
  const id = tx(db, () => {
    if (db.prepare('SELECT 1 FROM cp_docs WHERE product_id = ? AND kind = ?').get(productId, t.kind)) throw new CpError(409, '材料已存在');
    const docId = Number(db.prepare('INSERT INTO cp_docs(product_id, kind, template_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(productId, t.kind, t.version, now, now).lastInsertRowid);
    const ins = db.prepare('INSERT INTO cp_doc_sections(doc_id, key, ord, body, rev, origin, input_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    chaptersFor(t, ctx.answers).forEach((c, i) => {
      if (c.mode !== 'fixed') { ins.run(docId, c.key, i, '', 0, null, null, now); return; }
      const body = c.render!(ctx);
      const hash = inputHash(t, c, ctx, reasons);
      const sid = Number(ins.run(docId, c.key, i, body, 1, 'fixed', hash, now).lastInsertRowid);
      insertRevision(db, sid, 1, body, 'fixed', hash, now);
    });
    return docId;
  });
  return getDoc(db, id, now);
}

function sectionRow(db: DB, docId: number, key: string): Row {
  const r = db.prepare('SELECT * FROM cp_doc_sections WHERE doc_id = ? AND key = ?').get(docId, String(key)) as Row | undefined;
  if (!r) throw new CpError(404, '章节不存在');
  return r;
}

function editable(db: DB, docId: number, key: string): { doc: Row; sec: Row } {
  const doc = docRow(db, docId);
  if (doc.status === 'final') throw new CpError(409, FINAL_MSG);
  const sec = sectionRow(db, docId, key);
  if (Number(sec.removed) === 1) throw new CpError(409, '章节已从模板移除');
  return { doc, sec };
}

export function prepareGenerate(db: DB, docId: number, key: string): GenContext {
  const l = load(db, docId, Date.now());
  if (l.doc.status === 'final') throw new CpError(409, FINAL_MSG);
  const s = l.view.sections.find((x) => x.key === key);
  if (!s) throw new CpError(404, '章节不存在');
  const chapter = l.t.chapters.find((c) => c.key === key);
  if (s.removed || !chapter) throw new CpError(409, '章节已从模板移除');
  return { doc: l.view, template: l.t, chapter, ctx: l.ctx, reasons: l.reasons, hash: inputHash(l.t, chapter, l.ctx, l.reasons) };
}

/** 写入新版本（调用方已在事务内完成校验） */
function writeRev(db: DB, sec: Row, body: string, origin: Origin, hash: string | null, now: number): void {
  const n = Number(sec.rev) + 1;
  db.prepare('UPDATE cp_doc_sections SET body = ?, rev = ?, origin = ?, input_hash = ?, updated_at = ? WHERE id = ?')
    .run(body, n, origin, hash, now, Number(sec.id));
  insertRevision(db, Number(sec.id), n, body, origin, hash, now);
  db.prepare('UPDATE cp_docs SET updated_at = ? WHERE id = ?').run(now, Number(sec.doc_id));
}

function viewOf(db: DB, docId: number, key: string, now: number): SectionView {
  return getDoc(db, docId, now).sections.find((s) => s.key === key)!;
}

export function writeGenerated(db: DB, docId: number, key: string, body: string, origin: 'fixed' | 'generate', hash: string, now = Date.now()): SectionView {
  if (len(body) > SECTION_MAX) throw new CpError(400, `正文不超过 ${SECTION_MAX} 字`);
  tx(db, () => {
    const { sec } = editable(db, docId, key);
    writeRev(db, sec, body, origin, hash, now);
  });
  return viewOf(db, docId, key, now);
}

export function saveSection(db: DB, docId: number, key: string, body: unknown, baseRev: unknown, now = Date.now()): SectionView {
  if (typeof body !== 'string') throw new CpError(400, '正文格式不对');
  if (typeof baseRev !== 'number' || !Number.isInteger(baseRev)) throw new CpError(400, '版本号格式不对');
  if (len(body) > SECTION_MAX) throw new CpError(400, `正文不超过 ${SECTION_MAX} 字`);
  tx(db, () => {
    const { sec } = editable(db, docId, key);
    if (Number(sec.rev) !== baseRev) throw new CpError(409, '内容已在别处更新，请刷新');
    writeRev(db, sec, body, 'edit', (sec.input_hash as string | null) ?? null, now);
  });
  return viewOf(db, docId, key, now);
}

function revNo(n: unknown): number {
  const x = typeof n === 'string' && /^\d+$/.test(n) ? Number(n) : n;
  if (typeof x !== 'number' || !Number.isInteger(x) || x < 1) throw new CpError(400, '版本号格式不对');
  return x;
}

function revisionRow(db: DB, sectionId: number, n: number): Row {
  const r = db.prepare('SELECT * FROM cp_doc_revisions WHERE section_id = ? AND n = ?').get(sectionId, n) as Row | undefined;
  if (!r) throw new CpError(404, '版本不存在');
  return r;
}

export function listRevisions(db: DB, docId: number, key: string): { n: number; origin: Origin; created_at: number; chars: number }[] {
  docRow(db, docId);
  const sec = sectionRow(db, docId, key);
  const rows = db.prepare('SELECT n, origin, created_at, body FROM cp_doc_revisions WHERE section_id = ? ORDER BY n DESC').all(Number(sec.id)) as Row[];
  return rows.map((r) => ({ n: Number(r.n), origin: r.origin as Origin, created_at: Number(r.created_at), chars: len(String(r.body)) }));
}

export function getRevision(db: DB, docId: number, key: string, n: number): { n: number; body: string; origin: Origin; created_at: number; diff: { lines: DiffLine[]; clipped: boolean } } {
  docRow(db, docId);
  const sec = sectionRow(db, docId, key);
  const r = revisionRow(db, Number(sec.id), revNo(n));
  const body = String(r.body);
  return { n: Number(r.n), body, origin: r.origin as Origin, created_at: Number(r.created_at), diff: lineDiff(body, String(sec.body)) };
}

export function restoreSection(db: DB, docId: number, key: string, n: unknown, now = Date.now()): SectionView {
  const no = revNo(n);
  tx(db, () => {
    const { sec } = editable(db, docId, key);
    const r = revisionRow(db, Number(sec.id), no);
    writeRev(db, sec, String(r.body), 'restore', (r.input_hash as string | null) ?? null, now);
  });
  return viewOf(db, docId, key, now);
}

export function finalizeDoc(db: DB, docId: number, now = Date.now()): DocView {
  const d = getDoc(db, docId, now);
  if (d.status === 'final') return d;
  const act = active(d);
  const pending = act.filter((s) => s.rev === 0).map((s) => s.key);
  if (pending.length) throw new CpError(400, '还有未生成的章节', { pending });
  const placeholders = act.filter((s) => s.placeholders.length).map((s) => ({ key: s.key, title: s.title, fields: s.placeholders }));
  if (placeholders.length) throw new CpError(400, '还有待填内容', { placeholders });
  db.prepare("UPDATE cp_docs SET status = 'final', finalized_at = ?, updated_at = ? WHERE id = ? AND status = 'draft'").run(now, now, docId);
  return getDoc(db, docId, now);
}

export function unfinalizeDoc(db: DB, docId: number, now = Date.now()): DocView {
  docRow(db, docId);
  db.prepare("UPDATE cp_docs SET status = 'draft', finalized_at = NULL, updated_at = ? WHERE id = ? AND status = 'final'").run(now, docId);
  return getDoc(db, docId, now);
}

export function deleteDoc(db: DB, docId: number): void {
  if (docRow(db, docId).status === 'final') throw new CpError(409, FINAL_MSG);
  db.prepare('DELETE FROM cp_docs WHERE id = ?').run(docId);
}

export function deleteSection(db: DB, docId: number, key: string): void {
  if (docRow(db, docId).status === 'final') throw new CpError(409, FINAL_MSG);
  const sec = sectionRow(db, docId, key);
  if (Number(sec.removed) !== 1) throw new CpError(400, '只能删除模板已移除的章节');
  db.prepare('DELETE FROM cp_doc_sections WHERE id = ?').run(Number(sec.id));
}
