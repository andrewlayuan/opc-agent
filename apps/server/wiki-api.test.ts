import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { WikiAssets } from '../../packs/wiki/assets.ts';
import { WikiQueue } from '../../packs/wiki/queue.ts';
import { createOp, finishOp } from '../../packs/wiki/store.ts';
import { seedDoc, stubLlm, tmpWikiDb } from '../../packs/wiki/testutil.ts';
import { HttpError, sendJson } from './http.ts';
import { handleWikiApi } from './wiki-api.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

async function setup(o: { dailyCalls?: number } = {}) {
  const t = tmpWikiDb();
  const llm = stubLlm([]);
  const queue = new WikiQueue(t.db, llm, { dailyCalls: o.dailyCalls, busy: () => false, log: () => {} });
  const assets = new WikiAssets(t.db, path.join(t.dir, 'wiki-assets'));
  const tmpDir = path.join(t.dir, 'wiki-export');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    handleWikiApi({ db: t.db, llm, queue, assets, tmpDir }, req, res, req.method ?? 'GET', url)
      .then((hit) => {
        if (!hit) sendJson(res, 404, { error: 'not wiki' });
      })
      .catch((e) => {
        if (res.headersSent) return res.destroy();
        sendJson(res, e instanceof HttpError ? e.status : 500, { error: e instanceof Error ? e.message : String(e) });
      });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const init: RequestInit = { method, headers: { ...headers } };
    if (Buffer.isBuffer(body)) init.body = new Uint8Array(body);
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
    }
    const r = await fetch(base + p, init);
    const type = r.headers.get('content-type') ?? '';
    const data = type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
    return { status: r.status, headers: r.headers, data: data as Record<string, any> };
  };
  return {
    ...t,
    queue,
    tmpDir,
    call,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      t.done();
    },
  };
}

test('PUT 新建页 → GET 能取到；旧 baseRev 再 PUT → 409', async () => {
  const s = await setup();
  try {
    const a = await s.call('PUT', '/api/wiki/pages/alpha', { title: 'Alpha', summary: 's', body: '见 [[beta]]', baseRev: 0, kind: 'concept' });
    assert.equal(a.status, 200, JSON.stringify(a.data));
    assert.equal(a.data.page.rev, 1);
    const g = await s.call('GET', '/api/wiki/pages/alpha');
    assert.equal(g.status, 200);
    assert.equal(g.data.page.title, 'Alpha');
    assert.deepEqual(g.data.page.links, [{ slug: 'beta', title: null }]);
    const b = await s.call('PUT', '/api/wiki/pages/alpha', { title: 'Alpha2', summary: '', body: 'x', baseRev: 1 });
    assert.equal(b.status, 200);
    assert.equal(b.data.page.rev, 2);
    const c = await s.call('PUT', '/api/wiki/pages/alpha', { title: 'Alpha3', summary: '', body: 'y', baseRev: 1 });
    assert.equal(c.status, 409);
    assert.equal((await s.call('GET', '/api/wiki/pages/alpha')).data.page.title, 'Alpha2');
    const list = await s.call('GET', '/api/wiki/pages?kind=concept');
    assert.deepEqual(list.data.pages.map((p: { slug: string }) => p.slug), ['alpha']);
    assert.equal((await s.call('GET', '/api/wiki/pages?kind=bad')).status, 400);
    const revs = await s.call('GET', '/api/wiki/pages/alpha/revisions');
    assert.deepEqual(revs.data.revisions.map((r: { rev: number }) => r.rev), [2, 1]);
    const diff = await s.call('GET', '/api/wiki/pages/alpha/revisions?rev=1&diff=1');
    assert.ok(diff.data.diff.lines.some((l: { t: string; s: string }) => l.t === '+' && l.s === 'x'));
    const rs = await s.call('POST', '/api/wiki/pages/alpha/restore', { rev: 1 });
    assert.equal(rs.status, 200);
    assert.equal((await s.call('GET', '/api/wiki/pages/alpha')).data.page.title, 'Alpha');
    assert.equal((await s.call('GET', '/api/wiki/pages/nope')).status, 404);
  } finally {
    await s.close();
  }
});

