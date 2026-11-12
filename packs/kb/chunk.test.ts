import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkMarkdown } from './chunk.ts';

const L = (s: string) => [...s].length;

test('chunkMarkdown：标题路径按层级组成，同级或更高级标题重置更深层级', () => {
  const { chunks } = chunkMarkdown('前言\n# A\n正文1\n## B\n正文2\n### X\n正文x\n# C\n正文3');
  assert.deepEqual(
    chunks.map((c) => [c.heading, c.body]),
    [
      ['', '前言'],
      ['A', '正文1'],
      ['A › B', '正文2'],
      ['A › B › X', '正文x'],
      ['C', '正文3'],
    ],
  );
});

test('chunkMarkdown：段落合并到约 800 字', () => {
  const para = '字'.repeat(189) + '。';
  const { chunks } = chunkMarkdown(Array.from({ length: 10 }, () => para).join('\n\n'));
  assert.equal(chunks.length, 3);
  for (const c of chunks.slice(0, -1)) assert.ok(L(c.body) <= 800, String(L(c.body)));
  assert.equal(chunks.map((c) => c.body).join('\n\n'), Array.from({ length: 10 }, () => para).join('\n\n'));
});

test('chunkMarkdown：超长段在句号后切开，没有标点时按 1200 字硬切', () => {
  const s = Array.from({ length: 30 }, (_, i) => `第${i}句`.padEnd(99, '内') + '。').join('');
  const { chunks } = chunkMarkdown(s);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) {
    assert.ok(L(c.body) <= 1200, String(L(c.body)));
    assert.ok(c.body.endsWith('。'), c.body.slice(-5));
  }
  assert.equal(chunks.map((c) => c.body).join(''), s);
  const hard = chunkMarkdown('a'.repeat(3000)).chunks;
  assert.deepEqual(hard.map((c) => L(c.body)), [1200, 1200, 600]);
});

test('chunkMarkdown：代码块里的 # 不当作标题', () => {
  const { chunks } = chunkMarkdown('# 安装\n```sh\n# 注释\nnpm i\n```\n完成');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].heading, '安装');
  assert.ok(chunks[0].body.includes('# 注释'));
});

test('chunkMarkdown：表格按行打包，不在行中间断开，块都带所属标题', () => {
  const row = (i: number) => `设备${i} | ${'值'.repeat(90)} | 结论`;
  const table = Array.from({ length: 30 }, (_, i) => row(i)).join('\n');
  const { chunks } = chunkMarkdown(`## 汇总\n${table}`);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) {
    assert.equal(c.heading, '汇总');
    for (const line of c.body.split('\n')) assert.match(line, /^设备\d+ \| 值+ \| 结论$/);
  }
  assert.equal(chunks.map((c) => c.body).join('\n'), table);
});

test('chunkMarkdown：超过 400 块时截断；空白输入返回空', () => {
  const big = Array.from({ length: 500 }, () => '长'.repeat(900)).join('\n\n');
  const r = chunkMarkdown(big);
  assert.equal(r.chunks.length, 400);
  assert.equal(r.truncated, true);
  assert.deepEqual(chunkMarkdown(''), { chunks: [], truncated: false });
  assert.deepEqual(chunkMarkdown(' \n\t\n'), { chunks: [], truncated: false });
});
