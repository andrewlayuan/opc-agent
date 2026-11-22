import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AI_NOTICE, NO_CTX, RULES, check, scan } from './checker.ts';
import { FIXTURES } from './fixtures.ts';
import { getPlatform } from './platforms.ts';

test('样例集 100% 判对', () => {
  for (const fx of FIXTURES) {
    const got = scan(fx.text, { ...NO_CTX, ...fx.ctx }).map((h) => ({ rule: h.rule, text: h.text }));
    assert.deepEqual(got, fx.expect, fx.text);
  }
  assert.ok(FIXTURES.length >= 60, `样例 ${FIXTURES.length} 条`);
  assert.ok(FIXTURES.filter((f) => !f.expect.length).length >= 25, '反例至少 25 条');
  for (const r of RULES) assert.ok(FIXTURES.filter((f) => f.expect.some((e) => e.rule === r.id)).length >= 3, `${r.id} 至少 3 条正例`);
});

test('上下文开关：minors、ai_overclaim 级别', () => {
  assert.equal(scan('让爸妈给你买', NO_CTX)[0].level, 'warn');
  assert.equal(scan('让爸妈给你买', { ...NO_CTX, minors: true })[0].level, 'must');
  assert.equal(scan('完全替代人工', NO_CTX)[0].level, 'warn');
  assert.equal(scan('完全替代人工', { ...NO_CTX, ai: true })[0].level, 'must');
  assert.equal(scan('最好', NO_CTX)[0].level, 'must');
  assert.equal(scan('限时', NO_CTX)[0].level, 'warn');
});

test('重叠去重：级别高优先，同级取长', () => {
  assert.deepEqual(scan('业内最好的工具', NO_CTX).map((h) => h.text), ['最好']);
  assert.deepEqual(scan('稳赚不赔', NO_CTX).map((h) => h.text), ['稳赚不赔']);
  assert.deepEqual(scan('年化 8% 起', NO_CTX).map((h) => h.rule), ['finance']);
});

test('码点偏移：emoji 之后的命中位置正确', () => {
  const [h] = scan('😀😀最佳', NO_CTX);
  assert.deepEqual([h.start, h.end, h.text], [2, 4, '最佳']);
});

test('替换建议：有词表的给建议，疗效类为空', () => {
  assert.deepEqual(scan('最好', NO_CTX)[0].suggest[0], '很好用');
  assert.deepEqual(scan('第一', NO_CTX)[0].suggest[0], '深受欢迎');
  assert.deepEqual(scan('NO.1', NO_CTX)[0].suggest[0], '热门之选');
  assert.deepEqual(scan('完全替代律师', NO_CTX)[0].suggest[0], '辅助律师');
  assert.deepEqual(scan('根治', NO_CTX)[0].suggest, []);
});

test('check：路径、key 序号、保留不计入未处理、长度提示', () => {
  const f = { title: '第一', body: '第一，真的第一', tags: ['限时'] };
  const r = check(getPlatform('xhs'), f, NO_CTX, { 'superlative:body:第一:1': { reason: '事实', at: 1 } });
  assert.deepEqual(r.hits.map((h) => h.key), ['superlative:title:第一:0', 'superlative:body:第一:0', 'superlative:body:第一:1', 'price:tags.0:限时:0']);
  assert.equal(r.mustOpen, 2);
  assert.equal(r.warnOpen, 1);
  assert.deepEqual(r.hits[2].kept, { reason: '事实', at: 1 });
  assert.equal(r.hits[0].kept, null);
  assert.equal(r.hits[0].label, '极限用语');
  assert.match(r.hits[0].basis, /第九条第三项/);
  assert.deepEqual([r.hits[1].path, r.hits[1].start, r.hits[1].end], ['body', 0, 2]);
  assert.ok(r.lengths.some((n) => n.path === 'body'));
});

test('AI 声明提醒与规则元数据', () => {
  assert.match(AI_NOTICE, /第十条第一款/);
  assert.deepEqual(RULES.map((r) => r.id), ['superlative', 'absolute', 'medical', 'finance', 'minors', 'ai_overclaim', 'price', 'disparage', 'data']);
  for (const r of RULES) assert.ok(r.label && r.basis && r.reason && r.words.length, r.id);
});
