import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DB } from '../../packages/core/db.ts';
import {
  cleanNodeTitle,
  createNode,
  deleteNode,
  ensurePath,
  listNodes,
  pageNodes,
  placePage,
  renameNode,
  systemNode,
} from './tree.ts';
import { tmpWikiDb } from './testutil.ts';
import { WikiError } from './types.ts';

const count = (db: DB, sql: string, ...a: (string | number)[]) => Number((db.prepare(sql).get(...a) as { n: number }).n);
const addPage = (db: DB, slug: string): number =>
  Number(db.prepare("INSERT INTO wiki_pages(slug, kind, title, created_at, updated_at) VALUES (?, 'concept', ?, 1, 1)").run(slug, slug).lastInsertRowid);
const code = (fn: () => unknown): { status: number; message: string } => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof WikiError, String(e));
    return { status: e.status, message: e.message };
  }
  assert.fail('应当抛出 WikiError');
};

test('迁移 16：三张表存在，user_version 为 16', () => {
  const { db, done } = tmpWikiDb();
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 16);
  for (const t of ['wiki_nodes', 'wiki_page_node', 'wiki_node_undo']) {
    assert.equal(count(db, 'SELECT count(*) AS n FROM sqlite_master WHERE name = ?', t), 1, t);
  }
  done();
});

test('cleanNodeTitle：控制字符、首尾空白、超长截断、空串', () => {
  assert.equal(cleanNodeTitle('  Agent\t开发\n '), 'Agent 开发');
  assert.equal(cleanNodeTitle('ＡＢＣ'), 'ABC');
  assert.equal(cleanNodeTitle('a\u0000b\u202e'), 'ab');
  assert.equal(cleanNodeTitle('甲'.repeat(60)), '甲'.repeat(40));
  assert.equal(cleanNodeTitle('   '), '');
  assert.equal(cleanNodeTitle(42), '');
  assert.equal(cleanNodeTitle(null), '');
});

test('ensurePath：逐层建，同名（含大小写 / 全半角差异）复用', () => {
  const { db, done } = tmpWikiDb();
  const a = ensurePath(db, ['Agent', '上下文']);
  assert.ok(a);
  assert.equal(ensurePath(db, [' agent ', '上下文']), a);
  assert.equal(ensurePath(db, ['ＡＧＥＮＴ', '上下文']), a);
  assert.equal(listNodes(db).length, 2);
  const nodes = listNodes(db);
  assert.equal(nodes.find((n) => n.title === '上下文')?.parent_id, nodes.find((n) => n.title === 'Agent')?.id);
  assert.equal(nodes.every((n) => !n.manual), true, '自动建的节点不标 manual');
  done();
});

test('ensurePath：超过 3 层截断到第 3 层', () => {
  const { db, done } = tmpWikiDb();
  const id = ensurePath(db, ['Agent', '上下文', '提示词', '更深']);
  assert.equal(listNodes(db).length, 3);
  assert.equal(listNodes(db).find((n) => n.id === id)?.title, '提示词');
  done();
});

test('ensurePath：budget 用完后返回已匹配的最深一层；空路径返回 null', () => {
  const { db, done } = tmpWikiDb();
  const top = ensurePath(db, ['领域']);
  const r = ensurePath(db, ['领域', '主题一', '主题二'], { budget: { left: 1 } });
  assert.equal(listNodes(db).length, 2, '只新建了 1 个');
  assert.equal(listNodes(db).find((n) => n.id === r)?.title, '主题一');
  assert.equal(ensurePath(db, ['新A', '新B'], { budget: { left: 0 } }), null, '一层都没有时返回 null');
  assert.equal(ensurePath(db, ['领域', '主题一', 'x'], { budget: { left: 0 } }), r);
  assert.ok(top);
  assert.equal(ensurePath(db, []), null);
  assert.equal(ensurePath(db, ['', '  ']), null);
  done();
});

test('ensurePath：节点总数到 200 时不再新建', () => {
  const { db, done } = tmpWikiDb();
  for (let i = 0; i < 199; i++) db.prepare('INSERT INTO wiki_nodes(parent_id, title, created_at) VALUES (NULL, ?, 1)').run(`n${i}`);
  const id = ensurePath(db, ['新A', '新B']);
  assert.equal(listNodes(db).length, 200);
  assert.equal(listNodes(db).find((n) => n.id === id)?.title, '新A');
  assert.equal(ensurePath(db, ['新C']), null, '已满且没有可匹配的层');
  done();
});

test('createNode / renameNode：重名、深度、总数、名称与父节点的错误码和文案', () => {
  const { db, done } = tmpWikiDb();
  const a = createNode(db, '技术', null);
  const b = createNode(db, '架构', a);
  const c = createNode(db, '分层', b);
  assert.equal(listNodes(db).find((n) => n.id === c)?.manual, true);
  assert.deepEqual(code(() => createNode(db, ' 技术 ', null)), { status: 409, message: '同级已有同名节点' });
  assert.equal(createNode(db, '技术', b) > 0, true, '不同父节点下可以同名');
  assert.deepEqual(code(() => createNode(db, '太深', c)), { status: 400, message: '最多 3 层' });
  assert.deepEqual(code(() => createNode(db, '  ', null)), { status: 400, message: '名称需在 1–40 字之间' });
  assert.deepEqual(code(() => createNode(db, 5, null)), { status: 400, message: '名称需在 1–40 字之间' });
  assert.deepEqual(code(() => createNode(db, 'x', 9999)), { status: 404, message: '节点不存在' });
  renameNode(db, c, '分层设计');
  assert.equal(listNodes(db).find((n) => n.id === c)?.title, '分层设计');
  assert.deepEqual(code(() => renameNode(db, a, '')), { status: 400, message: '名称需在 1–40 字之间' });
  assert.deepEqual(code(() => renameNode(db, 9999, 'x')), { status: 404, message: '节点不存在' });
  done();
});

