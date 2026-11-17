import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExtractError, extractOffice } from './extract.ts';
import { decodeEntities, decodeHtml, htmlToText } from './html.ts';

test('htmlToText：标题、段落、列表、表格、pre 保留结构，标题栏、脚本、样式和注释去掉', () => {
  const html = `<!doctype html><html><head><title>标题栏</title><style>p{color:red}</style><script>var s = "</p>";</script></head>
<body><!-- 注释 --><h1>概述 &amp; 目标</h1><p>第一段
   多个   空格&nbsp;x</p><ul><li>甲<li>乙<ol><li>一</li><li>二</li></ol></ul>
<table><tr><th>名称</th>
<th>值</th></tr><tr><td>a<p>p1</p></td> <td>1</td></tr></table><pre>  code
    x</pre><a title="a>b" href="#">链接</a><br>末尾 &#20320;&#x597D;</body></html>`;
  assert.equal(htmlToText(html), '# 概述 & 目标\n\n第一段 多个 空格 x\n\n- 甲\n- 乙\n  1. 一\n  2. 二\n\n名称 | 值\na p1 | 1\n\n  code\n    x\n\n链接\n末尾 你好');
});

test('htmlToText：省略结束标签的单元格；svg、表单控件、iframe 内容不输出；各级标题', () => {
  assert.equal(htmlToText('<table><tr><td>a<td>b<tr><td>c<td>d</table><p>后文</p>'), 'a | b\nc | d\n\n后文');
  assert.equal(htmlToText('<p>前<svg><text>图中字</text></svg>后</p><select><option>选项</option></select><iframe>x</iframe><textarea>输入</textarea>'), '前后');
  assert.equal(htmlToText('<h2>小节</h2>正文<h3>子节</h3>'), '## 小节\n\n正文\n\n### 子节');
});

test('decodeEntities：命名与数字实体；未知名称和原型属性名原样保留', () => {
  assert.equal(decodeEntities('&lt;a&gt; &amp; &quot;&apos; &copy; &#20320;&#x597D; &#0; &bogus; &constructor; &toString;'), '<a> & "\' © 你好 \uFFFD &bogus; &constructor; &toString;');
});

test('decodeHtml：按 meta / XML 声明的编码解码；未声明时 UTF-8 优先、GB18030 兜底；含 NUL 抛 415', () => {
  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
  assert.equal(decodeHtml(Buffer.concat([Buffer.from('<meta charset="gb2312"><p>'), gbk])), '<meta charset="gb2312"><p>你好');
  assert.ok(decodeHtml(Buffer.concat([Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=GBK">'), gbk])).endsWith('你好'));
  assert.ok(decodeHtml(Buffer.concat([Buffer.from('<?xml version="1.0" encoding="gbk"?><html>'), gbk])).endsWith('你好'));
  assert.equal(decodeHtml(Buffer.concat([Buffer.from('<p>'), gbk])), '<p>你好');
  assert.equal(decodeHtml(Buffer.from('<meta charset="utf-8"><p>你好')), '<meta charset="utf-8"><p>你好');
  assert.throws(() => decodeHtml(Buffer.from([0x3c, 0, 0x3e])), (e) => e instanceof ExtractError && e.status === 415);
});

test('htmlToText：恶意构造（未闭合引号、大量 <、未闭合 script、深层嵌套列表）也能很快完成', () => {
  const t0 = Date.now();
  htmlToText('<a "'.repeat(200000));
  htmlToText('<'.repeat(1000000));
  assert.equal(htmlToText(`<p>前</p><script>${'x'.repeat(100000)}`), '前');
  const deep = htmlToText(`${'<ul>'.repeat(100000)}<li>x`);
  assert.ok(deep.length < 100, String(deep.length));
  assert.ok(Date.now() - t0 < 5000, `耗时 ${Date.now() - t0}ms`);
});

test('extractOffice(html)：在 worker 中按声明的编码解码并提取', async () => {
  const buf = Buffer.concat([Buffer.from('<html><meta charset="gbk"><body><h2>'), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), Buffer.from('</h2><script>alert(1)</script></body></html>')]);
  assert.equal(await extractOffice('html', buf), '## 你好');
});
