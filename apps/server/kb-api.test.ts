import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';
import type { Llm } from '../../packages/core/llm.ts';
import { createDoc } from '../../packs/kb/docs.ts';
import type { Expansion } from '../../packs/kb/expand.ts';
import { KbFiles } from '../../packs/kb/uploads.ts';
import { HttpError, sendJson } from './http.ts';
import { handleKbApi } from './kb-api.ts';
import type { KbApiDeps } from './kb-api.ts';

const llm = { enabled: false, chat: async () => '' } as unknown as Llm;

export async function kbServer(o: { expand?: (q: string, o?: { timeoutMs?: number }) => Promise<Expansion> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-kbapi-'));
  const db: DB = openDb(path.join(dir, 't.db'));
  const files = new KbFiles(db, path.join(dir, 'kb'), llm, { log: () => {} });
  const deps: KbApiDeps = { db, files, llm, tmpDir: path.join(dir, 'tmp'), ...(o.expand ? { expander: { expand: o.expand } } : {}) };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    handleKbApi(deps, req, res, req.method ?? 'GET', url)
      .then((hit) => {
        if (!hit) sendJson(res, 404, { error: 'not kb' });
      })
      .catch((e) => {
        if (!res.headersSent) sendJson(res, e instanceof HttpError ? e.status : 500, { error: e instanceof Error ? e.message : String(e) });
      });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const raw = (method: string, p: string, body?: unknown) => {
    const init: RequestInit = { method };
    if (body !== undefined) (init.body = JSON.stringify(body)), (init.headers = { 'content-type': 'application/json' });
    return fetch(base + p, init);
  };
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await raw(method, p, body);
    return { status: r.status, data: (await r.json()) as Record<string, any> };
  };
  const close = async () => {
    await files.idle();
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { db, dir, files, deps, raw, call, close };
}

test('GET /api/kb/docs?smart=1：返回 terms 与 source；扩写词参与搜索', async () => {
  const seen: { q: string; ms?: number }[] = [];
  const s = await kbServer({ expand: async (q, o) => (seen.push({ q, ms: o?.timeoutMs }), { terms: ['定价策略'], source: 'llm' }) });
  const a = createDoc(s.db, { kind: 'note', title: '价格', body: '## 折扣\n定价策略：年付八折' });
  const plain = await s.call('GET', `/api/kb/docs?q=${encodeURIComponent('怎么收费')}`);
  assert.deepEqual([plain.status, plain.data.hits, plain.data.terms], [200, [], undefined], '不带 smart 时响应不变');
  const r = await s.call('GET', `/api/kb/docs?q=${encodeURIComponent('怎么收费')}&smart=1`);
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.terms, r.data.source], [['定价策略'], 'llm']);
  assert.deepEqual(r.data.hits.map((h: { doc: { id: number } }) => h.doc.id), [a]);
  assert.deepEqual(seen, [{ q: '怎么收费', ms: 15000 }]);
  await s.close();
});

test('GET /api/kb/docs?smart=1：未配置扩写时 source off、hits 为普通结果；skip 时带 reason', async () => {
  const s = await kbServer();
  createDoc(s.db, { kind: 'note', title: '定价', body: '定价策略按席位' });
  const r = await s.call('GET', `/api/kb/docs?q=${encodeURIComponent('定价策略')}&smart=1`);
  assert.deepEqual([r.data.source, r.data.terms, r.data.reason, r.data.hits.length], ['off', [], '未启用智能搜索', 1]);
  await s.close();
  const t = await kbServer({ expand: async () => ({ terms: [], source: 'skip', reason: '今天的智能搜索次数已用完' }) });
  const r2 = await t.call('GET', `/api/kb/docs?q=x&smart=1`);
  assert.deepEqual([r2.data.source, r2.data.reason], ['skip', '今天的智能搜索次数已用完']);
  await t.close();
});
