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
import { openZip } from '../../packs/pm/zip.ts';
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

test('POST /api/kb/folders/ensure：返回映射与 capped；参数校验 400；父目录不存在 404', async () => {
  const s = await kbServer();
  const r = await s.call('POST', '/api/kb/folders/ensure', { parentId: null, paths: ['', '竞品/定价'] });
  assert.equal(r.status, 200);
  assert.equal(r.data.map[''], null);
  assert.equal(typeof r.data.map['竞品/定价'], 'number');
  assert.equal(r.data.capped, false);
  assert.equal((await s.call('POST', '/api/kb/folders/ensure', { parentId: null, paths: Array(501).fill('a') })).status, 400);
  assert.equal((await s.call('POST', '/api/kb/folders/ensure', { parentId: null, paths: ['字'.repeat(401)] })).status, 400);
  assert.equal((await s.call('POST', '/api/kb/folders/ensure', { parentId: null, paths: 'a' })).status, 400);
  assert.equal((await s.call('POST', '/api/kb/folders/ensure', { parentId: 'x', paths: [] })).status, 400);
  assert.equal((await s.call('POST', '/api/kb/folders/ensure', { parentId: 999, paths: ['a'] })).status, 404);
  await s.close();
});

test('GET /api/kb/docs?ids=：按 id 返回条目，不存在的跳过；超过 100 个或非法 400', async () => {
  const s = await kbServer();
  const a = createDoc(s.db, { kind: 'note', title: '甲', body: '内容' });
  const b = createDoc(s.db, { kind: 'note', title: '乙', body: '内容' });
  const r = await s.call('GET', `/api/kb/docs?ids=${b},${a},999`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.docs.map((d: { id: number }) => d.id).sort(), [a, b].sort());
  assert.equal((await s.call('GET', `/api/kb/docs?ids=${Array.from({ length: 101 }, (_, i) => i + 1).join(',')}`)).status, 400);
  assert.equal((await s.call('GET', '/api/kb/docs?ids=1,x')).status, 400);
  await s.close();
});

test('GET /api/kb/docs?limit=：默认列表不变，limit 取前 N 条，非法值回到默认', async () => {
  const s = await kbServer();
  try {
    for (const t of ['甲', '乙', '丙']) createDoc(s.db, { kind: 'note', title: t, body: t });
    assert.equal((await s.call('GET', '/api/kb/docs')).data.docs.length, 3);
    assert.equal((await s.call('GET', '/api/kb/docs?limit=2')).data.docs.length, 2);
    for (const bad of ['0', '-1', 'x', '1.5']) assert.equal((await s.call('GET', `/api/kb/docs?limit=${bad}`)).data.docs.length, 3, bad);
  } finally {
    await s.close();
  }
});

test('GET /api/kb/export：200、application/zip、文件名 tianshu-kb-YYYYMMDD.zip，发送后临时文件被删除', async () => {
  const s = await kbServer();
  try {
    createDoc(s.db, { kind: 'note', title: '笔记', body: '内容' });
    const r = await s.raw('GET', '/api/kb/export');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/zip');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    assert.match(r.headers.get('content-disposition') ?? '', new RegExp(`^attachment; .*filename\\*=UTF-8''tianshu-kb-${ymd}\\.zip$`));
    const zip = openZip(Buffer.from(await r.arrayBuffer()));
    assert.equal(zip.read('笔记.md').toString('utf8'), '# 笔记\n\n内容\n');
    assert.ok(zip.has('清单.csv'));
    for (let i = 0; i < 50 && fs.readdirSync(s.deps.tmpDir).length; i++) await new Promise((x) => setTimeout(x, 20));
    assert.deepEqual(fs.readdirSync(s.deps.tmpDir), []);
    assert.equal((await s.raw('POST', '/api/kb/export')).status, 404, '只接受 GET');
  } finally {
    await s.close();
  }
});
