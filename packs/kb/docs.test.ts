import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DB } from '../../packages/core/db.ts';
import { createDoc, deleteDoc, findBySource, getDoc, insertUpload, listDocs, refreshStale, setBody, sourceText, updateDoc } from './docs.ts';
import { createFolder, deleteFolder } from './folders.ts';
import { kbErr as err, seedItem, seedReview, tmpKbDb } from './testutil.ts';

const E = (status: number, message: string) => ({ status, message, docId: undefined });
const n = (db: DB, sql: string, ...a: number[]) => Number((db.prepare(sql).get(...a) as { n: number }).n);
const fts = (db: DB, q: string) => n(db, `SELECT count(*) AS n FROM kb_fts WHERE kb_fts MATCH '"${q}"'`);

test('note：创建即 ready 可检索；编辑正文后分块整体替换', () => {
  const { db, done } = tmpKbDb();
  const id = createDoc(db, { kind: 'note', title: '会议纪要', body: '# 定价\n按席位收费' });
  const d = getDoc(db, id)!;
  assert.equal(d.doc.status, 'ready');
  assert.equal(d.body, '# 定价\n按席位收费');
  assert.deepEqual(d.chunks, [{ ord: 0, heading: '定价', body: '按席位收费' }]);
  assert.equal(fts(db, '按席位'), 1);
  updateDoc(db, id, { body: '改为按用量收费' });
  assert.equal(fts(db, '按席位'), 0);
  assert.equal(fts(db, '按用量'), 1);
  done();
});

test('review：入库取最新版本；出新版本后重建；删评审后变 orphan 并清索引', () => {
  const { db, done } = tmpKbDb();
  const input = '给中小律所的合同审查工具，\n按席位收费，先做华东地区再推广到全国其他地区和海外市场';
  const rid = seedReview(db, input);
  const id = createDoc(db, { kind: 'review', reviewId: rid });
  let d = getDoc(db, id)!;
  assert.equal(d.doc.title, [...input.replace(/\s+/g, ' ')].slice(0, 40).join(''));
  assert.equal(d.body, null);
  assert.equal(d.doc.review_id, rid);
  assert.equal((db.prepare('SELECT indexed_rev FROM kb_docs WHERE id = ?').get(id) as { indexed_rev: string }).indexed_rev, '1');
  assert.equal(fts(db, '按席位'), 1);
  db.prepare("INSERT INTO pm_versions(review_id, n, created_at, source, content) VALUES (?, 2, 2, 'manual', '改为按用量收费')").run(rid);
  assert.deepEqual(refreshStale(db), { refreshed: 1, orphaned: 0 });
  assert.equal(fts(db, '按席位'), 0);
  assert.equal(fts(db, '按用量'), 1);
  assert.deepEqual(refreshStale(db), { refreshed: 0, orphaned: 0 });
  db.prepare('DELETE FROM pm_reviews WHERE id = ?').run(rid);
  assert.deepEqual(refreshStale(db), { refreshed: 0, orphaned: 1 });
  d = getDoc(db, id)!;
  assert.equal(d.doc.status, 'orphan');
  assert.equal(n(db, 'SELECT count(*) AS n FROM kb_chunks WHERE doc_id = ?', id), 0);
  assert.equal(n(db, 'SELECT count(*) AS n FROM kb_fts'), 0);
  assert.deepEqual(refreshStale(db), { refreshed: 0, orphaned: 0 });
  assert.deepEqual(err(() => updateDoc(db, id, { title: '新标题' })), E(400, '来源已删除，只能移动或删除'));
  updateDoc(db, id, { folderId: createFolder(db, '归档', null) });
  done();
});

