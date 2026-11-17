import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExtractError, extractOffice } from './extract.ts';
import { decodeEntities, decodeHtml, htmlToText, renderData, scriptData } from './html.ts';

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

test('scriptData：只读 JSON 类型脚本和单条赋值的纯数据；普通代码、非 JSON、其他类型返回 null', () => {
  assert.deepEqual(scriptData('<script>', 'window.KG = {"a": 1};\n'), { name: 'KG', value: { a: 1 } });
  assert.deepEqual(scriptData('<script type="text/javascript">', 'const DATA=[1,2]'), { name: 'DATA', value: [1, 2] });
  assert.deepEqual(scriptData('<script type="application/ld+json">', '{"headline":"标题"}'), { name: '结构化数据', value: { headline: '标题' } });
  assert.deepEqual(scriptData('<script id="d" type=application/json>', '[{"x":"y"}]'), { name: '页面数据', value: [{ x: 'y' }] });
  for (const [tag, src] of [
    ['<script>', 'window.KG = {a: 1};'],
    ['<script>', '!function(){window.x = {}}()'],
    ['<script>', 'window.KG = {"a": 1}; alert(1)'],
    ['<script>', 'var s = "text"'],
    ['<script type="text/template">', 'window.KG = {"a": 1}'],
    ['<script data-type="application/json">', 'x()'],
  ]) assert.equal(scriptData(tag, src), null, src);
});

test('renderData：记录按标题分节，去掉 id / 颜色 / 文件名等内部字段，只有 id 的关系数据不输出', () => {
  const kg = {
    meta: { built_at: '2026-11-11 11:30', node_count: 2 },
    domains: [{ id: 'models', name: '模型', color: '#7048e8', desc: 'LLM 基础与选型' }],
    nodes: [{ id: 'm-a', title: '注意力机制', type: 'concept', tags: ['Transformer', 'KV Cache'], summary: '核心原理', related: ['m-b'], file: '01-models.yaml', refs: [{ title: 'RoFormer（RoPE）', url: 'https://arxiv.org/abs/2104.09864' }] }],
    links: [{ source: 'm-a', target: 'm-b', kind: 'related' }],
  };
  assert.equal(
    renderData([{ name: 'KG', value: kg }]),
    [
      '# 页面数据：KG',
      'meta：built_at：2026-11-11 11:30',
      '',
      '## domains',
      '',
      '### 模型',
      'desc：LLM 基础与选型',
      '',
      '## nodes',
      '',
      '### 注意力机制',
      'type：concept',
      'tags：Transformer、KV Cache',
      'summary：核心原理',
      'refs：',
      '- RoFormer（RoPE）；url：https://arxiv.org/abs/2104.09864',
    ].join('\n'),
  );
  assert.equal(renderData([{ name: 'X', value: { links: [{ a: 'x-1' }] } }]), '');
});

test('htmlToText：交互页面的内容在脚本数据里时，页面文字之后附上整理后的数据；库代码不输出', () => {
  const html = '<html><body><h1>知识图谱</h1><div id="app"></div><script>!function(){var d3={}}();</script><script>window.KG = {"nodes":[{"id":"n1","title":"上下文工程","summary":"窗口、压缩与隔离"}]};</script></body></html>';
  assert.equal(htmlToText(html), '# 知识图谱\n\n# 页面数据：KG\n\n## nodes\n\n### 上下文工程\nsummary：窗口、压缩与隔离');
});

test('renderData：超过 15 万字时截断并注明', () => {
  const nodes = Array.from({ length: 400 }, (_, i) => ({ title: `节点${i}`, body: '字'.repeat(500) }));
  const out = renderData([{ name: 'KG', value: { nodes } }]);
  assert.ok(out.length <= 151000, String(out.length));
  assert.ok(out.endsWith('（内嵌数据过长，后面的部分已截断）'));
});