test('slug 参数不规范 → 400', async () => {
  const s = await setup();
  try {
    for (const p of ['..%2Fx', 'A', '%E0%A4%A', 'a%20b', 'x'.repeat(81)]) assert.equal((await s.call('GET', `/api/wiki/pages/${p}`)).status, 400, p);
  } finally {
    await s.close();
  }
});

test('POST /ingest/:docId 返回 opId，status 中 queued=1；generate / lint / retry 入队', async () => {
  const s = await setup();
  try {
    const doc = seedDoc(s.db, '资料', '## a\n内容');
    const r = await s.call('POST', `/api/wiki/ingest/${doc}`);
    assert.equal(r.status, 202);
    assert.ok(r.data.opId > 0);
    const st = await s.call('GET', '/api/wiki/status');
    assert.equal(st.data.queued, 1);
    assert.equal(st.data.docs[doc], 'queued');
    assert.equal((await s.call('POST', '/api/wiki/ingest/9999')).status, 404);
    assert.equal((await s.call('POST', '/api/wiki/pages/ghost/generate')).status, 202);
    assert.equal((await s.call('POST', '/api/wiki/lint')).status, 202);
    const bad = createOp(s.db, 'lint', { status: 'running' });
    finishOp(s.db, bad, { status: 'error', error: 'x' });
    assert.equal((await s.call('POST', `/api/wiki/ops/${bad}/retry`)).status, 202);
    const ops = await s.call('GET', '/api/wiki/ops?limit=2');
    assert.equal(ops.data.ops.length, 2);
  } finally {
    await s.close();
  }
});

test('POST /ops/:id/revert：有冲突 409 带 conflicts，force 时 200；GET /ops/:id 带每页差异', async () => {
  const s = await setup();
  try {
    await s.call('PUT', '/api/wiki/pages/p', { title: 'P', summary: '', body: '一', baseRev: 0 });
    await s.call('PUT', '/api/wiki/pages/p', { title: 'P', summary: '', body: '二', baseRev: 1 });
    const ops = (await s.call('GET', '/api/wiki/ops')).data.ops as { id: number }[];
    const first = Math.min(...ops.map((o) => o.id));
    const last = Math.max(...ops.map((o) => o.id));
    const d = await s.call('GET', `/api/wiki/ops/${last}`);
    assert.equal(d.status, 200);
    assert.ok(d.data.diffs[0].diff.lines.some((l: { t: string; s: string }) => l.t === '-' && l.s === '一'));
    const c = await s.call('POST', `/api/wiki/ops/${first}/revert`, {});
    assert.equal(c.status, 409);
    assert.deepEqual(c.data.conflicts, [{ slug: 'p', rev: 2, expected: 1 }]);
    const f = await s.call('POST', `/api/wiki/ops/${first}/revert`, { force: true });
    assert.equal(f.status, 200);
    assert.ok(f.data.revertOp > 0);
    assert.equal((await s.call('GET', '/api/wiki/pages/p')).status, 404);
  } finally {
    await s.close();
  }
});