test('item：正文含标题、摘要、分析；有译文用译文；译文更新后重建；删资讯后 orphan', () => {
  const { db, done } = tmpKbDb();
  const s = sourceText(db, 'item', seedItem(db))!;
  assert.equal(s.title, '定价新闻');
  assert.ok(s.text.startsWith('# 定价新闻'), s.text);
  for (const part of ['## 摘要\n摘要内容', '## 分析\n- 要点一\n- 要点二', 'original english body']) assert.ok(s.text.includes(part), part);
  const tr = seedItem(db, '中文译文全文');
  const id = createDoc(db, { kind: 'item', itemId: tr });
  const t = sourceText(db, 'item', tr)!.text;
  assert.ok(t.includes('中文译文全文') && !t.includes('original english body'), t);
  assert.equal(fts(db, '中文译'), 1);
  db.prepare("UPDATE items SET translation_zh = '更新后的译文', translated_at = 5 WHERE id = ?").run(tr);
  assert.deepEqual(refreshStale(db), { refreshed: 1, orphaned: 0 });
  assert.equal(fts(db, '更新后'), 1);
  db.prepare('DELETE FROM items WHERE id = ?').run(tr);
  refreshStale(db);
  assert.equal(getDoc(db, id)!.doc.status, 'orphan');
  done();
});

test('重复入库 409 带已有 docId；来源或目录不存在 404', () => {
  const { db, done } = tmpKbDb();
  const rid = seedReview(db);
  const id = createDoc(db, { kind: 'review', reviewId: rid });
  assert.deepEqual(err(() => createDoc(db, { kind: 'review', reviewId: rid })), { status: 409, message: '已在知识库中', docId: id });
  assert.equal(findBySource(db, { reviewId: rid }), id);
  assert.equal(findBySource(db, { reviewId: 999 }), null);
  const running = Number(db.prepare("INSERT INTO pm_reviews(created_at, status, mode, input) VALUES (1, 'running', 'idea', 'x')").run().lastInsertRowid);
  assert.deepEqual(err(() => createDoc(db, { kind: 'review', reviewId: running })), E(404, '评审不存在或尚未完成'));
  assert.deepEqual(err(() => createDoc(db, { kind: 'item', itemId: 999 })), E(404, '资讯不存在'));
  const f = createFolder(db, '临时', null);
  deleteFolder(db, f);
  assert.deepEqual(err(() => createDoc(db, { kind: 'note', title: 't', body: 'x', folderId: f })), E(404, '目录不存在'));
  const rid2 = seedReview(db);
  assert.deepEqual(err(() => createDoc(db, { kind: 'review', reviewId: rid2, folderId: f })), E(404, '目录不存在'));
  assert.equal(findBySource(db, { reviewId: rid2 }), null);
  done();
});

test('条目：错误文案与上限', () => {
  const { db, done } = tmpKbDb();
  assert.deepEqual(err(() => createDoc(db, { kind: 'note', title: 't', body: '  ' })), E(400, '笔记内容不能为空'));
  assert.deepEqual(err(() => createDoc(db, { kind: 'note', title: ' ', body: 'x' })), E(400, '标题需为 1–120 字'));
  assert.deepEqual(err(() => createDoc(db, { kind: 'note', title: '长'.repeat(121), body: 'x' })), E(400, '标题需为 1–120 字'));
  assert.deepEqual(err(() => createDoc(db, { kind: 'note', title: 't', body: '字'.repeat(200_001) })), E(400, '正文最多 20 万字'));
  const id = createDoc(db, { kind: 'note', title: 't', body: '字'.repeat(200_000) });
  assert.equal(getDoc(db, createDoc(db, { kind: 'note', body: '\n# 标题行\n正文' }))!.doc.title, '标题行');
  assert.deepEqual(err(() => updateDoc(db, 999, { title: 'x' })), E(404, '条目不存在'));
  assert.deepEqual(err(() => updateDoc(db, id, { body: '' })), E(400, '笔记内容不能为空'));
  const rd = createDoc(db, { kind: 'review', reviewId: seedReview(db) });
  assert.deepEqual(err(() => updateDoc(db, rd, { body: 'x' })), E(400, '来源类条目不能在知识库中编辑'));
  updateDoc(db, rd, { title: '改名' });
  assert.equal(getDoc(db, rd)!.doc.title, '改名');
  const up = insertUpload(db, { title: 'a', folderId: null, fileName: 'a.txt', mime: 'text/plain', size: 1, storage: 's1' });
  assert.equal(getDoc(db, up)!.doc.status, 'processing');
  assert.deepEqual(err(() => updateDoc(db, up, { body: 'x' })), E(400, '文件仍在处理中'));
  db.exec("WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 1996) INSERT INTO kb_docs(kind, title, created_at, updated_at) SELECT 'note', 'n' || i, 1, 1 FROM c");
  assert.deepEqual(err(() => createDoc(db, { kind: 'note', title: 't', body: 'x' })), E(400, '知识库最多 2000 个条目'));
  done();
});

