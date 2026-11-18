import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DB } from '../../packages/core/db.ts';
import { deleteDoc } from '../kb/docs.ts';
import { catalog, createOp, finishOp, getPage, listPages, listRevisions, pruneRevisions, restoreSnapshot, softDelete, tx, writePages } from './store.ts';
import type { PageDraft } from './store.ts';
import { seedDoc, tmpWikiDb } from './testutil.ts';

const n = (db: DB, sql: string, ...a: (string | number)[]) => Number((db.prepare(sql).get(...a) as { n: number }).n);
const draft = (slug: string, body: string, kind: PageDraft['kind'] = 'concept', title = slug): PageDraft => ({ slug, kind, title, summary: `${title}摘要`, body });
const write = (db: DB, drafts: PageDraft[], o?: { byUser?: boolean }) =>
  tx(db, () => {
    const op = createOp(db, 'edit', { status: 'running' });
    const r = writePages(db, op, drafts, o);
    finishOp(db, op, { status: 'done', pages: r.changes });
    return { op, ...r };
  });

test('writePages：新建 from_rev=0/to_rev=1，更新后 rev=2，版本表 2 条', () => {
  const { db, done } = tmpWikiDb();
  const a = write(db, [draft('rag', '检索增强生成第一版')]);
  assert.deepEqual(a.changes.map((c) => [c.slug, c.from_rev, c.to_rev]), [['rag', 0, 1]]);
  const b = write(db, [draft('rag', '检索增强生成第二版')]);
  assert.deepEqual(b.changes.map((c) => [c.from_rev, c.to_rev]), [[1, 2]]);
  const p = getPage(db, 'rag')!;
  assert.equal(p.rev, 2);
  assert.equal(p.body, '检索增强生成第二版');
  assert.equal(listRevisions(db, p.id).length, 2);
  done();
});

test('writePages：链接、引用写入；无效引用进入 dropped；资料非 ready 的引用也无效', () => {
  const { db, done } = tmpWikiDb();
  const doc = seedDoc(db, '资料甲', '## 一\n内容一\n\n## 二\n内容二');
  const r = write(db, [draft('rag', `见 [[Long Context]]。结论[^${doc}:0]，错误[^${doc}:99]`)]);
  assert.deepEqual(r.dropped, [`[^${doc}:99]`]);
  const p = getPage(db, 'rag')!;
  assert.deepEqual(
    (db.prepare('SELECT to_slug FROM wiki_links WHERE from_page = ?').all(p.id) as { to_slug: string }[]).map((x) => x.to_slug),
    ['long-context'],
  );
  assert.equal(n(db, 'SELECT count(*) AS n FROM wiki_cites WHERE page_id = ?', p.id), 1);
  assert.deepEqual(p.cites.map((c) => [c.doc, c.ord, c.title, c.valid]), [[doc, 0, '资料甲', true]]);
  done();
});

test('writePages：byUser 置 edited_by_user=1，模型再写不清零', () => {
  const { db, done } = tmpWikiDb();
  write(db, [draft('rag', 'x')], { byUser: true });
  write(db, [draft('rag', 'y')]);
  assert.equal(getPage(db, 'rag')!.edited_by_user, 1);
  done();
});

test('writePages：kind 非法、标题为空、slug 为空抛 400；正文超长截断', () => {
  const { db, done } = tmpWikiDb();
  assert.throws(() => write(db, [{ ...draft('a', 'x'), kind: 'bad' as never }]), { status: 400 });
  assert.throws(() => write(db, [{ ...draft('a', 'x'), title: ' ' }]), { status: 400 });
  assert.throws(() => write(db, [draft('///', 'x')]), { status: 400 });
  write(db, [draft('long', '字'.repeat(25000))]);
  const body = getPage(db, 'long')!.body;
  assert.ok(body.endsWith('（内容过长已截断）'));
  assert.ok([...body].length <= 20000 + 20);
  done();
});

test('softDelete：getPage 为 null、FTS 不命中、links/cites 清空；restoreSnapshot 恢复', () => {
  const { db, done } = tmpWikiDb();
  const doc = seedDoc(db, '资料', '## 一\n内容');
  write(db, [draft('rag', `检索增强生成 [[x]] [^${doc}:0]`)]);
  const id = getPage(db, 'rag')!.id;
  const del = tx(db, () => softDelete(db, createOp(db, 'revert'), id));
  assert.deepEqual([del.from_rev, del.to_rev], [1, 2]);
  assert.equal(getPage(db, 'rag'), null);
  assert.equal(listPages(db, { q: '检索增强' }).length, 0);
  assert.equal(n(db, 'SELECT count(*) AS n FROM wiki_links'), 0);
  assert.equal(n(db, 'SELECT count(*) AS n FROM wiki_cites'), 0);
  const back = tx(db, () => restoreSnapshot(db, createOp(db, 'restore'), id, 1));
  assert.deepEqual([back.from_rev, back.to_rev], [2, 3]);
  assert.equal(getPage(db, 'rag')!.body, `检索增强生成 [[x]] [^${doc}:0]`);
  assert.equal(listPages(db, { q: '检索增强' }).length, 1);
  assert.equal(n(db, 'SELECT count(*) AS n FROM wiki_links'), 1);
  assert.equal(n(db, 'SELECT count(*) AS n FROM wiki_cites'), 1);
  done();
});

test('已删除页的 slug 再写入视为恢复：id 不变，rev 递增', () => {
  const { db, done } = tmpWikiDb();
  write(db, [draft('rag', 'a')]);
  const id = getPage(db, 'rag')!.id;
  tx(db, () => softDelete(db, createOp(db, 'revert'), id));
  const r = write(db, [draft('rag', 'b')]);
  assert.deepEqual([r.changes[0].page_id, r.changes[0].from_rev, r.changes[0].to_rev], [id, 2, 3]);
  assert.equal(getPage(db, 'rag')!.body, 'b');
  done();
});

