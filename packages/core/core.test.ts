import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { hashPassword, verifyPassword } from './auth.ts';
import { decodeEntities, htmlToText, parseFeed, parseHfModels, parsePageList } from './feed.ts';
import { isBlockedIp, isHostAllowed, allowHost, parseRobots, robotsAllows, politeFetch } from './net.ts';

test('scrypt 哈希可往返校验，错误密码失败', () => {
  const h = hashPassword('correct horse battery', 1024, 8, 1);
  assert.match(h, /^scrypt\$1024\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(verifyPassword('correct horse battery', h), true);
  assert.equal(verifyPassword('wrong', h), false);
});

test('兼容盐按字符串使用的 scrypt 实现', () => {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync('pw-123456', salt, 64, { N: 1024, r: 8, p: 1 });
  assert.equal(verifyPassword('pw-123456', `scrypt$1024$8$1$${salt}$${key.toString('hex')}`), true);
});

test('畸形哈希直接拒绝', () => {
  assert.equal(verifyPassword('x', 'scrypt$3$8$1$aa$bb'), false);
  assert.equal(verifyPassword('x', 'bcrypt$whatever'), false);
  assert.equal(verifyPassword('x', 'scrypt$1024$8$1$zz$' + 'a'.repeat(64)), false);
});

test('内网与保留地址被拦截，含 9/10/11/21/30 段', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '9.9.9.9', '11.0.0.1', '21.3.4.5', '30.1.1.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '140.82.112.3', '2606:4700::1111']) assert.equal(isBlockedIp(ip), false, ip);
});

test('白名单支持通配后缀', () => {
  allowHost('*.example-allowed.com');
  assert.equal(isHostAllowed('feeds.example-allowed.com'), true);
  assert.equal(isHostAllowed('example-allowed.com.evil.io'), false);
});

test('不在白名单或指向 IP 的地址拒绝外发', async () => {
  await assert.rejects(politeFetch('https://not-allowed.invalid/feed'), /白名单/);
  await assert.rejects(politeFetch('http://127.0.0.1/'), /IP/);
  await assert.rejects(politeFetch('file:///etc/passwd'), /协议/);
});

test('robots.txt 解析：最长匹配，Allow 优先', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/feed\nDisallow: /*.json$\n\nUser-agent: other\nDisallow: /');
  assert.equal(robotsAllows(rules, '/blog/rss.xml'), true);
  assert.equal(robotsAllows(rules, '/private/x'), false);
  assert.equal(robotsAllows(rules, '/private/feed.xml'), true);
  assert.equal(robotsAllows(rules, '/a/b.json'), false);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow:'), '/x'), true);
});

test('解析 RSS 与 Atom，处理 CDATA 和实体', () => {
  const rss = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY boom "x">]><rss><channel><item><title><![CDATA[Hello <b>World</b>]]></title>
    <link>https://a.com/p1</link><pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate>
    <description>&lt;p&gt;Body &amp;amp; more&lt;/p&gt;</description><dc:creator>Ann</dc:creator></item></channel></rss>`;
  const [r] = parseFeed(rss, 'https://a.com/feed');
  assert.equal(r.title, 'Hello World');
  assert.equal(r.url, 'https://a.com/p1');
  assert.equal(r.author, 'Ann');
  assert.equal(r.publishedAt, Date.parse('2026-11-03T10:00:00Z'));
  assert.equal(r.content, 'Body & more');

  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">v1.2 &amp;amp; fixes</title>
    <link rel="alternate" href="/r/v1.2"/><updated>2026-11-01T00:00:00Z</updated><content type="html">&lt;ul&gt;&lt;li&gt;A&lt;/li&gt;&lt;/ul&gt;</content>
    <author><name>Bob</name></author></entry></feed>`;
  const [a] = parseFeed(atom, 'https://github.com/x/y/releases.atom');
  assert.equal(a.url, 'https://github.com/r/v1.2');
  assert.equal(a.author, 'Bob');
  assert.equal(a.title, 'v1.2 & fixes');
  assert.match(a.content, /• A/);
});

test('忽略非 http 链接与脚本内容', () => {
  const rss = '<rss><item><title>x</title><link>javascript:alert(1)</link></item><item><title>y</title><link>https://ok.com</link><description>&lt;script&gt;bad()&lt;/script&gt;fine</description></item></rss>';
  const out = parseFeed(rss, 'https://ok.com');
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'fine');
  assert.equal(decodeEntities('&#x4e2d;&#25991;'), '中文');
  assert.equal(htmlToText('<style>a{}</style>hi'), 'hi');
});

test('解析 Hugging Face 模型列表', () => {
  const out = parseHfModels(JSON.stringify([{ id: 'deepseek-ai/X', createdAt: '2026-11-01T00:00:00Z', pipeline_tag: 'text-generation', tags: ['license:mit', 'moe'] }, { id: '../evil' }]));
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://huggingface.co/deepseek-ai/X');
  assert.match(out[0].content, /moe/);
});

test('parsePageList：网信办列表页，无引号 href、title 属性、东八区日期', () => {
  const page = 'https://www.cac.gov.cn/wxzw/wxfb/A093702index_1.htm';
  const html = `<ul class="list">
    <li><h5><a href=//www.cac.gov.cn/2026-11/10/c_1796065949954025.htm target="_blank" title="国家网信办部署开展&ldquo;清朗&rdquo;专项行动">国家网信办部署…</a></h5><div class="times">2026-11-10</div></li>
    <li><a href="javascript:void(0);">更多</a></li>
    <li><a href="https://evil.example/2026-11/10/c_1.htm" title="站外">站外</a> 2026-11-09</li>
    <li><a href="//www.cac.gov.cn/wxzw/A0937index_1.htm">栏目页</a></li>
    <li><h5><a href="../../2026-11/08/c_1795.htm">  关于 印发
      办法的通知 </a></h5><span>2026-11-08</span></li>
    <li><a href=//www.cac.gov.cn/2026-11/10/c_1796065949954025.htm title="重复">重复</a></li>
    <li><a href=//www.cac.gov.cn/2026-11/07/c_1794.htm title="">   </a></li>
  </ul>`;
  const r = parsePageList(html, page);
  assert.deepEqual(r.map((e) => e.url), ['https://www.cac.gov.cn/2026-11/10/c_1796065949954025.htm', 'https://www.cac.gov.cn/2026-11/08/c_1795.htm']);
  assert.equal(r[0].title, '国家网信办部署开展“清朗”专项行动');
  assert.equal(r[0].publishedAt, Date.UTC(2026, 10, 9, 16));
  assert.equal(r[0].content, '');
  assert.equal(r[1].title, '关于 印发 办法的通知');
  assert.equal(r[1].publishedAt, Date.UTC(2026, 10, 7, 16));
});
