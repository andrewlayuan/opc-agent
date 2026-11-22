import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Llm } from '../../packages/core/llm.ts';
import { stubLlm, tmpWikiDb } from '../../packs/wiki/testutil.ts';
import { handleGrowthApi, type GrowthDeps } from './growth-api.ts';
import { HttpError, sendJson } from './http.ts';

const offLlm = () => new Llm({ apiKey: '', baseUrl: 'https://llm.test', model: 'm', concurrency: 1 }, async () => {
  throw new Error('不应调用');
});

async function setup(llm: Llm = stubLlm([])) {
  const t = tmpWikiDb();
  const deps: GrowthDeps = { db: t.db, llm };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    handleGrowthApi(deps, req, res, req.method ?? 'GET', url)
      .then((hit) => {
        if (!hit) sendJson(res, 404, { error: 'not growth' });
      })
      .catch((e) => sendJson(res, e instanceof HttpError ? e.status : 500, { error: e instanceof Error ? e.message : String(e) }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const raw = (method: string, p: string, body?: unknown) => {
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body), (init.headers = { 'content-type': 'application/json' });
    return fetch(base + p, init);
  };
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await raw(method, p, body);
    return { status: r.status, data: (await r.json()) as Record<string, any> };
  };
  const close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    t.done();
  };
  return { ...t, deps, raw, call, close };
}

const G = '/api/growth';
const C = { name: 'v1.2 上线', product_name: '周报助手', product_desc: '自动生成周报', points: ['接 GitHub'], audience: '', offer: '', tone: 'warm' };
const XHS_OUT = JSON.stringify({ title: '周报五分钟写完', body: '这是最好的周报工具。用了就不焦虑。', tags: ['效率', '周报', 'AI'] });
const REVIEW_OUT = JSON.stringify({ items: [{ quote: '用了就不焦虑', issue: '制造焦虑', suggestion: '改为「省下时间」' }] });

