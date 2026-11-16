import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { assemble, protoCsp, protoFileName, SHELL } from './assemble.ts';
import type { Outline, ProtoRow } from './types.ts';

const outline: Outline = {
  product: '律审通',
  device: 'phone',
  theme: 'green',
  nav: ['home', 'detail'],
  data: {},
  pages: [
    { slug: 'home', title: '首页', purpose: '展示入口', content: '入口说明', links: [] },
    { slug: 'detail', title: '订单详情', purpose: '看详情', content: '详情说明', links: [] },
  ],
};

const row = (over: Partial<ProtoRow> = {}): ProtoRow => ({
  id: 1,
  review_id: 8,
  n: 3,
  created_at: 100,
  finished_at: 200,
  status: 'done',
  base_version_n: 2,
  from_n: null,
  request: '生成原型',
  note: '',
  progress: { stage: 'pages', done: 2, total: 2 },
  outline,
  pages: [
    { slug: 'home', title: '首页', html: '<div class="card">首页</div>', error: null },
    { slug: 'detail', title: '订单详情', html: '', error: '页面生成失败' },
  ],
  error: null,
  ...over,
});

test('protoCsp：脚本哈希精确，frame-ancestors 只在响应头 CSP 里', () => {
  const header = protoCsp(false);
  assert.ok(header.includes(`script-src 'sha256-${SHELL.hash}'`));
  assert.ok(header.includes("frame-ancestors 'self'"));
  assert.ok(!protoCsp(true).includes('frame-ancestors'));
});

test('assemble：meta CSP 值与 protoCsp(true) 一致；只有一个可执行脚本且哈希匹配', () => {
  const html = assemble(row());
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  assert.ok(meta);
  assert.equal(meta[1], protoCsp(true));
  assert.equal((html.match(/<script>/g) || []).length, 1);
  const script = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(script);
  assert.equal(createHash('sha256').update(script[1]).digest('base64'), SHELL.hash);
  assert.equal(script[1], SHELL.js);
});

test('assemble：产品名里的 </script> 不进入数据块，标题被转义', () => {
  const html = assemble(row({ outline: { ...outline, product: '</script><script>alert(1)' } }));
  const data = /<script type="application\/json" id="proto-data">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(data);
  assert.ok(!data[1].includes('</script'));
  assert.equal(JSON.parse(data[1]).outline.product, '</script><script>alert(1)');
  assert.ok(html.includes('<title>&lt;/script&gt;&lt;script&gt;alert(1) · 原型 v3</title>'));
});

test('assemble：opts.device 覆盖大纲 device，主题类来自大纲；失败页输出占位', () => {
  const html = assemble(row(), { device: 'desktop' });
  assert.ok(html.includes('<body id="proto-body" class="desktop theme-green">'));
  assert.ok(assemble(row()).includes('<body id="proto-body" class="phone theme-green">'));
  assert.ok(html.includes('<section class="pg" data-slug="detail" data-title="订单详情"><div class="note-slot" id="proto-note-detail"></div><main><div class="empty">此页生成失败</div></main></section>'));
});

test('protoFileName：文件名去掉非法字符，空产品名回落为「原型」', () => {
  assert.equal(protoFileName(row({ outline: { ...outline, product: '律/审"通\n' } })), '律审通-原型-v3.html');
  assert.equal(protoFileName(row({ outline: { ...outline, product: '' } })), '原型-原型-v3.html');
});
