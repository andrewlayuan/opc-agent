// 撤销整次操作与单页恢复。撤销本身也记为一条操作，历史不删除
import type { DB } from '../../packages/core/db.ts';
import { createOp, finishOp, getOp, getPageRow, getRevision, restoreSnapshot, softDelete, tx } from './store.ts';
import type { PageChange, PageRow } from './store.ts';
import { WikiError } from './types.ts';
import type { OpKind } from './types.ts';

const REVERTABLE: ReadonlySet<OpKind> = new Set<OpKind>(['ingest', 'fix', 'generate', 'query_save', 'edit', 'restore']);

export interface RevertConflict {
  slug: string;
  rev: number;
  expected: number;
}

export function revertOp(db: DB, opId: number, o: { force?: boolean; now?: number } = {}): { revertOp: number; conflicts: RevertConflict[] } {
  const op = getOp(db, opId);
  if (!op) throw new WikiError(404, '操作不存在');
  if (!REVERTABLE.has(op.kind) || op.status !== 'done') throw new WikiError(400, '该操作不能撤销');
  const now = o.now ?? Date.now();
  return tx(db, () => {
    const conflicts: RevertConflict[] = [];
    const rows: { c: PageChange; p: PageRow }[] = [];
    for (const c of op.pages) {
      const p = db.prepare('SELECT * FROM wiki_pages WHERE id = ?').get(c.page_id) as PageRow | undefined;
      if (!p) {
        conflicts.push({ slug: c.slug, rev: 0, expected: c.to_rev });
        continue;
      }
      const missing = c.from_rev > 0 && !getRevision(db, p.id, c.from_rev);
      if (missing || (p.rev !== c.to_rev && !o.force)) {
        conflicts.push({ slug: p.slug, rev: p.rev, expected: c.to_rev });
        continue;
      }
      rows.push({ c, p });
    }
    if (conflicts.length) return { revertOp: 0, conflicts };
    const rid = createOp(db, 'revert', { status: 'running', targetOp: op.id, docId: op.doc_id ?? undefined, now });
    const changes = rows.map(({ c, p }) => (c.from_rev === 0 ? softDelete(db, rid, p.id, now) : restoreSnapshot(db, rid, p.id, c.from_rev, now)));
    finishOp(db, rid, { status: 'done', pages: changes, note: `撤销操作 #${op.id}`, now });
    db.prepare("UPDATE wiki_ops SET status = 'reverted' WHERE id = ?").run(op.id);
    if (op.kind === 'ingest' && op.doc_id != null) db.prepare("UPDATE wiki_docs SET state = 'reverted' WHERE doc_id = ?").run(op.doc_id);
    return { revertOp: rid, conflicts: [] };
  });
}

export function restorePage(db: DB, slug: string, rev: number, now = Date.now()): PageChange {
  const p = getPageRow(db, slug);
  if (!p) throw new WikiError(404, '页面不存在');
  return tx(db, () => {
    const id = createOp(db, 'restore', { status: 'running', now });
    const c = restoreSnapshot(db, id, p.id, rev, now);
    finishOp(db, id, { status: 'done', pages: [c], note: `恢复「${p.title}」到第 ${rev} 版`, now });
    return c;
  });
}
