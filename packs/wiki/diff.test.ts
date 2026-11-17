import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineDiff } from './diff.ts';

test('lineDiff：增、删、改各一行', () => {
  const r = lineDiff('a\nb\nc\nd', 'a\nc\nD\nd\ne');
  assert.equal(r.clipped, false);
  assert.deepEqual(r.lines, [
    { t: ' ', s: 'a' },
    { t: '-', s: 'b' },
    { t: ' ', s: 'c' },
    { t: '+', s: 'D' },
    { t: ' ', s: 'd' },
    { t: '+', s: 'e' },
  ]);
});

test('lineDiff：相同文本全是上下文行；空文本到有内容全是新增', () => {
  assert.ok(lineDiff('x\ny', 'x\ny').lines.every((l) => l.t === ' '));
  assert.deepEqual(lineDiff('', 'x\ny').lines, [{ t: '+', s: 'x' }, { t: '+', s: 'y' }]);
  assert.deepEqual(lineDiff('x', '').lines, [{ t: '-', s: 'x' }]);
});

test('lineDiff：任一侧超过 2000 行时只比较前后各 200 行', () => {
  const a = Array.from({ length: 3000 }, (_, i) => `l${i}`).join('\n');
  const b = a.replace('l10\n', 'L10\n');
  const r = lineDiff(a, b);
  assert.equal(r.clipped, true);
  assert.ok(r.lines.length <= 802);
  assert.ok(r.lines.some((l) => l.t === '+' && l.s === 'L10'));
});
