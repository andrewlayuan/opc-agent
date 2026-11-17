import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ZipWriter, crc32 } from './zip.ts';

test('crc32：标准校验值', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('ZipWriter：写入 3 个文件（含中文名），unzip -t 通过，内容一致', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-zipw-'));
  try {
    const file = path.join(dir, 'a.zip');
    const z = new ZipWriter(file);
    const files: [string, Buffer][] = [
      ['index.md', Buffer.from('# 索引\n')],
      ['概念/中文 名字.md', Buffer.from('正文'.repeat(500))],
      ['空.txt', Buffer.alloc(0)],
    ];
    for (const [n, b] of files) z.add(n, b);
    assert.ok(z.size > 0);
    const bytes = z.close();
    assert.equal(bytes, fs.statSync(file).size);
    execFileSync('unzip', ['-tq', file]);
    const names = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(names, files.map((f) => f[0]));
    for (const [n, b] of files) assert.deepEqual(execFileSync('unzip', ['-p', file, n]), b);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ZipWriter：拒绝不安全的条目名', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-zipw-'));
  try {
    const z = new ZipWriter(path.join(dir, 'b.zip'));
    for (const bad of ['../x', '/abs', 'a/../b', 'a\\b', '', 'a//b']) assert.throws(() => z.add(bad, Buffer.from('x')), bad);
    z.abort();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
