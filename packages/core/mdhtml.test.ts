import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escHtml, renderMdHtml } from './mdhtml.ts';

test('renderMdHtml：转义、标题降级、列表、引用', () => {
  const html = renderMdHtml('# 标题\n<script>x</script>\n\n- a & b\n- **c**\n\n> 引');
  assert.ok(html.includes('<h2>标题</h2>'));
  assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(html.includes('<ul><li>a &amp; b</li><li><strong>c</strong></li></ul>'));
  assert.ok(html.includes('<blockquote><p>引</p></blockquote>'));
});

test('renderMdHtml：管道表格，首行表头，分隔行跳过，\\| 还原，单元格转义', () => {
  assert.equal(
    renderMdHtml('| 名称 | 用途 |\n| --- | --- |\n| <b>A</b> | 统计 \\| 分析 |'),
    '<table><tr><th>名称</th><th>用途</th></tr><tr><td>&lt;b&gt;A&lt;/b&gt;</td><td>统计 | 分析</td></tr></table>',
  );
});

test('renderMdHtml：表格前后的段落各自成段', () => {
  assert.equal(renderMdHtml('前\n| a |\n| - - - |\n后'), '<p>前</p>\n<table><tr><th>a</th></tr></table>\n<p>后</p>');
});

test('renderMdHtml：占位 mark 模式高亮，默认只转义', () => {
  assert.equal(renderMdHtml('联系 【待填：联系邮箱】', { mark: true }), '<p>联系 <mark style="background:#ffeb3b">【待填：联系邮箱】</mark></p>');
  assert.equal(renderMdHtml('联系 【待填：联系邮箱】'), '<p>联系 【待填：联系邮箱】</p>');
  assert.equal(renderMdHtml('【待填：<b>】', { mark: true }), '<p><mark style="background:#ffeb3b">【待填：&lt;b&gt;】</mark></p>');
});

test('renderMdHtml：外链只保留文字与网址文本；缺省回调', () => {
  assert.equal(renderMdHtml('[官网](https://a.com)'), '<p>官网（https://a.com）</p>');
  assert.equal(renderMdHtml('[[页|别名]] [[页]] [^1:2] ![图](asset:3)'), '<p>别名 页 [^1:2] 图</p>');
});

test('escHtml：五个字符', () => {
  assert.equal(escHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
});
