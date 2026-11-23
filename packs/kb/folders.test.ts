import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertFolder, createFolder, deleteFolder, ensureFolders, folderPath, folderPaths, listFolders, updateFolder } from './folders.ts';
import { tmpKbDb } from './testutil.ts';
import type { DB } from '../../packages/core/db.ts';

const err = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return { status: (e as { status?: number }).status, message: (e as Error).message };
  }
  return null;
};
const note = (db: DB, folder: number | null) =>
  db.prepare("INSERT INTO kb_docs(folder_id, kind, title, created_at, updated_at) VALUES (?, 'note', 't', 1, 1)").run(folder);

test('目录：名称校验、去空白、重名、不存在的父目录', () => {
  const { db, done } = tmpKbDb();
  const a = createFolder(db, ' 竞品 ', null);
  assert.equal(listFolders(db).folders[0].name, '竞品');
  const bad = { status: 400, message: '目录名需为 1–40 字，且不能包含 / \\ 或控制字符' };
  for (const n of ['', '   ', 'a/b', 'a\\b', 'x\u0001', '长'.repeat(41), 3]) assert.deepEqual(err(() => createFolder(db, n, null)), bad, String(n));
  createFolder(db, '长'.repeat(40), null);
  assert.deepEqual(err(() => createFolder(db, '竞品', null)), { status: 400, message: '同一层级已有同名目录' });
  createFolder(db, '竞品', a);
  assert.deepEqual(err(() => createFolder(db, 'x', 999)), { status: 404, message: '目录不存在' });
  assert.deepEqual(err(() => updateFolder(db, a, { name: '长'.repeat(40) })), { status: 400, message: '同一层级已有同名目录' });
  done();
});

test('目录：最多 5 层（移动时按整棵子树计算）、循环移动被拒', () => {
  const { db, done } = tmpKbDb();
  let p: number | null = null;
  const chain: number[] = [];
  for (let i = 1; i <= 5; i++) chain.push((p = createFolder(db, `L${i}`, p)));
  assert.deepEqual(err(() => createFolder(db, 'L6', chain[4])), { status: 400, message: '目录最多 5 层' });
  const t1 = createFolder(db, 'T1', null);
  const t2 = createFolder(db, 'T2', t1);
  createFolder(db, 'T3', t2);
  assert.deepEqual(err(() => updateFolder(db, t1, { parentId: chain[2] })), { status: 400, message: '目录最多 5 层' });
  updateFolder(db, t1, { parentId: chain[1] });
  assert.equal(folderPath(db, t2), 'L1/L2/T1/T2');
  assert.deepEqual(err(() => updateFolder(db, chain[0], { parentId: chain[3] })), { status: 400, message: '不能移动到自身或其子目录下' });
  assert.deepEqual(err(() => updateFolder(db, chain[0], { parentId: chain[0] })), { status: 400, message: '不能移动到自身或其子目录下' });
  updateFolder(db, t1, { parentId: null });
  assert.equal(folderPath(db, t2), 'T1/T2');
  done();
});

test('目录：最多 200 个', () => {
  const { db, done } = tmpKbDb();
  for (let i = 0; i < 200; i++) createFolder(db, `f${i}`, null);
  assert.deepEqual(err(() => createFolder(db, 'x', null)), { status: 400, message: '目录最多 200 个' });
  done();
});

test('目录：只能删空目录；计数、未归类、路径、排序', () => {
  const { db, done } = tmpKbDb();
  const a = createFolder(db, '产品', null);
  const b = createFolder(db, '竞品', a);
  const c = createFolder(db, '运营', null);
  note(db, b);
  note(db, b);
  note(db, null);
  const l = listFolders(db);
  assert.equal(l.folders.find((f) => f.id === b)!.count, 2);
  assert.equal(l.folders.find((f) => f.id === a)!.count, 0);
  assert.equal(l.unfiled, 1);
  assert.equal(l.total, 3);
  assert.equal(folderPath(db, b), '产品/竞品');
  assert.equal(folderPath(db, null), '未归类');
  assert.deepEqual(folderPaths(db), [
    { id: a, path: '产品' },
    { id: b, path: '产品/竞品' },
    { id: c, path: '运营' },
  ]);
  assert.deepEqual(err(() => deleteFolder(db, a)), { status: 409, message: '目录不为空' });
  assert.deepEqual(err(() => deleteFolder(db, b)), { status: 409, message: '目录不为空' });
  deleteFolder(db, c);
  assert.deepEqual(err(() => deleteFolder(db, c)), { status: 404, message: '目录不存在' });
  assert.deepEqual(err(() => assertFolder(db, c)), { status: 404, message: '目录不存在' });
  assertFolder(db, null);
  const d = createFolder(db, '设计', null);
  updateFolder(db, d, { sort: -1 });
  assert.equal(listFolders(db).folders.filter((f) => f.parent_id === null)[0].id, d);
  assert.equal(listFolders(db).folders.find((f) => f.id === a)!.sort, 0);
  done();
});