test('接口：元数据、新建投放、生成、复核、命中、替换、保留、定稿、导出', async () => {
  const s = await setup(stubLlm([XHS_OUT, REVIEW_OUT]));
  const meta = (await s.call('GET', `${G}/meta`)).data;
  assert.deepEqual(meta.platforms.map((p: { id: string }) => p.id), ['xhs', 'wechat', 'video', 'landing']);
  assert.equal(meta.platforms[0].guide, undefined);
  assert.deepEqual(meta.platforms[2].total, { label: '口播合计', min: 240, max: 300 });
  assert.deepEqual(meta.tones.map((t: { id: string }) => t.id), ['pro', 'warm', 'lively']);
  assert.equal(meta.llm, true);
  assert.match(meta.aiNotice, /第十条第一款/);
  assert.deepEqual(meta.products, []);
  const created = await s.call('POST', `${G}/campaigns`, { ...C, platforms: ['xhs', 'landing'] });
  assert.equal(created.status, 200);
  const camp = created.data.campaign;
  assert.deepEqual(camp.copies.map((c: { platform: string }) => c.platform), ['xhs', 'landing']);
  const xid = camp.copies[0].id;
  const g = await s.call('POST', `${G}/copies/${xid}/generate`);
  assert.equal(g.status, 200);
  assert.equal(g.data.copy.check.mustOpen, 1);
  const r = await s.call('POST', `${G}/copies/${xid}/review`);
  assert.deepEqual(r.data.copy.review.map((x: { quote: string }) => x.quote), ['用了就不焦虑']);
  const hit = g.data.copy.check.hits[0];
  assert.equal(hit.key, 'superlative:body:最好:0');
  const rep = await s.call('POST', `${G}/copies/${xid}/replace`, { baseRev: 1, items: [{ key: hit.key, with: hit.suggest[0] }] });
  assert.equal(rep.data.copy.fields.body, '这是很好用的周报工具。用了就不焦虑。');
  assert.equal(rep.data.copy.check.mustOpen, 0);
  assert.equal(rep.data.copy.review_base, 1, '替换后保留复核');
  const kept = await s.call('POST', `${G}/copies/${xid}/keep`, { key: 'superlative:body:最好:0', reason: '理由' });
  assert.deepEqual([kept.status, kept.data.error], [409, '内容已在别处更新，请刷新']);
  assert.equal((await s.call('POST', `${G}/copies/${xid}/finalize`)).data.copy.status, 'final');
  assert.deepEqual((await s.call('PUT', `${G}/copies/${xid}`, { fields: {}, baseRev: 2 })).data, { error: '文案已定稿，先取消定稿' });
  const list = (await s.call('GET', `${G}/campaigns`)).data.campaigns;
  assert.deepEqual(list[0].copies, [{ platform: 'xhs', state: 'final' }, { platform: 'landing', state: 'empty' }]);
  const ex = await s.raw('GET', `${G}/campaigns/${camp.id}/export?format=md`);
  assert.equal(ex.status, 200);
  assert.match(ex.headers.get('content-type')!, /text\/markdown/);
  assert.match(ex.headers.get('content-disposition')!, new RegExp(`opc-growth-${camp.id}\\.md`));
  const md = await ex.text();
  assert.match(md, /^# v1\.2 上线\n\n产品：周报助手\n\n## 小红书\n\n### 周报五分钟写完/);
  assert.doesNotMatch(md, /发布页/);
  assert.doesNotMatch(md, /草稿（未定稿）/);
  assert.match(md, /第十条第一款/);
  assert.equal((await s.call('POST', `${G}/copies/${xid}/unfinalize`)).data.copy.status, 'draft');
  await s.close();
});

test('接口：编辑、历史与差异、回退、补加与删除平台、改投放后 stale', async () => {
  const s = await setup(stubLlm([XHS_OUT]));
  const camp = (await s.call('POST', `${G}/campaigns`, { ...C, platforms: ['xhs'] })).data.campaign;
  const xid = camp.copies[0].id;
  await s.call('POST', `${G}/copies/${xid}/generate`);
  const ed = await s.call('PUT', `${G}/copies/${xid}`, { fields: { title: '新标题', body: '正文', tags: ['a', 'b', 'c'] }, baseRev: 1 });
  assert.deepEqual([ed.data.copy.rev, ed.data.copy.origin], [2, 'edit']);
  assert.deepEqual((await s.call('PUT', `${G}/copies/${xid}`, { fields: {}, baseRev: 1 })).data, { error: '内容已在别处更新，请刷新' });
  const revs = (await s.call('GET', `${G}/copies/${xid}/revisions`)).data.revisions;
  assert.deepEqual(revs.map((x: { n: number }) => x.n), [2, 1]);
  const one = (await s.call('GET', `${G}/copies/${xid}/revisions/1?diff=1`)).data;
  assert.equal(one.revision.fields.title, '周报五分钟写完');
  assert.ok(one.diff.lines.some((l: { t: string; s: string }) => l.t === '+' && l.s === '### 新标题'));
  assert.equal((await s.call('GET', `${G}/copies/${xid}/revisions/1`)).data.diff, undefined);
  assert.equal((await s.call('GET', `${G}/copies/${xid}/revisions/x`)).status, 400);
  assert.equal((await s.call('GET', `${G}/copies/${xid}/revisions/9`)).status, 404);
  assert.equal((await s.call('POST', `${G}/copies/${xid}/restore`, { rev: 1 })).data.copy.origin, 'restore');
  const add = await s.call('POST', `${G}/campaigns/${camp.id}/copies`, { platform: 'video' });
  assert.equal(add.data.copy.platform, 'video');
  assert.deepEqual((await s.call('POST', `${G}/campaigns/${camp.id}/copies`, { platform: 'video' })).data, { error: '该平台的文案已存在' });
  assert.deepEqual((await s.call('POST', `${G}/campaigns/${camp.id}/copies`, { platform: 'x' })).data, { error: '不支持的平台' });
  assert.deepEqual((await s.call('DELETE', `${G}/copies/${add.data.copy.id}`)).data, { ok: true });
  const up = await s.call('PUT', `${G}/campaigns/${camp.id}`, { ...C, points: ['换个卖点'] });
  assert.equal(up.data.campaign.copies[0].stale, true);
  assert.deepEqual((await s.call('DELETE', `${G}/campaigns/${camp.id}`)).data, { ok: true });
  assert.deepEqual((await s.call('GET', `${G}/campaigns/${camp.id}`)).data, { error: '投放不存在' });
  await s.close();
});

test('接口：未配置模型 400；模型异常 502；定稿拦截带 issues；导出格式不对；非法 id；未知接口', async () => {
  const off = await setup(offLlm());
  const c0 = (await off.call('POST', `${G}/campaigns`, { ...C, platforms: ['xhs'] })).data.campaign;
  assert.deepEqual(await off.call('POST', `${G}/copies/${c0.copies[0].id}/generate`), { status: 400, data: { error: '未配置 DEEPSEEK_API_KEY，无法调用模型' } });
  assert.deepEqual(await off.call('POST', `${G}/copies/${c0.copies[0].id}/review`), { status: 400, data: { error: '未配置 DEEPSEEK_API_KEY，无法调用模型' } });
  assert.equal((await off.call('GET', `${G}/meta`)).data.llm, false);
  await off.close();

  const s = await setup(stubLlm([new Error('boom'), XHS_OUT]));
  const camp = (await s.call('POST', `${G}/campaigns`, { ...C, platforms: ['xhs'] })).data.campaign;
  const xid = camp.copies[0].id;
  assert.deepEqual(await s.call('POST', `${G}/copies/${xid}/generate`), { status: 502, data: { error: '模型调用失败，请稍后重试' } });
  await s.call('POST', `${G}/copies/${xid}/generate`);
  const fin = await s.call('POST', `${G}/copies/${xid}/finalize`);
  assert.deepEqual(fin, { status: 400, data: { error: '还有必须修改的问题', issues: [{ path: 'body', text: '最好', label: '极限用语' }] } });
  assert.deepEqual(await s.call('GET', `${G}/campaigns/${camp.id}/export?format=pdf`), { status: 400, data: { error: '导出格式不对' } });
  assert.deepEqual(await s.call('GET', `${G}/campaigns/abc`), { status: 400, data: { error: '非法 id' } });
  assert.deepEqual(await s.call('POST', `${G}/campaigns`, { ...C, platforms: [] }), { status: 400, data: { error: '至少选择一个平台' } });
  assert.equal((await s.call('GET', `${G}/nope`)).status, 404);
  assert.equal((await s.call('PATCH', `${G}/campaigns`)).status, 404);
  assert.equal((await s.call('GET', '/api/other')).data.error, 'not growth');
  await s.close();
});