test('pruneRevisions：61 版只留最近 50 版，加上被 op 引用的第 3 版', () => {
  const { db, done } = tmpWikiDb();
  for (let i = 1; i <= 61; i++) write(db, [draft('rag', `v${i}`)]);
  const id = getPage(db, 'rag')!.id;
  db.prepare('UPDATE wiki_ops SET pages = ? WHERE id = 1').run(JSON.stringify([{ page_id: id, slug: 'rag', from_rev: 2, to_rev: 3 }]));
  db.prepare("UPDATE wiki_ops SET pages = '[]' WHERE id > 1").run();
  pruneRevisions(db, id);
  const revs = listRevisions(db, id).map((r) => r.rev);
  assert.equal(revs.length, 52);
  assert.ok(revs.includes(2) && revs.includes(3) && revs.includes(12) && !revs.includes(11));
  done();
});

test('pruneRevisions：只认最近 200 条操作的引用；写入超过 50 版时自动清理', () => {
  const { db, done } = tmpWikiDb();
  for (let i = 1; i <= 260; i++) write(db, [draft('rag', `v${i}`)]);
  const revs = listRevisions(db, getPage(db, 'rag')!.id).map((r) => r.rev);
  assert.ok(!revs.includes(1) && !revs.includes(50), '早于最近 200 条操作的版本被清理');
  assert.ok(revs.includes(60) && revs.includes(260));
  assert.ok(revs.length <= 202);
  done();
});

test('catalog：总是包含 overview 页，结果不重复', () => {
  const { db, done } = tmpWikiDb();
  write(db, [draft('ov', '全局', 'overview', '总览'), draft('rag', '检索增强生成'), draft('kv', '无关内容')]);
  const c = catalog(db, ['检索增', '索增强'], 40);
  assert.deepEqual(c.map((x) => x.slug).sort(), ['ov', 'rag']);
  const c2 = catalog(db, ['总览页'], 40);
  assert.equal(c2.filter((x) => x.slug === 'ov').length, 1);
  done();
});

test('getPage：资料删除后 cites[].valid=false；backlinks 列出链接到本页的页面', () => {
  const { db, done } = tmpWikiDb();
  const doc = seedDoc(db, '资料', '## 一\n内容');
  write(db, [draft('rag', `内容 [^${doc}:0]`), draft('kv', '参考 [[RAG]]', 'concept', 'KV')]);
  assert.deepEqual(getPage(db, 'rag')!.backlinks, [{ slug: 'kv', title: 'KV' }]);
  deleteDoc(db, doc);
  assert.deepEqual(getPage(db, 'rag')!.cites.map((c) => c.valid), [false]);
  done();
});

test('listPages：按 kind 过滤；短词退回 LIKE', () => {
  const { db, done } = tmpWikiDb();
  write(db, [draft('ov', 'x', 'overview', '总览'), draft('rag', 'AI 检索', 'concept', 'RAG')]);
  assert.deepEqual(listPages(db, { kind: 'overview' }).map((p) => p.slug), ['ov']);
  assert.deepEqual(listPages(db, { q: 'AI' }).map((p) => p.slug), ['rag']);
  done();
});

test('writePages：[[标题]] 按已有页面或同批页面的标题解析为 slug（含去掉括号说明的标题）；解析不到的保持原样', () => {
  const { db, done } = tmpWikiDb();
  write(db, [draft('reasoning-models', '定义', 'concept', '推理模型与测试时计算（Test-time Compute）')]);
  const r = write(db, [
    draft('map', '见 [[推理模型与测试时计算]]、[[推理模型与测试时计算（Test-time Compute）|这里]]、[[上下文工程总览]] 和 [[不存在的页]]', 'overview', '总览'),
    draft('context-engineering', '正文', 'concept', '上下文工程总览'),
  ]);
  assert.deepEqual(r.dropped, []);
  const p = getPage(db, 'map')!;
  assert.equal(p.body, '见 [[reasoning-models|推理模型与测试时计算]]、[[reasoning-models|这里]]、[[context-engineering|上下文工程总览]] 和 [[不存在的页]]');
  assert.deepEqual(
    (db.prepare('SELECT to_slug FROM wiki_links WHERE from_page = ? ORDER BY to_slug').all(p.id) as { to_slug: string }[]).map((x) => x.to_slug),
    ['context-engineering', 'reasoning-models', '不存在的页'].sort(),
  );
  assert.deepEqual(getPage(db, 'reasoning-models')!.backlinks, [{ slug: 'map', title: '总览' }]);
  done();
});

test('writePages：[[资料原标题]] 解析为该资料的摘要页（摘要页标题被改写过也能匹配，含同批摘要页）', () => {
  const { db, done } = tmpWikiDb();
  const a = seedDoc(db, 'Agent知识全景图谱_2026', '## 一\n内容');
  const b = seedDoc(db, '调研报告', '## 一\n内容');
  write(db, [{ ...draft(`src-${a}`, '摘要', 'source', 'Agent 知识全景图谱（2026.09 版）（资料摘要）'), sourceDoc: a }]);
  write(db, [
    draft('map', '见 [[Agent知识全景图谱_2026]]、[[agent知识全景图谱-2026|图谱]] 和 [[调研报告]]', 'overview', '总览'),
    { ...draft(`src-${b}`, '摘要', 'source', '某调研（资料摘要）'), sourceDoc: b },
  ]);
  assert.equal(getPage(db, 'map')!.body, `见 [[src-${a}|Agent知识全景图谱_2026]]、[[src-${a}|图谱]] 和 [[src-${b}|调研报告]]`);
  done();
});
