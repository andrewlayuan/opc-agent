import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeHtml, textOf, tokenize } from './sanitize.ts';

const s = sanitizeHtml;
const inputs: string[] = [];
const eq = (input: string, want: string) => {
  inputs.push(input);
  assert.equal(s(input), want, input);
};
const lacks = (input: string, ...bad: (string | RegExp)[]) => {
  inputs.push(input);
  const out = s(input);
  for (const b of bad) {
    if (typeof b === 'string') assert.ok(!out.toLowerCase().includes(b.toLowerCase()), `${input} → ${out} 含 ${b}`);
    else assert.doesNotMatch(out, b, `${input} → ${out}`);
  }
  return out;
};

test('整段删除危险元素及其内容', () => {
  lacks('<script>alert(1)</script>', 'script', 'alert');
  lacks('<style>a{}</style>', 'style', 'a{');
  lacks('<iframe src=x></iframe>', 'iframe', 'src');
  lacks('<svg><foreignObject><div>x</div></foreignObject></svg>', 'foreignObject', 'x</div>', '>x<');
  lacks('<svg><animate attributeName="x"/></svg>', 'animate', 'attributeName');
  lacks('<svg><use href="#a"/></svg>', '<use', 'href');
  lacks('<template><p>x</p></template>', 'template', 'x');
  lacks('<noscript>x</noscript>', 'noscript', 'x');
  lacks('<math><mi>x</mi></math>', 'math', 'x');
  eq('<div>a<meta charset="x">b<link rel=stylesheet href=x>c</div>', '<div>abc</div>');
  eq('<div>a<iframe>b</div>', '<div>a</div>');
});

test('事件属性与危险链接', () => {
  eq('<div onclick="a()" onmouseover=b>t</div>', '<div>t</div>');
  lacks('<img src=x onerror=alert(1)>', 'onerror', 'img', 'alert');
  eq('<a href="javascript:alert(1)">x</a>', 'x');
  eq('<a href="&#106;avascript:alert(1)">x</a>', 'x');
  eq('<a href="&#x6A;avascript&colon;alert(1)">x</a>', 'x');
  eq('<div style="color:red" formaction="x" action=y srcset=z xlink:href=w xmlns="v">t</div>', '<div style="color:red">t</div>');
});

test('拆开的标签与大小写', () => {
  lacks('<scr<script>x</script>ipt>alert(1)</script>', /<script/i);
  lacks('<ScRiPt>alert(1)</sCrIpT>', 'script', 'alert');
  lacks('<SCRIPT SRC=//x.js></SCRIPT>', 'script', 'x.js');
  lacks('<script>a</script >b</script>', 'script');
});

test('注释、CDATA、doctype 丢弃', () => {
  eq('<!-- <script>x</script> -->ok', 'ok');
  eq('<![CDATA[<script>]]>ok', 'ok');
  eq('<!doctype html><?xml x?>ok', 'ok');
  eq('a<!-- 没闭合', 'a');
});

test('style 属性按声明过滤', () => {
  eq('<div style="color:red;background:url(x);width:expression(1);margin:4px">t</div>', '<div style="color:red;margin:4px">t</div>');
  eq('<div style="position:fixed">t</div>', '<div>t</div>');
  eq('<div style="Color : RED ; padding-left:calc(1px + 2px);background-color:rgba(0,0,0,.5)">t</div>', '<div style="color:RED;padding-left:calc(1px + 2px);background-color:rgba(0,0,0,.5)">t</div>');
  eq('<div style="color:attr(x);width:var(--w);border:1px solid \\72 ed;height:@x;opacity:/*x*/1">t</div>', '<div style="width:var(--w)">t</div>');
  eq('<div style="color:javascript:x;font-size:14px">t</div>', '<div style="font-size:14px">t</div>');
});

