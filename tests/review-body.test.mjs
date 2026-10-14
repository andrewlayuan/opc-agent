// #5 R11：AI 审查评论只保留报告本身；没有内容时给一句说明，避免发空评论导致步骤失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { reviewBody, EMPTY_NOTE } from '../scripts/ci/review-body.mjs';

test('去掉第一个 ## 标题之前的过程性文字', () => {
  const raw = 'All checks pass, no failures. Now producing the review report.\n\n## 🔴 必须改（≤10）\n无。\n\n## ✅ 结论\n可以合并\n';
  assert.equal(reviewBody(raw), '## 🔴 必须改（≤10）\n无。\n\n## ✅ 结论\n可以合并');
});
test('标题前没有多余文字时原样保留', () => {
  assert.equal(reviewBody('## 🔴 必须改\n无。'), '## 🔴 必须改\n无。');
});
test('只认行首的 ##，正文里出现的 ## 不算标题', () => {
  assert.equal(reviewBody('先说明 ## 不是标题\n## 🔴 必须改\n无。'), '## 🔴 必须改\n无。');
});
test('没有 ## 标题时保留全部文字（可能是报错信息）', () => {
  assert.equal(reviewBody('  codebuddy: authentication failed  \n'), 'codebuddy: authentication failed');
});
test('空内容或只有空白时给出说明', () => {
  for (const raw of ['', '   \n\n', undefined]) assert.equal(reviewBody(raw), EMPTY_NOTE);
  assert.match(EMPTY_NOTE, /没有产出内容/);
});
test('Windows 换行统一为 \\n', () => {
  assert.equal(reviewBody('x\r\n## A\r\nb\r\n'), '## A\nb');
});
test('命令行：从 stdin 读、向 stdout 写', () => {
  const r = spawnSync('node', ['scripts/ci/review-body.mjs'], { input: 'noise\n## 🔴 必须改\n无。\n' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.toString(), '## 🔴 必须改\n无。\n');
  const empty = spawnSync('node', ['scripts/ci/review-body.mjs'], { input: '' });
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout.toString(), EMPTY_NOTE + '\n');
});