test('refreshStale 每次最多 20 条；截断标记；setBody 置 ready；deleteDoc 返回存储名', () => {
  const { db, done } = tmpKbDb();
  const ids = Array.from({ length: 25 }, () => createDoc(db, { kind: 'review', reviewId: seedReview(db) }));
  db.exec("INSERT INTO pm_versions(review_id, n, created_at, source, content) SELECT id, 2, 2, 'manual', '新版' FROM pm_reviews");
  assert.deepEqual(refreshStale(db), { refreshed: 20, orphaned: 0 });
  assert.deepEqual(refreshStale(db), { refreshed: 5, orphaned: 0 });
  const big = createDoc(db, { kind: 'note', title: '大', body: Array.from({ length: 220 }, () => '长'.repeat(900)).join('\n\n') });
  assert.equal(getDoc(db, big)!.doc.truncated, false);
  setBody(db, big, Array.from({ length: 450 }, () => '长'.repeat(400)).join('\n\n'));
  assert.equal(getDoc(db, big)!.doc.truncated, true);
  assert.equal(getDoc(db, ids[0])!.doc.truncated, false);
  const up = insertUpload(db, { title: 'a', folderId: null, fileName: 'a.txt', mime: 'text/plain', size: 1, storage: 'abc' });
  setBody(db, up, '上传的正文');
  assert.equal(getDoc(db, up)!.doc.status, 'ready');
  assert.deepEqual(deleteDoc(db, up), { storage: 'abc' });
  assert.equal(getDoc(db, up), null);
  assert.deepEqual(deleteDoc(db, big), { storage: null });
  assert.deepEqual(err(() => deleteDoc(db, big)), E(404, '条目不存在'));
  done();
});

test('listDocs：按目录、未归类、最近更新', () => {
  const { db, done } = tmpKbDb();
  const f = createFolder(db, '产品', null);
  const a = createDoc(db, { kind: 'note', title: 'a', body: 'x', folderId: f }, 1);
  const b = createDoc(db, { kind: 'note', title: 'b', body: 'x' }, 2);
  assert.deepEqual(listDocs(db, f).map((d) => d.id), [a]);
  assert.deepEqual(listDocs(db, 'none').map((d) => d.id), [b]);
  assert.deepEqual(listDocs(db, null).map((d) => d.id), [b, a]);
  assert.equal(listDocs(db, f)[0].path, '产品');
  assert.equal(listDocs(db, 'none')[0].path, '未归类');
  done();
});

test('updateDoc：正文不是字符串时返回 400，不会清空已有正文', () => {
  const { db, done } = tmpKbDb();
  const id = insertUpload(db, { title: '资料', folderId: null, fileName: 'a.txt', mime: 'text/plain', size: 1, storage: 'a'.repeat(32) });
  setBody(db, id, '原有正文');
  for (const b of [null, 123, ['x']]) assert.equal(err(() => updateDoc(db, id, { body: b }))?.status, 400, JSON.stringify(b));
  assert.equal(getDoc(db, id)!.body, '原有正文');
  done();
});
