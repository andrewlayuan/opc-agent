import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { HttpError, clientIp, contentDisposition, readBodyToFile } from './http.ts';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'opc-http-')), 'up');
}

function fromChunks(chunks: string[]): Readable {
  const r = Readable.from(chunks.map((c) => Buffer.from(c)), { objectMode: false });
  return r;
}

test('readBodyToFile：写入并返回字节数，文件 0600', async () => {
  const f = tmpFile();
  const n = await readBodyToFile(fromChunks(['hello ', '世界']), f, 1024);
  assert.equal(n, Buffer.byteLength('hello 世界'));
  assert.equal(fs.readFileSync(f, 'utf8'), 'hello 世界');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test('readBodyToFile：超限 413 并删除文件', async () => {
  const f = tmpFile();
  const r = fromChunks(['aaaaa', 'bbbbb', 'ccccc']);
  await assert.rejects(readBodyToFile(r, f, 10), (e) => e instanceof HttpError && e.status === 413 && e.message === '单个文件最大 10MB');
  assert.equal(fs.existsSync(f), false);
});

test('readBodyToFile：超限时不销毁请求（否则 413 发不出去）', async () => {
  const f = tmpFile();
  const r = new Readable({ read() {} });
  const p = readBodyToFile(r, f, 10);
  for (const c of ['aaaaa', 'bbbbb', 'ccccc']) r.push(Buffer.from(c));
  await assert.rejects(p, (e) => e instanceof HttpError && e.status === 413);
  assert.equal(r.destroyed, false);
  assert.equal(fs.existsSync(f), false);
  r.destroy();
});

test('readBodyToFile：请求出错时 400 上传中断并删除文件', async () => {
  const f = tmpFile();
  const r = new Readable({ read() {} });
  const p = readBodyToFile(r, f, 1024);
  r.push(Buffer.from('part'));
  setImmediate(() => r.destroy(new Error('x')));
  await assert.rejects(p, (e) => e instanceof HttpError && e.status === 400 && e.message === '上传中断');
  assert.equal(fs.existsSync(f), false);
});

test('readBodyToFile：未收到 end 就关闭时 400 上传中断并删除文件', async () => {
  const f = tmpFile();
  const r = new Readable({ read() {} });
  const p = readBodyToFile(r, f, 1024);
  r.push(Buffer.from('part'));
  setImmediate(() => r.destroy());
  await assert.rejects(p, (e) => e instanceof HttpError && e.status === 400 && e.message === '上传中断');
  assert.equal(fs.existsSync(f), false);
});

function req(remote: string | undefined, xff?: string | string[]): http.IncomingMessage {
  return { socket: { remoteAddress: remote }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } } as unknown as http.IncomingMessage;
}

test('不信任代理时只用 socket 地址', () => {
  assert.equal(clientIp(req('127.0.0.1', '1.2.3.4'), false), '127.0.0.1');
  assert.equal(clientIp(req('8.8.8.8'), false), '8.8.8.8');
  assert.equal(clientIp(req(undefined), false), 'unknown');
});

test('信任代理：只认本机来源，取 X-Forwarded-For 最右一段', () => {
  assert.equal(clientIp(req('127.0.0.1', '1.2.3.4'), true), '1.2.3.4');
  assert.equal(clientIp(req('::ffff:127.0.0.1', 'evil, 5.6.7.8'), true), '5.6.7.8');
  assert.equal(clientIp(req('::1', ['9.9.9.9']), true), '9.9.9.9');
});

test('信任代理：非本机来源忽略头，伪造或空值回退到 socket', () => {
  assert.equal(clientIp(req('8.8.8.8', '1.2.3.4'), true), '8.8.8.8');
  assert.equal(clientIp(req('127.0.0.1', ''), true), '127.0.0.1');
  assert.equal(clientIp(req('127.0.0.1', 'not-an-ip'), true), '127.0.0.1');
});

test('contentDisposition：RFC 5987 编码（含 \' ( ) *），ASCII 兜底名为 file', () => {
  assert.equal(contentDisposition("it's (1)*.pdf", false), "attachment; filename=\"file\"; filename*=UTF-8''it%27s%20%281%29%2A.pdf");
  assert.equal(contentDisposition('调研 😀.png', true), "inline; filename=\"file\"; filename*=UTF-8''%E8%B0%83%E7%A0%94%20%F0%9F%98%80.png");
  assert.doesNotMatch(contentDisposition('a\r\nSet-Cookie: x', false), /[\r\n]/);
});
