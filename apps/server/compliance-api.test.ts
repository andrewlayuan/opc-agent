import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Llm } from '../../packages/core/llm.ts';
import type { EventInput } from '../../packs/memory/events.ts';
import { stubLlm, tmpWikiDb } from '../../packs/wiki/testutil.ts';
import { handleComplianceApi, type ComplianceDeps } from './compliance-api.ts';
import { HttpError, sendJson } from './http.ts';

const ANSWERS = {
  forms: ['app'], audience: 'public', overseas: 'no', charge: ['paid'], ai_use: 'cn_api', ai_output: 'raw', ai_media: ['text'], algo: 'no',
  social: ['none'], companion: 'no', scale: 'prelaunch', pi: ['general'], minors: 'no', cross_border: 'no',
};

async function setup(extra: Partial<ComplianceDeps> = {}) {
  const t = tmpWikiDb();
  const events: EventInput[] = [];
  const deps: ComplianceDeps = { db: t.db, llm: stubLlm([]), record: (e) => events.push(e), ...extra };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    handleComplianceApi(deps, req, res, req.method ?? 'GET', url)
      .then((hit) => {
        if (!hit) sendJson(res, 404, { error: 'not compliance' });
      })
      .catch((e) => sendJson(res, e instanceof HttpError ? e.status : 500, { error: e instanceof Error ? e.message : String(e) }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, body?: unknown) => {
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body), (init.headers = { 'content-type': 'application/json' });
    const r = await fetch(base + p, init);
    return { status: r.status, data: (await r.json()) as Record<string, any> };
  };
  const close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    t.done();
  };
  return { ...t, events, call, close };
}

test('meta：14 题（条件题带 dependsOn）、17 项、固定提示', async () => {
  const s = await setup();
  try {
    const r = await s.call('GET', '/api/compliance/meta');
    assert.equal(r.status, 200);
    assert.equal(r.data.version, 1);
    assert.equal(r.data.questions.length, 14);
    assert.equal(r.data.catalog.length, 17);
    assert.equal(r.data.notice, '结果为自查参考，以属地主管部门口径为准。');
    const q = r.data.questions.find((x: any) => x.id === 'ai_output');
    assert.deepEqual(q.dependsOn, { q: 'ai_use', in: ['cn_api', 'foreign_api'] });
    assert.equal('when' in q, false);
  } finally {
    await s.close();
  }
});

test('产品增删改查：校验 400、不存在 404', async () => {
  const s = await setup();
  try {
    assert.equal((await s.call('POST', '/api/compliance/products', { name: '' })).status, 400);
    assert.equal((await s.call('POST', '/api/compliance/products', { name: 'a', reviewId: 'x' })).status, 400);
    assert.equal((await s.call('POST', '/api/compliance/products', { name: 'a', reviewId: 99 })).status, 404);
    const c = await s.call('POST', '/api/compliance/products', { name: '写作 App', description: '帮人写稿' });
    assert.equal(c.status, 200);
    const id = c.data.product.id;
    assert.deepEqual(c.data.items, []);
    assert.equal(c.data.assessment, null);
    const l = await s.call('GET', '/api/compliance/products');
    assert.deepEqual(l.data.products.map((p: any) => [p.id, p.name, p.required]), [[id, '写作 App', 0]]);
    const u = await s.call('PATCH', `/api/compliance/products/${id}`, { name: '新名' });
    assert.equal(u.data.product.name, '新名');
    assert.equal((await s.call('PATCH', `/api/compliance/products/${id}`, { name: '' })).status, 400);
    assert.equal((await s.call('GET', `/api/compliance/products/${id}`)).data.product.description, '帮人写稿');
    assert.deepEqual((await s.call('DELETE', `/api/compliance/products/${id}`)).data, { ok: true });
    assert.equal((await s.call('GET', `/api/compliance/products/${id}`)).status, 404);
    assert.equal((await s.call('DELETE', `/api/compliance/products/${id}`)).status, 404);
  } finally {
    await s.close();
  }
});

test('assess：缺题 400 带 missing、版本过期 409、成功返回台账并记一次事件', async () => {
  const s = await setup();
  try {
    const id = (await s.call('POST', '/api/compliance/products', { name: '写作 App' })).data.product.id;
    const miss = await s.call('POST', `/api/compliance/products/${id}/assess`, { answers: { ...ANSWERS, forms: undefined, charge: 'paid' }, version: 1 });
    assert.equal(miss.status, 400);
    assert.equal(miss.data.error, '问卷未答完或有非法选项');
    assert.deepEqual([miss.data.missing, miss.data.invalid], [['forms'], ['charge']]);
    assert.equal((await s.call('POST', `/api/compliance/products/${id}/assess`, { answers: ANSWERS, version: 0 })).status, 409);
    assert.equal((await s.call('POST', '/api/compliance/products/999/assess', { answers: ANSWERS, version: 1 })).status, 404);
    assert.equal(s.events.length, 0);
    const ok = await s.call('POST', `/api/compliance/products/${id}/assess`, { answers: ANSWERS, version: 1, prefilled: ['forms', 'bogus', 3] });
    assert.equal(ok.status, 200);
    assert.ok(ok.data.items.some((x: any) => x.item === 'genai_register'));
    assert.deepEqual(ok.data.assessment.prefilled, ['forms']);
    assert.equal(s.events.length, 1);
    const e = s.events[0];
    assert.deepEqual([e.kind, e.refType, e.refId, e.summary], ['compliance_assess', 'product', id, '合规自查：写作 App']);
    assert.ok((e.payload!.required as string[]).includes('大模型登记'));
  } finally {
    await s.close();
  }
});

