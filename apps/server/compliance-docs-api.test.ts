import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Llm } from '../../packages/core/llm.ts';
import type { EventInput } from '../../packs/memory/events.ts';
import { ExtractError } from '../../packs/pm/extract.ts';
import { stubLlm, tmpWikiDb } from '../../packs/wiki/testutil.ts';
import { handleComplianceApi, type ComplianceDeps } from './compliance-api.ts';
import { HttpError, sendJson } from './http.ts';

const ANSWERS = {
  forms: ['app'], audience: 'public', overseas: 'no', charge: ['paid'], ai_use: 'cn_api', ai_output: 'raw', ai_media: ['text'], algo: 'no',
  social: ['none'], companion: 'no', scale: 'prelaunch', pi: ['general'], minors: 'no', cross_border: 'no',
};
const ENTITY = {
  company_name: '某某科技有限公司', credit_code: '91110108MA01ABCD2X', address: '北京', contact_email: 'a@b.cn', contact_phone: '010-1',
  pi_officer: '张三', pi_officer_contact: 'p@b.cn',
};
const FACTS = { effective_date: '2026-12-01', data_location: '北京', retention: '一年', sdks: [] };
const offLlm = () => new Llm({ apiKey: '', baseUrl: 'https://llm.test', model: 'm', concurrency: 1 }, async () => {
  throw new Error('不应调用');
});

async function setup(extra: Partial<ComplianceDeps> = {}) {
  const t = tmpWikiDb();
  const events: EventInput[] = [];
  const deps: ComplianceDeps = { db: t.db, llm: stubLlm([]), record: (e) => events.push(e), generate: async () => '模型正文', ...extra };
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
  const raw = (method: string, p: string, body?: unknown) => {
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body), (init.headers = { 'content-type': 'application/json' });
    return fetch(base + p, init);
  };
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await raw(method, p, body);
    return { status: r.status, data: (await r.json()) as Record<string, any> };
  };
  const product = async (answers: Record<string, unknown> | null = ANSWERS) => {
    const id = (await call('POST', '/api/compliance/products', { name: '写作 App', description: '帮人写稿' })).data.product.id as number;
    if (answers) assert.equal((await call('POST', `/api/compliance/products/${id}/assess`, { version: 1, answers })).status, 200);
    return id;
  };
  const close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    t.done();
  };
  return { ...t, deps, events, raw, call, product, close };
}
type S = Awaited<ReturnType<typeof setup>>;
const P = '/api/compliance';

async function ready(s: S) {
  await s.call('PUT', `${P}/entity`, ENTITY);
  const pid = await s.product();
  await s.call('PUT', `${P}/products/${pid}/facts`, FACTS);
  const doc = (await s.call('POST', `${P}/products/${pid}/docs`, { kind: 'privacy_policy' })).data.doc;
  for (const sec of doc.sections) if (sec.mode === 'model') assert.equal((await s.call('POST', `${P}/docs/${doc.id}/sections/${sec.key}/generate`)).status, 200);
  return { pid, id: doc.id as number };
}

test('meta 带资料字段与材料目录；主体读写；产品资料回显', async () => {
  const s = await setup();
  try {
    const m = (await s.call('GET', `${P}/meta`)).data;
    assert.equal(m.docKinds.length, 10);
    assert.deepEqual(Object.keys(m.docKinds[0]).sort(), ['chapters', 'items', 'kind', 'name', 'usage']);
    assert.deepEqual(Object.keys(m.docKinds[0].chapters[0]).sort(), ['key', 'mode', 'title', 'uses']);
    assert.ok(m.entityFields.some((f: any) => f.key === 'company_name') && m.factFields.some((f: any) => f.key === 'sdks'));
    assert.equal((await s.call('PUT', `${P}/entity`, { contact_email: 'a@' })).status, 400);
    assert.deepEqual((await s.call('PUT', `${P}/entity`, { company_name: ' 某某 ' })).data, { entity: { company_name: '某某' } });
    assert.deepEqual((await s.call('GET', `${P}/entity`)).data, { entity: { company_name: '某某' } });
    const pid = await s.product(null);
    const f = await s.call('PUT', `${P}/products/${pid}/facts`, { site: 'https://a.com' });
    assert.deepEqual([f.status, f.data.facts], [200, { site: 'https://a.com' }]);
    assert.equal((await s.call('GET', `${P}/products/${pid}`)).data.facts.site, 'https://a.com');
    assert.equal((await s.call('PUT', `${P}/products/${pid}/facts`, { effective_date: 'x' })).status, 400);
    assert.equal((await s.call('PUT', `${P}/products/999/facts`, {})).status, 404);
  } finally {
    await s.close();
  }
});

