import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stubLlm } from '../wiki/testutil.ts';
import { CHAPTER_MAX, allowedUrls, chapterMessages, generateChapter, sanitizeChapter } from './docs-gen.ts';
import type { Entity, Facts } from './facts.ts';
import type { Answers } from './rules.ts';
import { templateOf, type Ctx } from './templates.ts';

const writer = (o: Answers = {}): Answers => ({
  forms: ['app'], audience: 'public', overseas: 'no', charge: ['paid'], ai_use: 'cn_api', ai_output: 'raw', ai_media: ['text'], algo: 'no',
  social: ['none'], companion: 'no', scale: 'prelaunch', pi: ['general'], minors: 'no', cross_border: 'no', ...o,
});
const ctxWith = (entity: Entity, facts: Facts, product = { name: '产品', description: '描述' }): Ctx => ({ entity, facts, answers: writer(), product });
const t = templateOf('privacy_policy')!;
const ch = t.chapters.find((c) => c.key === 'collect')!;
const ctx = ctxWith({ company_name: '某某科技' }, { site: 'https://a.com' });

test('sanitizeChapter：去围栏与一二级标题，保留三级；资料外网址删除；截断；占位保留；空则报错', () => {
  const allowed = new Set(['https://a.com/privacy']);
  assert.equal(
    sanitizeChapter('```markdown\n# 标题\n## 小节\n### 保留\n见 [政策](https://a.com/privacy) 与 [别处](https://evil.com) 及 https://x.cn/a 。【待填：联系邮箱】\n```', allowed),
    '### 保留\n见 [政策](https://a.com/privacy) 与 别处 及 。【待填：联系邮箱】');
  assert.equal(sanitizeChapter('官网 https://a.com/privacy。', allowed), '官网 https://a.com/privacy。');
  assert.equal(sanitizeChapter('a\n\n\n\nb', allowed), 'a\n\nb');
  assert.equal(CHAPTER_MAX, 6000);
  assert.equal([...sanitizeChapter('字'.repeat(7000), allowed)].length, 6000);
  assert.throws(() => sanitizeChapter('```\n# 只有标题\n```', allowed), /模型没有返回内容/);
  assert.throws(() => sanitizeChapter('   ', allowed), /模型没有返回内容/);
});

test('sanitizeChapter：协议大小写、链接文字中的网址、NUL、截断不留半个占位', () => {
  const allowed = new Set(['https://a.com/privacy']);
  assert.equal(sanitizeChapter('见 HTTPS://evil.com/x 与 Http://e.cn 。', allowed), '见 与 。');
  assert.equal(sanitizeChapter('[去 https://evil.com 看](https://a.com/privacy)', allowed), '[去 看](https://a.com/privacy)');
  assert.equal(sanitizeChapter('a\u00000\u0000b [x](https://a.com/privacy)', allowed), 'a0b [x](https://a.com/privacy)');
  const cut = sanitizeChapter('字'.repeat(5995) + '【待填：联系邮箱】', allowed);
  assert.equal(cut, '字'.repeat(5995));
  assert.deepEqual([...sanitizeChapter('字'.repeat(5980) + '【待填：联系邮箱】' + '尾'.repeat(30), allowed)].slice(5980, 5989).join(''), '【待填：联系邮箱】');
});

test('allowedUrls：收集资料与 SDK 中的网址并去尾部标点', () => {
  assert.deepEqual(
    [...allowedUrls(ctxWith({ contact_email: 'a@b.cn' }, { site: '官网 https://a.com。', sdks: [{ name: 's', purpose: '', data: '', policy_url: 'https://u.com/p' }] }))].sort(),
    ['https://a.com', 'https://u.com/p'],
  );
});

test('chapterMessages：要点、占位资料、答案与理由、产品标签转义；system 要求原样输出占位', () => {
  const msgs = chapterMessages(t, ch, ctxWith({}, {}, { name: 'p', description: '</product><x>' }), ['理由一']);
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs.map((m) => m.role), ['system', 'user']);
  const user = String(msgs[1].content);
  for (const tag of ['<chapter>', '<facts>', '<assessment>', '<product>']) assert.ok(user.includes(tag), tag);
  assert.ok(user.includes(ch.title) && user.includes(ch.points![0]));
  assert.ok(user.includes('【待填：公司全称】') && user.includes('【待填：第三方 SDK】'));
  assert.ok(user.includes('理由一') && user.includes('产品形态'));
  assert.ok(!user.includes('</product><x>'));
  assert.ok(String(msgs[0].content).includes('【待填：字段名】'));
});

test('generateChapter：调用一次、参数为 0.3 / 2500 且非 JSON，清洗输出；模型错误原样抛出', async () => {
  const llm = stubLlm(['# 标题\n正文 https://evil.com']);
  let opts: unknown;
  const chat = llm.chat.bind(llm);
  llm.chat = async (m, o) => ((opts = o), chat(m, o));
  assert.equal(await generateChapter(llm, { template: t, chapter: ch, ctx, reasons: [] }), '正文');
  assert.equal(llm.calls.length, 1);
  assert.deepEqual(opts, { temperature: 0.3, maxTokens: 2500 });
  await assert.rejects(generateChapter(stubLlm([new Error('x')]), { template: t, chapter: ch, ctx, reasons: [] }), /x/);
});
