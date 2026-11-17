import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeBody, parseBody, slugify } from './parse.ts';

test('slugify：英文小写、空白和标点换成 -、去首尾 -、最长 80', () => {
  assert.equal(slugify('  DeepSeek V4 '), 'deepseek-v4');
  assert.equal(slugify('检索增强生成（RAG）'), '检索增强生成-rag');
  assert.equal(slugify('../etc/passwd'), 'etc-passwd');
  assert.equal(slugify('///'), '');
  assert.equal([...slugify('字'.repeat(100))].length, 80);
});

test('slugify：已是 slug 的输入保持不变', () => {
  for (const s of ['deepseek-v4', 'src-12', '检索增强生成-rag']) assert.equal(slugify(s), s);
});

test('normalizeBody：链接转 slug、丢弃不存在的引用、保留合法引用', () => {
  const r = normalizeBody('见 [[DeepSeek V4]] 与 [[rag]]。结论[^3:1]，错误[^9:9]', (d, o) => d === 3 && o === 1);
  assert.equal(r.body, '见 [[deepseek-v4|DeepSeek V4]] 与 [[rag]]。结论[^3:1]，错误');
  assert.deepEqual(r.links, ['deepseek-v4', 'rag']);
  assert.deepEqual(r.cites, [{ doc: 3, ord: 1 }]);
  assert.deepEqual(r.dropped, ['[^9:9]']);
});

test('normalizeBody：已带显示文字的链接保留显示文字；空 slug 的链接退化为纯文字', () => {
  const r = normalizeBody('[[RAG|检索增强]] 和 [[///]]', () => true);
  assert.equal(r.body, '[[rag|检索增强]] 和 ///');
  assert.deepEqual(r.links, ['rag']);
});

test('parseBody：识别 asset 图片且去重', () => {
  assert.deepEqual(parseBody('![a](asset:5) ![b](asset:5) ![c](http://x)').assets, [5]);
});

test('parseBody：链接与引用去重', () => {
  const r = parseBody('[[A]] [[a]] [^1:2] [^1:2] [^1:3]');
  assert.deepEqual(r.links, ['a']);
  assert.deepEqual(r.cites, [{ doc: 1, ord: 2 }, { doc: 1, ord: 3 }]);
});