test('起草与读取：未判定 400、不需要 400、未知 400、重复 409；列表计数', async () => {
  const s = await setup();
  try {
    const bare = await s.product(null);
    const r0 = await s.call('POST', `${P}/products/${bare}/docs`, { kind: 'privacy_policy' });
    assert.deepEqual([r0.status, r0.data.error], [400, '请先完成问卷判定']);
    const pid = await s.product();
    assert.deepEqual((await s.call('POST', `${P}/products/${pid}/docs`, { kind: 'security_report' })).data.error, '当前判定不需要这份材料');
    assert.deepEqual((await s.call('POST', `${P}/products/${pid}/docs`, { kind: 'x' })).data.error, '未知材料');
    assert.equal((await s.call('POST', `${P}/products/999/docs`, { kind: 'privacy_policy' })).status, 404);
    const c = await s.call('POST', `${P}/products/${pid}/docs`, { kind: 'privacy_policy' });
    assert.equal(c.status, 200);
    assert.equal(c.data.doc.kind, 'privacy_policy');
    assert.equal((await s.call('POST', `${P}/products/${pid}/docs`, { kind: 'privacy_policy' })).status, 409);
    const g = await s.call('GET', `${P}/docs/${c.data.doc.id}`);
    assert.deepEqual([g.status, g.data.doc.sections.length], [200, 11]);
    assert.equal((await s.call('GET', `${P}/docs/999`)).status, 404);
    const l = await s.call('GET', `${P}/products/${pid}/docs`);
    assert.equal(l.data.docs.length, 10);
    assert.equal(l.data.docs[0].doc.pending, 5);
    assert.equal((await s.call('GET', `${P}/products/999/docs`)).status, 404);
  } finally {
    await s.close();
  }
});

test('生成：固定章无模型可用；模型章未配置 400；模型出错 502；成功 rev 1；定稿后 409', async () => {
  const off = await setup({ llm: offLlm() });
  try {
    const pid = await off.product();
    const id = (await off.call('POST', `${P}/products/${pid}/docs`, { kind: 'privacy_policy' })).data.doc.id;
    const f = await off.call('POST', `${P}/docs/${id}/sections/intro/generate`);
    assert.deepEqual([f.status, f.data.section.rev, f.data.section.origin], [200, 2, 'fixed']);
    const m = await off.call('POST', `${P}/docs/${id}/sections/collect/generate`);
    assert.deepEqual([m.status, m.data.error], [400, '未配置 DEEPSEEK_API_KEY，无法调用模型']);
    assert.equal((await off.call('POST', `${P}/docs/${id}/sections/nope/generate`)).status, 404);
  } finally {
    await off.close();
  }
  const bad = await setup({ generate: async () => { throw new Error('x'); } });
  try {
    const pid = await bad.product();
    const id = (await bad.call('POST', `${P}/products/${pid}/docs`, { kind: 'privacy_policy' })).data.doc.id;
    const r = await bad.call('POST', `${P}/docs/${id}/sections/collect/generate`);
    assert.deepEqual([r.status, r.data.error], [502, '模型调用失败，请稍后重试']);
  } finally {
    await bad.close();
  }
  const s = await setup();
  try {
    const { id } = await ready(s);
    const sec = (await s.call('GET', `${P}/docs/${id}`)).data.doc.sections.find((x: any) => x.key === 'collect');
    assert.deepEqual([sec.rev, sec.origin, sec.body], [1, 'generate', '模型正文']);
    assert.equal((await s.call('POST', `${P}/docs/${id}/finalize`)).status, 200);
    const r = await s.call('POST', `${P}/docs/${id}/sections/collect/generate`);
    assert.deepEqual([r.status, r.data.error], [409, '材料已定稿，先取消定稿']);
  } finally {
    await s.close();
  }
});

test('保存、历史、差异、回退；baseRev 冲突 409', async () => {
  const s = await setup();
  try {
    const { id } = await ready(s);
    const u = `${P}/docs/${id}/sections/collect`;
    const r1 = await s.call('PUT', u, { body: '手改', baseRev: 1 });
    assert.deepEqual([r1.status, r1.data.section.rev, r1.data.section.origin], [200, 2, 'edit']);
    const c = await s.call('PUT', u, { body: 'x', baseRev: 1 });
    assert.deepEqual([c.status, c.data.error], [409, '内容已在别处更新，请刷新']);
    assert.equal((await s.call('PUT', u, { body: 1, baseRev: 2 })).status, 400);
    assert.equal((await s.call('PUT', u, { body: '字'.repeat(20001), baseRev: 2 })).status, 400);
    const list = await s.call('GET', `${u}/revisions`);
    assert.deepEqual(list.data.revisions.map((x: any) => x.n), [2, 1]);
    const one = await s.call('GET', `${u}/revisions?rev=1`);
    assert.deepEqual([one.data.revision.body, one.data.revision.diff.lines], ['模型正文', [{ t: '-', s: '模型正文' }, { t: '+', s: '手改' }]]);
    assert.equal((await s.call('GET', `${u}/revisions?rev=9`)).status, 404);
    assert.equal((await s.call('GET', `${u}/revisions?rev=x`)).status, 400);
    const back = await s.call('POST', `${u}/restore`, { rev: 1 });
    assert.deepEqual([back.status, back.data.section.rev, back.data.section.body, back.data.section.origin], [200, 3, '模型正文', 'restore']);
    assert.equal((await s.call('POST', `${u}/restore`, { rev: 99 })).status, 404);
  } finally {
    await s.close();
  }
});

