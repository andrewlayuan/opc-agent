import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, type DB } from '../../packages/core/db.ts';
import { createVersion, finish, getVersion, listVersions, recover, restart, saveOutline, savePages, setProgress } from './store.ts';
import { ProtoError, RESTART_MSG, type Outline } from './types.ts';

function setup(): DB {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO pm_reviews(id, created_at, updated_at, status, mode, input) VALUES (1, 1, 1, 'done', 'prd', '律审通')").run();
  db.prepare("INSERT INTO pm_versions(review_id, n, created_at, source, content) VALUES (1, 1, 1, 'initial', '# PRD')").run();
  return db;
}
const v1 = { baseVersionN: 1, fromN: null, request: '' };
const outline: Outline = {
  product: '律审通',
  device: 'phone',
  theme: 'blue',
  nav: ['home'],
  data: {},
  pages: [{ slug: 'home', title: '首页', purpose: 'p', content: 'c', links: [] }],
};
const throws409 = (fn: () => unknown, msg: string) =>
  assert.throws(fn, (e: unknown) => e instanceof ProtoError && e.status === 409 && e.message === msg);

test('迁移 8：user_version、UNIQUE(review_id, n)、删除评审级联', () => {
  const db = setup();
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 14);
  const row = createVersion(db, 1, v1);
  assert.throws(() => db.prepare("INSERT INTO pm_prototypes(review_id, n, created_at, base_version_n) VALUES (1, ?, 1, 1)").run(row.n), /UNIQUE/);
  db.prepare('DELETE FROM pm_reviews WHERE id = 1').run();
  assert.equal((db.prepare('SELECT count(*) AS n FROM pm_prototypes').get() as { n: number }).n, 0);
});

test('createVersion：同一评审已有 running 时 409；finish 后得到 n = 2', () => {
  const db = setup();
  const a = createVersion(db, 1, v1);
  assert.equal(a.n, 1);
  assert.equal(a.status, 'running');
  assert.deepEqual(a.progress, { stage: 'queued', done: 0, total: 0 });
  assert.equal(a.outline, null);
  assert.deepEqual(a.pages, []);
  throws409(() => createVersion(db, 1, v1), '原型正在生成');
  assert.equal(finish(db, a.id, { status: 'done' }), true);
  const b = createVersion(db, 1, { baseVersionN: 1, fromN: 1, request: '加登录' });
  assert.equal(b.n, 2);
  assert.equal(b.from_n, 1);
  assert.equal(b.request, '加登录');
});

test('版本上限：保留 20 版且 v1 永不删除，版本号不复用', () => {
  const db = setup();
  for (let i = 0; i < 22; i++) finish(db, createVersion(db, 1, v1).id, { status: 'done' });
  const ns = listVersions(db, 1).map((v) => v.n);
  assert.deepEqual(ns, [1, ...Array.from({ length: 19 }, (_, i) => i + 4)]);
  assert.equal(createVersion(db, 1, v1).n, 23);
});

test('finish 之后写入都返回 false', () => {
  const db = setup();
  const a = createVersion(db, 1, v1);
  assert.equal(setProgress(db, a.id, { stage: 'outline', done: 0, total: 0 }), true);
  assert.equal(saveOutline(db, a.id, outline), true);
  assert.equal(savePages(db, a.id, [{ slug: 'home', title: '首页', html: '<div>x</div>', error: null }]), true);
  assert.equal(finish(db, a.id, { status: 'done', note: '首版' }), true);
  assert.equal(finish(db, a.id, { status: 'error', error: 'x' }), false);
  assert.equal(setProgress(db, a.id, { stage: 'pages', done: 1, total: 1 }), false);
  assert.equal(savePages(db, a.id, []), false);
  const got = getVersion(db, 1, 1)!;
  assert.equal(got.status, 'done');
  assert.equal(got.note, '首版');
  assert.ok(got.finished_at! > 0);
  assert.deepEqual(got.outline, outline);
  assert.equal(got.pages[0].html, '<div>x</div>');
  assert.equal(getVersion(db, 1, 9), null);
});

test('restart：只能重试失败版本；同评审已有 running 时 409', () => {
  const db = setup();
  const a = createVersion(db, 1, v1);
  finish(db, a.id, { status: 'done' });
  throws409(() => restart(db, 1, 1), '只能重试失败的版本');
  const b = createVersion(db, 1, v1);
  setProgress(db, b.id, { stage: 'pages', done: 2, total: 3 });
  finish(db, b.id, { status: 'error', error: '页面生成失败，请重试' });
  const c = createVersion(db, 1, v1);
  throws409(() => restart(db, 1, 2), '原型正在生成');
  finish(db, c.id, { status: 'done' });
  const r = restart(db, 1, 2);
  assert.equal(r.status, 'running');
  assert.equal(r.error, null);
  assert.equal(r.finished_at, null);
  assert.deepEqual(r.progress, { stage: 'queued', done: 0, total: 0 });
  assert.throws(() => restart(db, 1, 9), (e: unknown) => e instanceof ProtoError && e.status === 404);
});

test('recover：把 running 改为 error 并返回条数', () => {
  const db = setup();
  db.prepare("INSERT INTO pm_reviews(id, created_at, updated_at, status, mode, input) VALUES (2, 1, 1, 'done', 'prd', 'x')").run();
  const a = createVersion(db, 1, v1);
  createVersion(db, 2, v1);
  finish(db, a.id, { status: 'done' });
  createVersion(db, 1, v1);
  assert.equal(recover(db), 2);
  assert.equal(getVersion(db, 1, 2)!.error, RESTART_MSG);
  assert.equal(getVersion(db, 2, 1)!.status, 'error');
  assert.equal(getVersion(db, 1, 1)!.status, 'done');
});

test('listVersions：页面只带 slug/title/error，附带 product、device', () => {
  const db = setup();
  const a = createVersion(db, 1, v1);
  finish(db, a.id, { status: 'error', error: 'x' });
  const b = createVersion(db, 1, v1);
  saveOutline(db, b.id, outline);
  savePages(db, b.id, [{ slug: 'home', title: '首页', html: '<div>大段 HTML</div>', error: null }]);
  const [m1, m2] = listVersions(db, 1);
  assert.equal(m1.product, null);
  assert.equal(m1.device, null);
  assert.deepEqual(m1.pages, []);
  assert.equal(m2.product, '律审通');
  assert.equal(m2.device, 'phone');
  assert.deepEqual(m2.pages, [{ slug: 'home', title: '首页', error: null }]);
  assert.equal('outline' in m2, false);
});
