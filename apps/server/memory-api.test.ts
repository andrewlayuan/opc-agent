import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import type { Llm } from '../../packages/core/llm.ts';
import { MemoryKeeper } from '../../packs/memory/consolidate.ts';
import { SkillKeeper } from '../../packs/memory/crystallize.ts';
import type { CrystalRun } from '../../packs/memory/crystallize.ts';
import { recordEvent } from '../../packs/memory/events.ts';
import { setPending } from '../../packs/memory/skills.ts';
import { HttpError, sendJson } from './http.ts';
import { handleMemoryApi } from './memory-api.ts';
import type { MemoryApiDeps } from './memory-api.ts';

const llm = { enabled: true } as unknown as Llm;

async function setup(o: { skillsOn?: boolean; run?: (force: boolean) => Promise<CrystalRun> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-mapi-'));
  const db = openDb(path.join(dir, 't.db'));
  const keeper = new MemoryKeeper(db, llm, { log: () => {}, run: async () => ({ events: 0, applied: 0, profile: false, skipped: 0 }) });
  const run = o.run ?? (async () => ({ ran: true, added: 0, updated: 0, blocked: 0, dropped: 0 }));
  const skills = new SkillKeeper(db, llm, { enabled: o.skillsOn ?? true, dailyCalls: 12, run, log: () => {} });
  const deps: MemoryApiDeps = { db, keeper, skills, llmEnabled: true };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    handleMemoryApi(deps, req, res, req.method ?? 'GET', url.pathname)
      .then((hit) => {
        if (!hit) sendJson(res, 404, { error: 'not memory' });
      })
      .catch((e) => sendJson(res, e instanceof HttpError ? e.status : 500, { error: e instanceof Error ? e.message : String(e) }));
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
    skills.stop();
    keeper.stop();
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { db, dir, skills, raw, call, close };
}

const S = '/api/memory/skills';
const SKILL = {
  name: '周报起草与整理流程',
  scene: '每周五需要把本周进展整理成周报发给团队和投资人时',
  steps: ['先列本周完成的三件事', '再写下周计划和需要的支持'],
  cautions: ['数字要和看板一致'],
  example: '',
};

test('技能接口：新建、校验、列表、编辑、状态、版本、回退、删除', async () => {
  const s = await setup();
  const bad = await s.call('POST', S, { ...SKILL, name: '太短' });
  assert.deepEqual([bad.status, bad.data.error], [400, '技能名需在 8–40 字之间']);
  const created = await s.call('POST', S, SKILL);
  assert.equal(created.status, 201);
  const id = created.data.id as number;
  let list = (await s.call('GET', S)).data;
  assert.deepEqual(list.skills.map((x: { id: number; status: string; rev: number; manual: boolean }) => [x.id, x.status, x.rev, x.manual]), [[id, 'candidate', 1, true]]);
  assert.deepEqual([list.enabled, list.blocker, list.running, list.last], [true, null, false, null]);
  assert.deepEqual(list.runs, []);

  const put = await s.call('PUT', `${S}/${id}`, { ...SKILL, steps: [...SKILL.steps, '最后核对数字再发送'] });
  assert.equal(put.status, 200);
  assert.equal(put.data.skill.rev, 2);
  assert.equal((await s.call('POST', `${S}/${id}/status`, { status: 'active' })).data.skill.status, 'active');
  assert.equal((await s.call('POST', `${S}/${id}/status`, { status: 'x' })).status, 400);
  const revs = (await s.call('GET', `${S}/${id}/revisions`)).data.revisions;
  assert.deepEqual(revs.map((r: { rev: number; origin: string }) => [r.rev, r.origin]), [[2, 'manual'], [1, 'manual']]);
  const back = await s.call('POST', `${S}/${id}/restore`, { rev: 1 });
  assert.deepEqual([back.status, back.data.skill.steps.length, back.data.skill.rev], [200, 2, 3]);
  assert.equal((await s.call('POST', `${S}/${id}/restore`, { rev: 99 })).status, 404);

  assert.equal((await s.call('POST', `${S}/${id}/accept`)).status, 409);
  setPending(s.db, id, { ...SKILL, scene: '每周五需要把本周进展整理成周报并同步给全体同事时' });
  assert.equal((await s.call('GET', S)).data.skills[0].pending.scene, '每周五需要把本周进展整理成周报并同步给全体同事时');
  assert.equal((await s.call('DELETE', `${S}/${id}/pending`)).status, 200);
  assert.equal((await s.call('GET', S)).data.skills[0].pending, null);
  setPending(s.db, id, { ...SKILL, scene: '每周五需要把本周进展整理成周报并同步给全体同事时' });
  const acc = await s.call('POST', `${S}/${id}/accept`);
  assert.deepEqual([acc.status, acc.data.skill.scene, acc.data.skill.pending], [200, '每周五需要把本周进展整理成周报并同步给全体同事时', null]);

  assert.equal((await s.call('DELETE', `${S}/${id}`)).status, 200);
  assert.equal((await s.call('DELETE', `${S}/${id}`)).status, 404);
  assert.equal((await s.call('PUT', `${S}/abc`, SKILL)).status, 404);
  assert.equal((await s.call('PUT', `${S}/0`, SKILL)).status, 400);
  list = (await s.call('GET', S)).data;
  assert.deepEqual(list.skills, []);
  await s.close();
});

test('立即沉淀：关闭或没有新事件时 409 带原因；可以跑时 202 后台运行，跑完 last 有结果', async () => {
  const off = await setup({ skillsOn: false });
  const r0 = await off.call('POST', `${S}/crystallize`);
  assert.deepEqual([r0.status, r0.data.error], [409, '技能沉淀已关闭（OPC_SKILLS=off）']);
  assert.equal((await off.call('GET', '/api/memory')).data.skillsEnabled, false);
  await off.close();

  let release: () => void = () => {};
  const s = await setup({
    run: async () => {
      await new Promise<void>((r) => (release = r));
      return { ran: true, added: 2, updated: 0, blocked: 0, dropped: 1 };
    },
  });
  const r1 = await s.call('POST', `${S}/crystallize`);
  assert.deepEqual([r1.status, r1.data.error], [409, '没有新事件']);
  recordEvent(s.db, { kind: 'item_star', refType: 'item', refId: 1, summary: '收藏：端侧模型' }, Date.now());
  const r2 = await s.call('POST', `${S}/crystallize`);
  assert.deepEqual([r2.status, r2.data], [202, { started: true }]);
  assert.equal((await s.call('GET', '/api/memory')).data.crystallizing, true);
  release();
  await new Promise((r) => setTimeout(r, 20));
  const after = (await s.call('GET', S)).data;
  assert.equal(after.running, false);
  assert.equal(after.last.run.added, 2);
  await s.close();
});

test('画像版本：保存记版本、列表、回退；/api/memory 带技能与版本计数', async () => {
  const s = await setup();
  await s.call('PUT', '/api/memory/profile', { content: '独立开发者' });
  await s.call('PUT', '/api/memory/profile', { content: '独立开发者，在做律所合同审查工具' });
  const vs = (await s.call('GET', '/api/memory/profile/versions')).data.versions;
  assert.deepEqual(vs.map((v: { content: string; origin: string }) => [v.content, v.origin]), [
    ['独立开发者，在做律所合同审查工具', 'manual'],
    ['独立开发者', 'manual'],
  ]);
  const back = await s.call('POST', '/api/memory/profile/restore', { rev: vs[1].rev });
  assert.deepEqual([back.status, back.data.content], [200, '独立开发者']);
  assert.equal((await s.call('POST', '/api/memory/profile/restore', { rev: 999 })).status, 404);
  assert.equal((await s.call('POST', '/api/memory/profile/restore', { rev: 'x' })).status, 400);
  await s.call('POST', S, SKILL);
  const m = (await s.call('GET', '/api/memory')).data;
  assert.equal(m.profile.content, '独立开发者');
  assert.deepEqual(m.skills, { total: 1, active: 0, candidate: 1, retired: 0, pending: 0 });
  assert.equal(m.profileVersions, 3);
  assert.deepEqual([m.skillsEnabled, m.skillsBlocker, m.crystallizing], [true, null, false]);
  await s.close();
});

test('导出：默认仍是 JSON；format=zip 打包记忆、技能、画像与画像版本', async () => {
  const s = await setup();
  await s.call('PUT', '/api/memory/profile', { content: '独立开发者' });
  await s.call('POST', S, SKILL);
  const j = await s.raw('GET', '/api/memory/export');
  assert.match(j.headers.get('content-type') ?? '', /application\/json/);
  assert.ok('memories' in ((await j.json()) as object));
  const z = await s.raw('GET', '/api/memory/export?format=zip');
  assert.equal(z.status, 200);
  assert.equal(z.headers.get('content-type'), 'application/zip');
  assert.match(z.headers.get('content-disposition') ?? '', /opc-memory-\d{8}\.zip/);
  const file = path.join(s.dir, 'out.zip');
  fs.writeFileSync(file, Buffer.from(await z.arrayBuffer()));
  const names = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(names, ['memories.json', 'profile-versions.json', 'profile.md', 'skills.json']);
  const skills = JSON.parse(execFileSync('unzip', ['-p', file, 'skills.json'], { encoding: 'utf8' }));
  assert.equal(skills[0].name, SKILL.name);
  assert.equal(skills[0].revisions.length, 1);
  assert.equal(execFileSync('unzip', ['-p', file, 'profile.md'], { encoding: 'utf8' }), '独立开发者\n');
  assert.equal((await s.raw('GET', '/api/memory/export?format=xml')).status, 400);
  await s.close();
});