test('POST /assets：PNG 成功；HTML 冒充 .png → 415；GET /assets/:id 带 nosniff 和 CSP', async () => {
  const s = await setup();
  try {
    await s.call('PUT', '/api/wiki/pages/p', { title: 'P', summary: '', body: '一', baseRev: 0 });
    const oct = { 'content-type': 'application/octet-stream', 'x-file-name': 'a.png' };
    const up = await s.call('POST', '/api/wiki/assets?page=p', PNG, oct);
    assert.equal(up.status, 201, JSON.stringify(up.data));
    assert.equal(up.data.mime, 'image/png');
    assert.equal((await s.call('POST', '/api/wiki/assets?page=p', Buffer.from('<html><script>1</script></html>'), oct)).status, 415);
    assert.equal((await s.call('POST', '/api/wiki/assets?page=nope', PNG, oct)).status, 404);
    assert.equal((await s.call('POST', '/api/wiki/assets?page=p', PNG, { 'content-type': 'image/png' })).status, 415);
    const g = await s.call('GET', `/api/wiki/assets/${up.data.id}`);
    assert.equal(g.status, 200);
    assert.equal(g.headers.get('content-type'), 'image/png');
    assert.equal(g.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(g.headers.get('content-security-policy'), "default-src 'none'");
    assert.deepEqual(g.data, PNG);
    assert.equal((await s.call('GET', '/api/wiki/assets/9999')).status, 404);
    const files = fs.readdirSync(path.join(s.dir, 'wiki-assets'));
    assert.equal(files.length, 1);
  } finally {
    await s.close();
  }
});

test('GET /export：scope 不合法 → 400；scope=all → zip 可解压，发送后删除临时文件', async () => {
  const s = await setup();
  try {
    await s.call('PUT', '/api/wiki/pages/p', { title: 'P', summary: '', body: '一', baseRev: 0 });
    assert.equal((await s.call('GET', '/api/wiki/export?scope=bad')).status, 400);
    const r = await s.call('GET', '/api/wiki/export?scope=all');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/zip');
    assert.match(r.headers.get('content-disposition') ?? '', /^attachment; .*filename\*=UTF-8''tianshu-wiki-\d{8}\.zip$/);
    const zip = path.join(s.dir, 'got.zip');
    fs.writeFileSync(zip, r.data as unknown as Buffer);
    execFileSync('unzip', ['-tq', zip]);
    for (let i = 0; i < 50 && fs.readdirSync(s.tmpDir).length; i++) await new Promise((x) => setTimeout(x, 20));
    assert.deepEqual(fs.readdirSync(s.tmpDir), []);
  } finally {
    await s.close();
  }
});

test('POST /ask：额度用完 → 429；POST /answers 存为问答页；GET /graph 返回节点和边', async () => {
  const s = await setup({ dailyCalls: 1 });
  try {
    await s.call('PUT', '/api/wiki/pages/a', { title: 'A', summary: '', body: '[[b]]', baseRev: 0 });
    await s.call('PUT', '/api/wiki/pages/b', { title: 'B', summary: '', body: 'x', baseRev: 0 });
    const op = createOp(s.db, 'ask', { status: 'running' });
    finishOp(s.db, op, { status: 'done', llmCalls: 1 });
    assert.equal((await s.call('POST', '/api/wiki/ask', { question: '什么是 A？' })).status, 429);
    assert.equal((await s.call('POST', '/api/wiki/ask', { question: '' })).status, 400);
    const sv = await s.call('POST', '/api/wiki/answers', { question: '什么是 A？', answer: 'A 是 B' });
    assert.equal(sv.status, 201);
    assert.match(sv.data.slug, /^q-/);
    const g = await s.call('GET', '/api/wiki/graph');
    assert.ok(g.data.nodes.some((n: { slug: string; backlinks: number }) => n.slug === 'b' && n.backlinks === 1));
    assert.deepEqual(g.data.edges, [{ from: 'a', to: 'b' }]);
  } finally {
    await s.close();
  }
});

test('GET /pages 每页带 topic 并返回主题列表；GET /pages/:slug 带所属主题', async () => {
  const s = await setup();
  try {
    await s.call('PUT', '/api/wiki/pages/hub', { title: '音箱总览', summary: '', body: '见 [[tuya]]', baseRev: 0, kind: 'overview' });
    await s.call('PUT', '/api/wiki/pages/tuya', { title: '涂鸦', summary: '', body: '正文', baseRev: 0, kind: 'entity' });
    await s.call('PUT', '/api/wiki/pages/lone', { title: '孤立', summary: '', body: '正文', baseRev: 0, kind: 'concept' });
    const list = await s.call('GET', '/api/wiki/pages');
    assert.deepEqual(list.data.topics, [{ slug: 'hub', title: '音箱总览', count: 2 }]);
    const t = Object.fromEntries(list.data.pages.map((p: { slug: string; topic: string | null }) => [p.slug, p.topic]));
    assert.deepEqual(t, { hub: 'hub', tuya: 'hub', lone: null });
    assert.deepEqual((await s.call('GET', '/api/wiki/pages/tuya')).data.page.topic, { slug: 'hub', title: '音箱总览' });
    assert.equal((await s.call('GET', '/api/wiki/pages/lone')).data.page.topic, null);
  } finally {
    await s.close();
  }
});
