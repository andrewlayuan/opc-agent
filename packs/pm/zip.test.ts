import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { ZipError, buildZip, openZip } from './zip.ts';

test('openZip：读出 buildZip 生成的条目（store 与 deflate 都支持）', () => {
  for (const store of [false, true]) {
    const buf = buildZip({ 'a/b.xml': '<x>你好</x>', 'c.txt': Buffer.from('plain') }, { store });
    const z = openZip(buf);
    assert.deepEqual(z.names, ['a/b.xml', 'c.txt']);
    assert.equal(z.has('c.txt'), true);
    assert.equal(z.has('nope'), false);
    assert.equal(z.read('a/b.xml').toString(), '<x>你好</x>');
    assert.equal(z.read('c.txt').toString(), 'plain');
    assert.throws(() => z.read('nope'), ZipError);
  }
});

test('openZip：条目数超限抛 ZipError', () => {
  const buf = buildZip({ a: '1', b: '2', c: '3' });
  assert.throws(() => openZip(buf, { maxEntries: 2 }), ZipError);
  assert.equal(openZip(buf, { maxEntries: 3 }).names.length, 3);
});

test('openZip：单条目解压超限、累计超限都抛 ZipError', () => {
  const big = '0'.repeat(2_000_000);
  const one = openZip(buildZip({ a: big }), { entryMax: 1_000_000 });
  assert.throws(() => one.read('a'), ZipError);
  const stored = openZip(buildZip({ a: big }, { store: true }), { entryMax: 1_000_000 });
  assert.throws(() => stored.read('a'), ZipError);
  const two = openZip(buildZip({ a: big, b: big }), { totalMax: 3_000_000 });
  assert.equal(two.read('a').length, 2_000_000);
  assert.throws(() => two.read('b'), ZipError);
});

/** 改写中央目录第一条的某个字段（偏移相对中央目录项起点） */
function patchCentral(buf: Buffer, off: number, write: (b: Buffer, at: number) => void): Buffer {
  const b = Buffer.from(buf);
  const at = b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  write(b, at + off);
  return b;
}

test('openZip：加密标志、ZIP64、未知压缩方式、名称含 .. 或以 / 开头都抛 ZipError', () => {
  assert.throws(() => openZip(buildZip({ a: 'x' }, { flags: 1 })), ZipError);
  const ok = buildZip({ a: 'x' });
  const z64 = Buffer.from(ok);
  const eocd = z64.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  z64.writeUInt16LE(0xffff, eocd + 10);
  assert.throws(() => openZip(z64), ZipError);
  assert.throws(() => openZip(patchCentral(ok, 10, (b, at) => b.writeUInt16LE(12, at))), ZipError);
  assert.throws(() => openZip(buildZip({ '../x': 'x' })), ZipError);
  assert.throws(() => openZip(buildZip({ 'a/../../x': 'x' })), ZipError);
  assert.throws(() => openZip(buildZip({ '/x': 'x' })), ZipError);
});

test('openZip：截断、随机字节、空 Buffer 都抛 ZipError 而不是其他异常', () => {
  const buf = buildZip({ 'word/document.xml': 'x'.repeat(5000) });
  const cases = [buf.subarray(0, buf.length - 10), buf.subarray(0, 40), randomBytes(500), Buffer.alloc(0)];
  for (const c of cases) {
    assert.throws(() => {
      const z = openZip(c);
      for (const n of z.names) z.read(n);
    }, ZipError);
  }
  const lying = patchCentral(buf, 42, (b, at) => b.writeUInt32LE(b.length + 100, at));
  assert.throws(() => openZip(lying).read('word/document.xml'), ZipError);
});