test('renameNode：同级与自己同名（改大小写）允许，与兄弟重名 409', () => {
  const { db, done } = tmpWikiDb();
  const a = createNode(db, 'agent', null);
  createNode(db, '商业', null);
  renameNode(db, a, 'Agent');
  assert.equal(listNodes(db).find((n) => n.id === a)?.title, 'Agent');
  assert.deepEqual(code(() => renameNode(db, a, '商业')), { status: 409, message: '同级已有同名节点' });
  done();
});

test('createNode：总数到 200 时 400', () => {
  const { db, done } = tmpWikiDb();
  for (let i = 0; i < 200; i++) db.prepare('INSERT INTO wiki_nodes(parent_id, title, created_at) VALUES (NULL, ?, 1)').run(`n${i}`);
  assert.deepEqual(code(() => createNode(db, '多了', null)), { status: 400, message: '最多 200 个节点' });
  done();
});

test('deleteNode：非空 409，空节点删除成功，只挂着已软删除页面的节点可删', () => {
  const { db, done } = tmpWikiDb();
  const a = createNode(db, '甲', null);
  const b = createNode(db, '乙', a);
  assert.deepEqual(code(() => deleteNode(db, a)), { status: 409, message: '节点下还有内容' }, '有子节点');
  const p = addPage(db, 'p1');
  placePage(db, p, b);
  assert.deepEqual(code(() => deleteNode(db, b)), { status: 409, message: '节点下还有内容' }, '有页面');
  db.prepare('UPDATE wiki_pages SET deleted = 1 WHERE id = ?').run(p);
  deleteNode(db, b);
  assert.equal(count(db, 'SELECT count(*) AS n FROM wiki_page_node'), 0, '已软删除页面的归属行一并清掉');
  deleteNode(db, a);
  assert.equal(listNodes(db).length, 0);
  assert.deepEqual(code(() => deleteNode(db, a)), { status: 404, message: '节点不存在' });
  done();
});

test('listNodes：own / total 只数未删除页面；软删除再恢复后计数回来', () => {
  const { db, done } = tmpWikiDb();
  const a = createNode(db, '甲', null);
  const b = createNode(db, '乙', a);
  const p1 = addPage(db, 'p1');
  const p2 = addPage(db, 'p2');
  placePage(db, p1, a);
  placePage(db, p2, b);
  const get = () => {
    const m = new Map(listNodes(db).map((n) => [n.id, n]));
    return { a: m.get(a)!, b: m.get(b)! };
  };
  assert.deepEqual([get().a.own, get().a.total, get().b.own, get().b.total], [1, 2, 1, 1]);
  db.prepare('UPDATE wiki_pages SET deleted = 1 WHERE id = ?').run(p2);
  assert.deepEqual([get().a.own, get().a.total, get().b.own, get().b.total], [1, 1, 0, 0]);
  db.prepare('UPDATE wiki_pages SET deleted = 0 WHERE id = ?').run(p2);
  assert.deepEqual([get().a.own, get().a.total, get().b.own, get().b.total], [1, 2, 1, 1]);
  done();
});

test('placePage：manual 标记写入，换节点覆盖，nodeId 为 null 删除归属', () => {
  const { db, done } = tmpWikiDb();
  const a = createNode(db, '甲', null);
  const b = createNode(db, '乙', null);
  const p = addPage(db, 'p1');
  placePage(db, p, a);
  assert.deepEqual(pageNodes(db).get(p), { node_id: a, manual: false });
  placePage(db, p, b, { manual: true });
  assert.deepEqual(pageNodes(db).get(p), { node_id: b, manual: true });
  placePage(db, p, null);
  assert.equal(pageNodes(db).has(p), false);
  done();
});

test('systemNode：重复调用返回同一 id，不标 manual；满 200 时返回 null', () => {
  const { db, done } = tmpWikiDb();
  const a = systemNode(db, '资料摘要');
  assert.ok(a);
  assert.equal(systemNode(db, '资料摘要'), a);
  assert.notEqual(systemNode(db, '问答'), a);
  assert.equal(listNodes(db).every((n) => !n.manual && n.parent_id === null), true);
  done();
});

test('systemNode：节点已满且不存在时返回 null', () => {
  const { db, done } = tmpWikiDb();
  for (let i = 0; i < 200; i++) db.prepare('INSERT INTO wiki_nodes(parent_id, title, created_at) VALUES (NULL, ?, 1)').run(`n${i}`);
  assert.equal(systemNode(db, '问答'), null);
  done();
});