test('定稿：有待填 400 带 placeholders；通过后记事件；导出 md/html/docx；docx 转换失败 422 且 md 仍可用', async () => {
  const s = await setup({ convert: async () => { throw new ExtractError(422, '未安装 LibreOffice，无法转换'); } });
  try {
    const { pid, id } = await ready(s);
    await s.call('PUT', `${P}/products/${pid}/facts`, {});
    const fixedKeys = (await s.call('GET', `${P}/docs/${id}`)).data.doc.sections.filter((x: any) => x.mode === 'fixed').map((x: any) => x.key);
    for (const k of fixedKeys) await s.call('POST', `${P}/docs/${id}/sections/${k}/generate`);
    const bad = await s.call('POST', `${P}/docs/${id}/finalize`);
    assert.deepEqual([bad.status, bad.data.error], [400, '还有待填内容']);
    assert.ok(bad.data.placeholders.some((p: any) => p.key === 'storage' && p.fields.includes('数据存放地')));
    await s.call('PUT', `${P}/products/${pid}/facts`, FACTS);
    for (const k of fixedKeys) await s.call('POST', `${P}/docs/${id}/sections/${k}/generate`);
    const ok = await s.call('POST', `${P}/docs/${id}/finalize`);
    assert.deepEqual([ok.status, ok.data.doc.status], [200, 'final']);
    const ev = s.events.at(-1)!;
    assert.deepEqual([ev.kind, ev.refType, ev.refId, ev.payload], ['compliance_doc_final', 'product', pid, { kind: 'privacy_policy' }]);
    assert.equal(ev.summary, '定稿：写作 App 隐私政策');
    const md = await s.raw('GET', `${P}/docs/${id}/export?format=md`);
    assert.equal(md.status, 200);
    assert.equal(md.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.ok(md.headers.get('content-disposition')!.includes("filename*=UTF-8''"));
    assert.ok((await md.text()).startsWith('# 隐私政策'));
    const html = await s.raw('GET', `${P}/docs/${id}/export?format=html`);
    assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.ok((await html.text()).startsWith('<!DOCTYPE html>'));
    const docx = await s.call('GET', `${P}/docs/${id}/export?format=docx`);
    assert.deepEqual([docx.status, docx.data.error], [422, '未安装 LibreOffice，无法转换']);
    assert.equal((await s.call('GET', `${P}/docs/${id}/export?format=pdf`)).status, 400);
    assert.equal((await s.call('GET', `${P}/docs/999/export?format=md`)).status, 404);
    const un = await s.call('POST', `${P}/docs/${id}/unfinalize`);
    assert.deepEqual([un.status, un.data.doc.status], [200, 'draft']);
  } finally {
    await s.close();
  }
  const ok = await setup({ convert: async () => Buffer.from('DOCX') });
  try {
    const { id } = await ready(ok);
    const r = await ok.raw('GET', `${P}/docs/${id}/export?format=docx`);
    assert.equal(r.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(Buffer.from(await r.arrayBuffer()).toString(), 'DOCX');
  } finally {
    await ok.close();
  }
});

test('删除：定稿 409；只能删已移除章 400；非法 id 400；未知路径 404', async () => {
  const s = await setup();
  try {
    const { pid, id } = await ready(s);
    const sec = await s.call('DELETE', `${P}/docs/${id}/sections/collect`);
    assert.deepEqual([sec.status, sec.data.error], [400, '只能删除模板已移除的章节']);
    await s.call('POST', `${P}/products/${pid}/assess`, { version: 1, answers: { ...ANSWERS, cross_border: 'lt10w' } });
    await s.call('GET', `${P}/docs/${id}`);
    await s.call('POST', `${P}/products/${pid}/assess`, { version: 1, answers: ANSWERS });
    await s.call('GET', `${P}/docs/${id}`);
    assert.equal((await s.call('DELETE', `${P}/docs/${id}/sections/cross_border`)).status, 200);
    assert.equal((await s.call('DELETE', `${P}/docs/${id}/sections/cross_border`)).status, 404);
    await s.call('POST', `${P}/docs/${id}/finalize`);
    assert.equal((await s.call('DELETE', `${P}/docs/${id}`)).status, 409);
    await s.call('POST', `${P}/docs/${id}/unfinalize`);
    assert.equal((await s.call('DELETE', `${P}/docs/${id}`)).status, 200);
    assert.equal((await s.call('DELETE', `${P}/docs/${id}`)).status, 404);
    assert.equal((await s.call('GET', `${P}/docs/abc`)).status, 400);
    assert.equal((await s.call('GET', `${P}/docs/1/nope`)).status, 404);
    assert.equal((await s.call('PATCH', `${P}/entity`, {})).status, 404);
  } finally {
    await s.close();
  }
});
