import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractPage, parseOutline, parsePlan } from './parse.ts';
import { ProtoError, type Outline } from './types.ts';

const page = (slug: unknown, extra: Record<string, unknown> = {}) => ({ slug, title: `页 ${String(slug)}`, purpose: 'p', content: 'c', links: [], ...extra });
const base = (pages: unknown[], extra: Record<string, unknown> = {}) => ({ product: '律审通', device: 'phone', theme: 'green', nav: [], data: {}, pages, ...extra });

test('parseOutline：页数上限 10，空或非数组返回 null', () => {
  const o = parseOutline(base(Array.from({ length: 12 }, (_, i) => page(`s${i}`))))!;
  assert.equal(o.pages.length, 10);
  assert.equal(o.pages[9].slug, 's9');
  assert.equal(parseOutline(base([])), null);
  assert.equal(parseOutline(base('x' as unknown as unknown[])), null);
  assert.equal(parseOutline(null), null);
  assert.equal(parseOutline('{}'), null);
  assert.equal(parseOutline(base([page('only')]))!.pages.length, 1);
});

test('parseOutline：不合法和重复的 slug 按位置重命名，nav 与 links 同步更新，重名引用指向第一页', () => {
  const o = parseOutline(
    base(
      [
        page('home', { links: ['订单 详情', 'home'] }),
        page('订单 详情', { links: ['home'] }),
        page('home', { links: ['home'] }),
        page('Me'),
      ],
      { nav: ['home', '订单 详情', 'home', 'nope'] },
    ),
  )!;
  assert.deepEqual(
    o.pages.map((p) => p.slug),
    ['home', 'p2', 'p3', 'me'],
  );
  assert.deepEqual(o.pages[0].links, ['p2', 'home']);
  assert.deepEqual(o.pages[1].links, ['home']);
  assert.deepEqual(o.pages[2].links, ['home']);
  assert.deepEqual(o.nav, ['home', 'p2']);
});

test('parseOutline：生成的名字与已有 slug 冲突时另取', () => {
  const o = parseOutline(base([page('p2'), page('坏')]))!;
  assert.deepEqual(
    o.pages.map((p) => p.slug),
    ['p2', 'p2-2'],
  );
});

test('parseOutline：device、theme 不合法时用默认值；标题、说明、产品名截断；nav 最多 5 个', () => {
  const pages = Array.from({ length: 7 }, (_, i) => page(`s${i}`));
  pages[0].title = '标'.repeat(25);
  (pages[0] as Record<string, unknown>).purpose = '用'.repeat(500);
  const o = parseOutline(base(pages, { device: 'tablet', theme: 'pink', product: '产'.repeat(30), nav: pages.map((p) => p.slug) }))!;
  assert.equal(o.device, 'desktop');
  assert.equal(o.theme, 'blue');
  assert.equal(o.product, '产'.repeat(20));
  assert.equal(o.pages[0].title, '标'.repeat(20));
  assert.equal(o.pages[0].purpose, '用'.repeat(400));
  assert.deepEqual(o.nav, ['s0', 's1', 's2', 's3', 's4']);
  const ok = parseOutline(base([page('a')], { device: 'phone', theme: 'rose' }))!;
  assert.equal(ok.device, 'phone');
  assert.equal(ok.theme, 'rose');
});

test('parseOutline：data 超过 4096 字节或不是对象时为 {}；links 不是字符串数组时为 []', () => {
  assert.deepEqual(parseOutline(base([page('a')], { data: { big: 'x'.repeat(5000) } }))!.data, {});
  assert.deepEqual(parseOutline(base([page('a')], { data: ['x'] }))!.data, {});
  assert.deepEqual(parseOutline(base([page('a')], { data: { users: ['张三'] } }))!.data, { users: ['张三'] });
  assert.deepEqual(parseOutline(base([page('a', { links: 'b' }), page('b')]))!.pages[0].links, []);
  assert.deepEqual(parseOutline(base([page('a', { links: ['b', 3] }), page('b')]))!.pages[0].links, []);
  assert.deepEqual(parseOutline(base([page('a', { links: ['b', 'nope', 'b'] }), page('b')]))!.pages[0].links, ['b']);
});

const current: Outline = parseOutline(base([page('home'), page('login'), page('me')]))!;
const plan = (pages: unknown, extra: Record<string, unknown> = {}) => ({ note: '登录页增加微信登录', outline: base([page('home'), page('login'), page('me')]), pages, ...extra });
const bad = (fn: () => unknown, msg: string) => assert.throws(fn, (e: unknown) => e instanceof ProtoError && e.status === 400 && e.message === msg);

test('parsePlan：丢弃不在新大纲里的页面，新页面自动加入', () => {
  const r = parsePlan(
    plan(
      [
        { slug: 'login', change: '加微信登录' },
        { slug: 'nope', change: 'x' },
        { slug: 'login', change: '重复' },
      ],
      { outline: base([page('home'), page('login'), page('pay')]) },
    ),
    current,
  );
  assert.equal(r.note, '登录页增加微信登录');
  assert.deepEqual(
    r.outline.pages.map((p) => p.slug),
    ['home', 'login', 'pay'],
  );
  assert.deepEqual(r.pages, [
    { slug: 'login', change: '加微信登录' },
    { slug: 'pay', change: '新页面' },
  ]);
  assert.deepEqual(parsePlan(plan([{ slug: 'me' }]), current).pages, [{ slug: 'me', change: '按修改要求调整这一页' }]);
});

test('parsePlan：超过 10 页报「改动太大」，note 或 pages 为空、大纲不合法报「没理解」', () => {
  const many = Array.from({ length: 11 }, (_, i) => page(`n${i}`));
  bad(() => parsePlan(plan([], { outline: base(many) }), current), '改动太大，建议按新 PRD 重新生成');
  bad(() => parsePlan(plan([{ slug: 'login', change: 'x' }], { note: ' ' }), current), '没理解修改要求，请换个说法');
  bad(() => parsePlan(plan([]), current), '没理解修改要求，请换个说法');
  bad(() => parsePlan(plan('x'), current), '没理解修改要求，请换个说法');
  bad(() => parsePlan(plan([{ slug: 'login', change: 'x' }], { outline: base([]) }), current), '没理解修改要求，请换个说法');
  bad(() => parsePlan(null, current), '没理解修改要求，请换个说法');
});

test('extractPage：去代码块、取 main 内容、判断截断', () => {
  assert.deepEqual(extractPage('```html\n<main><div>x</div></main>\n```'), { html: '<div>x</div>', truncated: false });
  assert.deepEqual(extractPage('说明文字<main class="a">x</main>多余'), { html: 'x', truncated: false });
  assert.deepEqual(extractPage('<MAIN>a<main>b</main>c</Main>'), { html: 'a<main>b</main>c', truncated: false });
  assert.equal(extractPage('<main><div>x').truncated, true);
  assert.equal(extractPage('<main').truncated, true);
  assert.equal(extractPage('<mainly>x</mainly>').truncated, false);
});

test('extractPage：Review Focus 5 —— 整份文档没有 main 时取 body，不算截断', () => {
  const r = extractPage('<!doctype html><html><head><style>a{}</style></head><body><div>x</div></body></html>');
  assert.deepEqual(r, { html: '<div>x</div>', truncated: false });
  assert.deepEqual(extractPage('<body class="x"><p>y'), { html: '<p>y', truncated: false });
  assert.deepEqual(extractPage('  <div>x</div>\n'), { html: '<div>x</div>', truncated: false });
});
