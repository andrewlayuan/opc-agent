import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewView, VersionView } from './advisor.ts';
import { escapeHtml, exportMarkdown, renderPrintHtml } from './render.ts';

const view = (o: Partial<ReviewView> = {}): ReviewView => ({
  id: 12,
  created_at: Date.UTC(2026, 10, 10, 2, 0),
  finished_at: null,
  updated_at: Date.UTC(2026, 10, 10, 2, 0),
  status: 'done',
  mode: 'idea',
  mode_label: '点子快评',
  input: '原始需求',
  skills: ['pre-mortem'],
  content: null,
  error: null,
  refs: [],
  latest: 1,
  versions: [],
  messages: [],
  ...o,
});
const ver = (content: string, n = 1, source: VersionView['source'] = 'ai_initial'): VersionView => ({ n, source, created_at: Date.UTC(2026, 10, 10, 3, 30), note: null, content });

test('escapeHtml：转义五种字符', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

test('打印页：转义注入内容，不输出脚本和链接，结构正确渲染', () => {
  const html = renderPrintHtml(
    view({ input: '<img src=x onerror=alert(1)>' }),
    ver('# 标题\n\n- **重点** `code`\n1. 第一\n\n> 引用\n\n---\n\n| a | b |\n|---|---|\n| <script>x</script> | "q" |\n\n```\n<b>raw</b>\n```\n\n普通段落 [1]'),
    [{ n: 1, id: 1, title: '<i>t</i>', url: 'https://a.com', source: 's' }],
  );
  assert.match(html, /^<!doctype html>/);
  assert.ok(!/<script/i.test(html));
  const tags = html.replace('<link rel="stylesheet" href="/print.css">', '').match(/<[a-z][^>]*>/gi) ?? [];
  assert.ok(!tags.some((t) => /\s(href|src|style|on\w+)=/i.test(t)), tags.filter((t) => /=/.test(t)).join(' '));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<li><strong>重点<\/strong> <code>code<\/code><\/li>/);
  assert.match(html, /<ol>\s*<li>第一<\/li>/);
  assert.match(html, /<blockquote>引用<\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<table>[\s\S]*<th>a<\/th>[\s\S]*<td>&lt;script&gt;x&lt;\/script&gt;<\/td>/);
  assert.match(html, /<pre><code>&lt;b&gt;raw&lt;\/b&gt;<\/code><\/pre>/);
  assert.match(html, /&quot;q&quot;/);
  assert.match(html, /&lt;i&gt;t&lt;\/i&gt;/);
  assert.match(html, /普通段落 \[1\]/);
  assert.match(html, /产品顾问评审 · v1/);
  assert.match(html, /2026年11月10日/);
});

test('Markdown 导出：头部、正文和引用来源', () => {
  const md = exportMarkdown(view({ input: '第一行\n第二行' }), ver('正文', 3, 'manual'), [{ n: 1, id: 1, title: 'T', url: 'https://a.com', source: 'S' }]);
  assert.match(md, /^# 产品顾问评审 · v3\n/);
  assert.match(md, /方案：点子快评/);
  assert.match(md, /版本：v3（手动修改）/);
  assert.match(md, /> 第一行\n> 第二行/);
  assert.match(md, /\n---\n\n正文\n/);
  assert.match(md, /## 引用来源\n\[1\] T（S） https:\/\/a\.com/);
  assert.ok(!exportMarkdown(view(), ver('正文'), []).includes('引用来源'));
});