test('白名单属性与取值规则', () => {
  eq('<div class="card list" data-goto="detail" aria-label="x" role="button">t</div>', '<div class="card list" data-goto="detail" aria-label="x" role="button">t</div>');
  eq('<input type="checkbox" checked name="a">', '<input type="checkbox" checked="" name="a">');
  eq('<input type="file" name="f">', '<input name="f">');
  eq('<input TYPE="Search">', '<input type="search">');
  eq('<div class="ok bad!name">t</div>', '<div class="ok">t</div>');
  eq('<div class="!!">t</div>', '<div>t</div>');
  eq('<div data-goto="a b">t</div>', '<div>t</div>');
  eq('<button data-goto="订单详情">t</button>', '<button data-goto="订单详情">t</button>');
  eq('<div data-open="x y" id="sheet 1">t</div>', '<div>t</div>');
  eq('<div id="proto-toast" data-open="proto-x">t</div>', '<div data-open="proto-x">t</div>');
  eq('<form name="getElementById" data-toast="已提交"><input name="q"></form>', '<form data-toast="已提交"><input name="q"></form>');
  eq(`<span data-toast="${'字'.repeat(70)}">t</span>`, `<span data-toast="${'字'.repeat(60)}">t</span>`);
  eq('<div class="tab-panel" data-tab-panel="t:b" data-tab="t:b">t</div>', '<div class="tab-panel" data-tab-panel="t:b" data-tab="t:b">t</div>');
  eq('<td colspan=2 rowspan="3" width=9>t</td>', '<td colspan="2" rowspan="3">t</td>');
  eq('<div data-x="1" data-back aria-hidden="true" aria-x-y="1">t</div>', '<div data-back="" aria-hidden="true">t</div>');
  const cls = Array.from({ length: 14 }, (_, i) => `c${i}`).join(' ');
  eq(`<div class="${cls}">t</div>`, `<div class="${cls.split(' ').slice(0, 12).join(' ')}">t</div>`);
});

test('svg 只保留基本图形与安全属性', () => {
  eq(
    '<svg viewBox="0 0 24 24" width="24" fill="none" onload="x"><path d="M1 1L2 2" stroke="url(#g)" stroke-width="2"/><circle cx="1" cy="1" r="1"></circle><text>x</text></svg>',
    '<svg viewbox="0 0 24 24" width="24" fill="none"><path d="M1 1L2 2" stroke-width="2"></path><circle cx="1" cy="1" r="1"></circle>x</svg>',
  );
  eq('<div width="3" d="x">t</div>', '<div>t</div>');
});

test('Review Focus 1：#/slug 链接转成 data-goto', () => {
  eq('<a href="#/order-detail" class="btn">去看</a>', '<span class="btn" data-goto="order-detail">去看</span>');
  eq('<a href="#order-detail">去看</a>', '<span data-goto="order-detail">去看</span>');
  eq('<a href="#/订单详情">去看</a>', '<span data-goto="订单详情">去看</span>');
  eq('<a href="#/x" data-goto="y">去看</a>', '<span data-goto="y">去看</span>');
  eq('<a href="https://x.com">去看</a>', '去看');
  eq('<a href="#">去看</a>', '去看');
  eq('<div><a href="#/a"><b>x</b></div>y</a>', '<div><span data-goto="a"><b>x</b></span></div>y');
});

test('结构总是闭合完整', () => {
  eq('<div><p>a<div>b', '<div><p>a<div>b</div></p></div>');
  eq('a</main>b', 'ab');
  eq('<main>a</main>', '<main>a</main>');
  eq('<div><span>a</div>b</span>', '<div><span>a</span></div>b');
  eq('<br/><hr><br></br><div/>x', '<br><hr><br><div></div>x');
  eq('<div><b', '<div></div>');
});

test('转义与实体', () => {
  eq(`<p title='a"b'>1 < 2 & 3</p>`, '<p title="a&quot;b">1 &lt; 2 &amp; 3</p>');
  eq('<p>&lt;script&gt;&amp;lt;&#60;&copy;&nbsp;</p>', '<p>&lt;script&gt;&amp;lt;&lt;&amp;copy;\u00a0</p>');
  eq('<p title="&#0;&#xD800;&#1114112;">x</p>', '<p title="\ufffd\ufffd\ufffd">x</p>');
  eq('<textarea>a <b>x</b> &amp;</textarea>', '<textarea>a &lt;b&gt;x&lt;/b&gt; &amp;</textarea>');
});

test('幂等：清理两次结果不变', () => {
  for (const x of inputs) assert.equal(s(s(x)), s(x), x);
});

test('tokenize：原始文本元素的内容保留为一个文本节点，属性已解码', () => {
  assert.deepEqual(tokenize('<script type="application/json">{"a":"</b>"}</script><p A=&amp;x>t</p>'), [
    { t: 'open', tag: 'script', attrs: [['type', 'application/json']], self: false },
    { t: 'text', v: '{"a":"</b>"}' },
    { t: 'close', tag: 'script' },
    { t: 'open', tag: 'p', attrs: [['a', '&x']], self: false },
    { t: 'text', v: 't' },
    { t: 'close', tag: 'p' },
  ]);
});

test('textOf：纯文本、块之间留空格、合并空白、按码点截断', () => {
  assert.equal(textOf('<div>订单 <b>#123</b></div>  <p>已发货</p>', 7), '订单 #123');
  assert.equal(textOf('<p>a</p><p>b</p><script>x</script>', 100), 'a b');
  assert.equal(textOf('<p>😀😀😀</p>', 2), '😀😀');
});
