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
  eq('<textarea>&lt;/textarea&gt;&lt;img onerror=1&gt;</textarea>', '<textarea>&lt;/textarea&gt;&lt;img onerror=1&gt;</textarea>');
});

test('审查补充：svg 属性里的 CSS 转义、被删元素内部的同名标签、自闭合的原始文本元素', () => {
  eq('<svg><rect width="9" fill="ur\\6c(https://evil.example/p.svg#g)" stroke="u\\rl(x)" transform="rotate(45 12 12)"/></svg>', '<svg><rect width="9" transform="rotate(45 12 12)"></rect></svg>');
  eq('<svg><path fill="&#x75;rl(x)" d="M0 0"/></svg>', '<svg><path d="M0 0"></path></svg>');
  eq('<div class="card"><object><div>fallback</div>tail</object>after</div>', '<div class="card">after</div>');
  eq('<div><svg><foreignObject><div>a</div>x</foreignObject></svg></div>', '<div><svg></svg></div>');
  eq('<div><svg><use href="#a"></svg>z</div>', '<div><svg></svg>z</div>');
  eq('<div><object><span>a</div>b', '<div></div>b');
  eq('<div><script/>alert(document.cookie)</script>ok</div>', '<div>ok</div>');
  eq('<style/>a{}</style>ok', 'ok');
  eq('<html><head><meta charset=utf-8><title>T</title><body><div>内容</div>', '<div>内容</div>');
});

test('审查补充：注释边界、未闭合引号、怪异属性名、NUL', () => {
  eq('<!-->你好<p>世界</p>', '你好<p>世界</p>');
  eq('<!--->你好', '你好');
  eq('<!-- a --!>你好', '你好');
  eq('<div title="a>b', '');
  eq('<div "onclick=x" =y a<b=1 data-goto"=z>t</div>', '<div>t</div>');
  lacks('<scr\0ipt>alert(1)</scr\0ipt>', /<scr/i);
  lacks('<div\vonclick=alert(1)>t</div>', 'onclick');
});

test('审查补充：对抗性大输入在线性时间内完成', () => {
  const cases = [
    `<div style="color:${'a'.repeat(40000)}">t</div>`,
    `<div style="${'color:a(;'.repeat(4000)}">t</div>`,
    '<div>'.repeat(20000) + '</x>'.repeat(20000),
    '<object>' + '<div>'.repeat(20000) + '</span>'.repeat(20000) + '</object>',
    '<a href="#/a">'.repeat(20000),
  ];
  for (const c of cases) {
    const t = Date.now();
    s(c);
    assert.ok(Date.now() - t < 500, `${c.slice(0, 30)}… 耗时 ${Date.now() - t}ms`);
  }
});

test('不变式：对抗性输入的输出只含白名单结构', () => {
  const evil = [
    '<svg><style><a id="</style><img src=1 onerror=alert(1)>"></svg>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
    '<select><template><style><!--</style><a rel="--></template></select><img src=x onerror=alert(1)>">',
    '<div style="background-image:url(x)" data-goto="javascript:x">t</div>',
    '<svg><a xlink:href="javascript:alert(1)"><rect width=9 height=9 /></a></svg>',
    '<p>&lt;img src=x onerror=alert(1)&gt;</p>',
    '<IMG """><SCRIPT>alert("XSS")</SCRIPT>">',
    '<div id="x" onclick=\'a\'/onmouseover=b>',
  ];
  const allowedTag = /^(main|section|header|footer|nav|article|aside|div|span|p|h[1-6]|ul|ol|li|dl|dt|dd|strong|em|b|i|u|s|small|mark|code|pre|blockquote|br|hr|figure|figcaption|table|thead|tbody|tfoot|tr|th|td|caption|form|label|input|textarea|select|option|button|progress|svg|g|path|circle|rect|line|polyline|polygon|ellipse)$/;
  for (const x of evil) {
    const out = s(x);
    for (const m of out.matchAll(/<\/?([^\s>/]+)([^>]*)>/g)) {
      assert.match(m[1], allowedTag, `${x} → ${out}`);
      for (const a of m[2].matchAll(/\s([^\s=]+)="/g)) assert.doesNotMatch(a[1], /^(on|href|src|xlink|xmlns|action|formaction|srcset)/i, `${x} → ${out}`);
    }
    assert.doesNotMatch(out, /<!|url\(|javascript:/i, `${x} → ${out}`);
    assert.equal(s(out), out);
  }
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