const count = (db: DB) => Number((db.prepare('SELECT COUNT(*) AS n FROM kb_folders').get() as { n: number }).n);

test('ensureFolders：逐层建、同名复用、空串映射到父目录', () => {
  const { db, done } = tmpKbDb();
  const p = createFolder(db, '导入', null);
  const old = createFolder(db, '竞品', p);
  const r = ensureFolders(db, p, ['', '竞品', '竞品/定价', '竞品/定价', '访谈']);
  assert.equal(r.capped, false);
  assert.equal(r.map[''], p);
  assert.equal(r.map['竞品'], old, '同名复用');
  assert.equal(folderPath(db, r.map['竞品/定价']), '导入/竞品/定价');
  assert.equal(folderPath(db, r.map['访谈']), '导入/访谈');
  assert.equal(count(db), 4, '只新建 定价 与 访谈');
  const top = ensureFolders(db, null, ['', '新顶层/子']);
  assert.equal(top.map[''], null);
  assert.equal(folderPath(db, top.map['新顶层/子']), '新顶层/子');
  done();
});

test('ensureFolders：清洗名称（首尾空白、控制字符与反斜杠变空格、超 40 字截断）；. 与 .. 与空段丢弃', () => {
  const { db, done } = tmpKbDb();
  const long = '长'.repeat(50);
  const r = ensureFolders(db, null, ['  资料 /./a\u0007b/../c\\d//', long]);
  assert.equal(folderPath(db, r.map['  资料 /./a\u0007b/../c\\d//']), '资料/a b/c d');
  assert.equal(folderPath(db, r.map[long]), '长'.repeat(40));
  const dots = ensureFolders(db, null, ['./..', '   ']);
  assert.deepEqual([dots.map['./..'], dots.map['   ']], [null, null], '全是空段时映射到父目录');
  done();
});

test('ensureFolders：超过 5 层的段不再建，映射到第 5 层', () => {
  const { db, done } = tmpKbDb();
  const p = createFolder(db, '一', null);
  const r = ensureFolders(db, p, ['二/三/四/五/六/七']);
  assert.equal(folderPath(db, r.map['二/三/四/五/六/七']), '一/二/三/四/五');
  assert.equal(count(db), 5);
  done();
});

test('ensureFolders：建到 200 个停止，capped=true，之后的路径映射到已建好的最深一层', () => {
  const { db, done } = tmpKbDb();
  for (let i = 0; i < 197; i++) createFolder(db, `已有${i}`, null);
  const r = ensureFolders(db, null, ['甲/乙', '甲/乙/丙/丁', '戊']);
  assert.equal(r.capped, true);
  assert.equal(count(db), 200);
  assert.equal(folderPath(db, r.map['甲/乙']), '甲/乙');
  assert.equal(folderPath(db, r.map['甲/乙/丙/丁']), '甲/乙/丙');
  assert.equal(r.map['戊'], null, '一层都建不了时放在父目录');
  done();
});

test('ensureFolders：parentId 不存在 404；中途失败整批回滚', () => {
  const { db, done } = tmpKbDb();
  assert.deepEqual(err(() => ensureFolders(db, 999, ['a'])), { status: 404, message: '目录不存在' });
  assert.throws(() => ensureFolders(db, null, ['好的/目录', 42 as unknown as string]));
  assert.equal(count(db), 0, '非法输入时一个都不建');
  done();
});
