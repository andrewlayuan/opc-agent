import assert from 'node:assert/strict';
import type http from 'node:http';
import { test } from 'node:test';
import { clientIp } from './http.ts';

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