test('assess：记录事件失败不影响响应', async () => {
  const s = await setup({ record: () => { throw new Error('boom'); } });
  try {
    const id = (await s.call('POST', '/api/compliance/products', { name: 'p' })).data.product.id;
    assert.equal((await s.call('POST', `/api/compliance/products/${id}/assess`, { answers: ANSWERS, version: 1 })).status, 200);
  } finally {
    await s.close();
  }
});

test('PATCH items：校验 400、不存在 404、成功返回事项；reminders 列表', async () => {
  const s = await setup();
  try {
    const id = (await s.call('POST', '/api/compliance/products', { name: 'p' })).data.product.id;
    const items = (await s.call('POST', `/api/compliance/products/${id}/assess`, { answers: ANSWERS, version: 1 })).data.items;
    const icp = items.find((x: any) => x.item === 'icp_filing');
    assert.equal((await s.call('PATCH', `/api/compliance/items/${icp.id}`, { status: 'na' })).status, 400);
    assert.equal((await s.call('PATCH', '/api/compliance/items/9999', { status: 'done' })).status, 404);
    const soon = Date.now() + 86_400_000;
    const ok = await s.call('PATCH', `/api/compliance/items/${icp.id}`, { ref_no: '京ICP备2026000001号', remind_at: soon });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.item.ref_no, '京ICP备2026000001号');
    const r = await s.call('GET', '/api/compliance/reminders');
    assert.deepEqual(r.data.reminders.map((x: any) => [x.itemId, x.kind]), [[icp.id, 'soon']]);
  } finally {
    await s.close();
  }
});

const offLlm = () => new Llm({ apiKey: '', baseUrl: 'https://llm.test', model: 'm', concurrency: 1 }, async () => {
  throw new Error('不应请求');
});

test('prefill：未配置模型 400；模型出错 502；成功只返回建议不落库', async () => {
  const off = await setup({ llm: offLlm() });
  try {
    const id = (await off.call('POST', '/api/compliance/products', { name: 'p' })).data.product.id;
    const r = await off.call('POST', `/api/compliance/products/${id}/prefill`, {});
    assert.deepEqual([r.status, r.data.error], [400, '未配置 DEEPSEEK_API_KEY，无法调用模型']);
    assert.equal((await off.call('POST', '/api/compliance/products/99/prefill', {})).status, 404);
  } finally {
    await off.close();
  }
  const bad = await setup({ prefill: async () => { throw new Error('boom'); } });
  try {
    const id = (await bad.call('POST', '/api/compliance/products', { name: 'p' })).data.product.id;
    const r = await bad.call('POST', `/api/compliance/products/${id}/prefill`, {});
    assert.deepEqual([r.status, r.data.error], [502, '模型调用失败，请稍后重试或手动填写']);
  } finally {
    await bad.close();
  }
  const ok = await setup({ llm: stubLlm([JSON.stringify({ answers: { ai_use: 'own' }, basis: { ai_use: '自研模型' } })]) });
  try {
    const id = (await ok.call('POST', '/api/compliance/products', { name: 'p', description: '自研模型' })).data.product.id;
    const r = await ok.call('POST', `/api/compliance/products/${id}/prefill`, {});
    assert.deepEqual(r.data, { answers: { ai_use: 'own' }, basis: { ai_use: '自研模型' } });
    assert.equal((await ok.call('GET', `/api/compliance/products/${id}`)).data.assessment, null);
  } finally {
    await ok.close();
  }
});

test('explain：只对可能需要的事项，成功后写入说明', async () => {
  const s = await setup({ llm: stubLlm(['建议咨询属地网信办 https://x.com']) });
  try {
    const id = (await s.call('POST', '/api/compliance/products', { name: 'p' })).data.product.id;
    const items = (await s.call('POST', `/api/compliance/products/${id}/assess`, { answers: { ...ANSWERS, ai_output: 'processed' }, version: 1 })).data.items;
    const req = items.find((x: any) => x.level === 'required');
    const maybe = items.find((x: any) => x.item === 'genai_filing');
    assert.equal((await s.call('POST', `/api/compliance/items/${req.id}/explain`, {})).status, 400);
    assert.equal((await s.call('POST', '/api/compliance/items/9999/explain', {})).status, 404);
    const r = await s.call('POST', `/api/compliance/items/${maybe.id}/explain`, {});
    assert.equal(r.status, 200);
    assert.equal(r.data.item.explain, '建议咨询属地网信办');
    const again = (await s.call('GET', `/api/compliance/products/${id}`)).data.items.find((x: any) => x.id === maybe.id);
    assert.equal(again.explain, '建议咨询属地网信办');
  } finally {
    await s.close();
  }
});

test('非法 id 400；未知路径 404', async () => {
  const s = await setup();
  try {
    for (const bad of ['abc', '0', '1.5']) assert.equal((await s.call('GET', `/api/compliance/products/${bad}`)).status, 400, bad);
    const u = await s.call('GET', '/api/compliance/nope');
    assert.deepEqual([u.status, u.data], [404, { error: '接口不存在' }]);
    assert.equal((await s.call('PUT', '/api/compliance/products', {})).status, 404);
    assert.equal((await s.call('GET', '/api/complianceX')).data.error, 'not compliance');
  } finally {
    await s.close();
  }
});
