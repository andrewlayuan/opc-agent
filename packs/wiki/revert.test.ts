import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DB } from '../../packages/core/db.ts';
import { revertOp, restorePage } from './revert.ts';
import { createOp, finishOp, getOp, getPage, getPageRow, tx, writePages } from './store.ts';
import type { PageDraft } from './store.ts';
import { tmpWikiDb } from './testutil.ts';
import type { OpKind } from './types.ts';

const draft = (slug: string, body: string): PageDraft => ({ slug, kind: 'concept', title: slug, summary: '', body });
const op = (db: DB, kind: OpKind, drafts: PageDraft[], docId?: number) =>
  tx(db, () => {
    const id = createOp(db, kind, { status: 'running', docId });
    const r = writePages(db, id, drafts);
    finishOp(db, id, { status: 'done', pages: r.changes });
    return id;
  });

test('revertOp：更新过的页回到 from_rev，新建的页软删除，原 op 为 reverted，wiki_docs 为 reverted', () => {
  const { db, done } = tmpWikiDb();
  op(db, 'edit', [draft('a', 'a1')]);
  db.prepare("INSERT INTO wiki_docs(doc_id, body_hash, state, ingested_at) VALUES (7, 'h', 'done', 1)").run();
  const ing = op(db, 'ingest', [draft('a', 'a2'), draft('b', 'b1')], 7);
  const r = revertOp(db, ing);
  assert.deepEqual(r.conflicts, []);
  assert.ok(r.revertOp > 0);
  assert.equal(getPage(db, 'a')!.body, 'a1');
  assert.equal(getPage(db, 'b'), null);
  assert.equal(getOp(db, ing)!.status, 'reverted');
  const rv = getOp(db, r.revertOp)!;
  assert.equal(rv.kind, 'revert');
  assert.equal(rv.target_op, ing);
  assert.equal(rv.pages.length, 2);
  assert.equal((db.prepare('SELECT state FROM wiki_docs WHERE doc_id = 7').get() as { state: string }).state, 'reverted');
  done();
});

test('revertOp：某页之后被改过 → 返回冲突且不写入；force 时全部恢复', () => {
  const { db, done } = tmpWikiDb();
  op(db, 'edit', [draft('a', 'a1'), draft('b', 'b1')]);
  const ing = op(db, 'ingest', [draft('a', 'a2'), draft('b', 'b2')]);
  op(db, 'edit', [draft('b', 'b3')]);
  const r = revertOp(db, ing);
  assert.equal(r.revertOp, 0);
  assert.deepEqual(r.conflicts, [{ slug: 'b', rev: 3, expected: 2 }]);
  assert.equal(getPage(db, 'a')!.body, 'a2', '有冲突时一页都不改');
  assert.equal(getOp(db, ing)!.status, 'done');
  const f = revertOp(db, ing, { force: true });
  assert.deepEqual(f.conflicts, []);
  assert.equal(getPage(db, 'a')!.body, 'a1');
  assert.equal(getPage(db, 'b')!.body, 'b1');
  done();
});

test('revertOp：lint、revert、未完成或已撤销的 op 抛 400', () => {
  const { db, done } = tmpWikiDb();
  const lint = createOp(db, 'lint', { status: 'done' });
  assert.throws(() => revertOp(db, lint), { status: 400 });
  const queued = createOp(db, 'ingest');
  assert.throws(() => revertOp(db, queued), { status: 400 });
  const e = op(db, 'edit', [draft('a', 'x')]);
  const r = revertOp(db, e);
  assert.throws(() => revertOp(db, r.revertOp), { status: 400 });
  assert.throws(() => revertOp(db, e), { status: 400 });
  assert.throws(() => revertOp(db, 9999), { status: 404 });
  done();
});

test('revertOp：from_rev 快照已被清理 → 作为冲突报告', () => {
  const { db, done } = tmpWikiDb();
  op(db, 'edit', [draft('a', 'a1')]);
  const e = op(db, 'edit', [draft('a', 'a2')]);
  db.prepare('DELETE FROM wiki_revisions WHERE rev = 1').run();
  const r = revertOp(db, e, { force: true });
  assert.equal(r.revertOp, 0);
  assert.deepEqual(r.conflicts.map((c) => c.slug), ['a']);
  done();
});

test('restorePage：恢复到 rev 1，生成 restore op，rev 递增', () => {
  const { db, done } = tmpWikiDb();
  op(db, 'edit', [draft('a', 'a1')]);
  op(db, 'edit', [draft('a', 'a2')]);
  const c = restorePage(db, 'a', 1);
  assert.deepEqual([c.from_rev, c.to_rev], [2, 3]);
  assert.equal(getPage(db, 'a')!.body, 'a1');
  const last = db.prepare('SELECT kind, status FROM wiki_ops ORDER BY id DESC LIMIT 1').get() as { kind: string; status: string };
  assert.deepEqual({ ...last }, { kind: 'restore', status: 'done' });
  assert.equal(getPageRow(db, 'a')!.rev, 3);
  assert.throws(() => restorePage(db, 'nope', 1), { status: 404 });
  done();
});
