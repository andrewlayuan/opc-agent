import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';
import { getProfile, setProfile } from './store.ts';
import { MemoryError } from './store.ts';
import { listProfileVersions, restoreProfile, writeProfile } from './profile-versions.ts';
import { undoChange, recentChanges } from './store.ts';
import {
  SKILL_LIMITS,
  acceptPending,
  createSkill,
  deleteSkill,
  getSkill,
  listSkillRevisions,
  listSkills,
  restoreSkill,
  setPending,
  setSkillStatus,
  updateSkill,
  validateSkill,
} from './skills.ts';

function setup(): { db: DB; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-sk-'));
  const db = openDb(path.join(dir, 't.db'));
  return { db, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}
const statusOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof MemoryError) return { status: e.status, message: e.message };
    throw e;
  }
  return null;
};
const S = { name: '周报起草与整理流程', scene: '当你需要把这一周做的事情整理成一份周报时使用', steps: ['列出一条主线', '按项目分组'], cautions: [], example: '' };

test('迁移 14：三张表存在，重复打开不重复迁移', () => {
  const { db, done } = setup();
  const v = db.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(v.user_version, 16);
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
  for (const t of ['skills', 'skill_revisions', 'profile_versions']) assert.ok(names.includes(t), t);
  done();
});

test('validateSkill：名称 8–40 字、场景 20–200、步骤 2–8 条，去空白，超长 400', () => {
  assert.deepEqual(validateSkill(S), S);
  const bad = (o: Record<string, unknown>, msg: string) => assert.deepEqual(statusOf(() => validateSkill({ ...S, ...o })), { status: 400, message: msg });
  bad({ name: '短' }, '技能名需在 8–40 字之间');
  bad({ name: '一'.repeat(41) }, '技能名需在 8–40 字之间');
  bad({ scene: '太短' }, '何时用需在 20–200 字之间');
  bad({ scene: '一'.repeat(201) }, '何时用需在 20–200 字之间');
  bad({ steps: ['只有一步'] }, '步骤需在 2–8 条之间');
  bad({ steps: Array.from({ length: 9 }, (_, i) => `第 ${i}`) }, '步骤需在 2–8 条之间');
  bad({ steps: ['一步', '二'.repeat(201)] }, '步骤需在 2–8 条之间');
  bad({ cautions: Array.from({ length: 6 }, (_, i) => `注意 ${i}`) }, '注意最多 5 条');
  bad({ example: '一'.repeat(601) }, '示例需在 0–600 字之间');
  bad({ name: '  短  ' }, '技能名需在 8–40 字之间');
  const trimmed = validateSkill({ ...S, name: `  ${S.name}  `, steps: ['  列出主线  ', '按项目分组'] });
  assert.equal(trimmed.name, '周报起草与整理流程');
  assert.deepEqual(trimmed.steps, ['列出主线', '按项目分组']);
  assert.equal(SKILL_LIMITS.max, 40);
});

test('技能：新建进候选、采纳与停用、非法状态 400、删除后 404', () => {
  const { db, done } = setup();
  const id = createSkill(db, S, { source: 'manual' });
  const s = getSkill(db, id);
  assert.deepEqual([s.name, s.status, s.source, s.manual, s.uses, s.revisions], ['周报起草与整理流程', 'candidate', 'manual', true, 0, 1]);
  assert.deepEqual(listSkills(db).map((x) => x.id), [id]);
  assert.deepEqual(listSkills(db, { status: 'active' }), []);
  assert.equal(setSkillStatus(db, id, 'active').status, 'active');
  assert.deepEqual(listSkills(db, { status: 'active' }).map((x) => x.id), [id]);
  assert.deepEqual(statusOf(() => setSkillStatus(db, id, 'live')), { status: 400, message: '技能状态不对' });
  deleteSkill(db, id);
  assert.deepEqual(statusOf(() => getSkill(db, id)), { status: 404, message: '技能不存在' });
  done();
});

test('技能上限 40：第 41 条 409', () => {
  const { db, done } = setup();
  for (let i = 0; i < 40; i++) createSkill(db, { ...S, name: `技能名第 ${i} 号` }, { source: 'manual' });
  assert.deepEqual(statusOf(() => createSkill(db, S, { source: 'manual' })), { status: 409, message: '技能最多 40 条' });
  done();
});

test('版本：每次编辑写新版本，manual 置位，只在 20 个以内，回退写 restore', () => {
  const { db, done } = setup();
  const id = createSkill(db, S, { source: 'auto' });
  const e = updateSkill(db, id, { ...S, steps: ['改过的第一步', '第二步'] }, { origin: 'manual', reason: '手改' });
  assert.deepEqual([e.rev, e.manual, e.steps[0], e.revisions], [2, true, '改过的第一步', 2]);
  for (let i = 0; i < 25; i++) updateSkill(db, id, { ...S, steps: [`第 ${i} 次`, '第二步'] }, { origin: 'auto' });
  const revs = listSkillRevisions(db, id);
  assert.equal(revs.length, 20);
  assert.equal(revs[0].rev, 27);
  assert.equal(revs.at(-1)!.rev, 8);
  const back = restoreSkill(db, id, 8);
  assert.deepEqual([back.rev, back.steps[0], back.manual, back.revisions], [28, '第 5 次', true, 20]);
  assert.equal(listSkillRevisions(db, id)[0].origin, 'restore');
  assert.deepEqual(statusOf(() => restoreSkill(db, id, 2)), { status: 404, message: '版本不存在' }, '超出 20 个的旧版本已删除');
  assert.deepEqual(statusOf(() => restoreSkill(db, id, 99)), { status: 404, message: '版本不存在' });
  done();
});

test('版本：内容没变不写新版本（手动保存仍置 manual）；回退自动技能后置 manual；采用新版清空暂存', () => {
  const { db, done } = setup();
  const id = createSkill(db, S, { source: 'auto' });
  assert.equal(updateSkill(db, id, { ...S }, { origin: 'auto' }).rev, 1, '自动更新内容相同不写版本');
  const same = updateSkill(db, id, { ...S, steps: [' 列出一条主线 ', '按项目分组'] }, { origin: 'manual' });
  assert.deepEqual([same.rev, same.manual], [1, true], '手动保存相同内容：不写版本，但记为手改');
  const id2 = createSkill(db, { ...S, name: '另一个自动沉淀的技能' }, { source: 'auto' });
  updateSkill(db, id2, { ...S, name: '另一个自动沉淀的技能', steps: ['新一步', '再一步'] }, { origin: 'auto' });
  assert.equal(getSkill(db, id2).manual, false);
  const back = restoreSkill(db, id2, 1);
  assert.deepEqual([back.rev, back.manual], [3, true], '回退是用户的选择，之后自动沉淀不再覆盖');
  setPending(db, id2, { ...S, name: '另一个自动沉淀的技能', steps: ['暂存一步', '暂存两步'] });
  const acc = acceptPending(db, id2);
  assert.deepEqual([acc.rev, acc.pending, getSkill(db, id2).pending, acc.steps[0]], [4, null, null, '暂存一步']);
  done();
});

test('画像回退：撤销回退后 manual 保持；按码点截断不丢字', () => {
  const { db, done } = setup();
  setProfile(db, '我自己写的画像');
  writeProfile(db, '我自己写的画像，后来自动补充了一些内容', { origin: 'auto' });
  restoreProfile(db, 1);
  assert.equal(getProfile(db).manual, true);
  undoChange(db, recentChanges(db, 1)[0].id);
  assert.equal(getProfile(db).manual, true, '撤销回退不应把手改标记清掉');
  const emoji = '😀'.repeat(1000);
  setProfile(db, emoji);
  setProfile(db, '换一个');
  const rev = listProfileVersions(db).find((v) => v.content === emoji)!.rev;
  assert.equal(restoreProfile(db, rev).content, emoji, '1000 个表情是 1000 字，不应按 UTF-16 截断');
  done();
});

test('画像版本：内容相同不写；差异小不写由调用方判断；回退可再来一次', () => {
  const { db, done } = setup();
  assert.deepEqual(listProfileVersions(db), []);
  writeProfile(db, '我是独立开发者', { origin: 'manual' });
  assert.equal(getProfile(db).content, '我是独立开发者');
  assert.deepEqual(listProfileVersions(db).map((v) => v.content), ['我是独立开发者']);
  writeProfile(db, '我是独立开发者', { origin: 'manual' });
  assert.equal(listProfileVersions(db).length, 1, '内容相同不写版本');
  writeProfile(db, '我是独立开发者，做 AI 工具', { origin: 'auto', reason: '两条事件' });
  assert.deepEqual(listProfileVersions(db).map((v) => v.origin), ['auto', 'manual']);
  assert.equal(listProfileVersions(db)[0].reason, '两条事件');
  const r = restoreProfile(db, 1);
  assert.equal(r.content, '我是独立开发者');
  assert.deepEqual(listProfileVersions(db).map((v) => [v.rev, v.origin]), [[3, 'restore'], [2, 'auto'], [1, 'manual']]);
  writeProfile(db, '手动改回', { origin: 'manual' });
  setProfile(db, '另一条路');
  assert.equal(getProfile(db).content, '另一条路');
  assert.equal(listProfileVersions(db)[0].content, '另一条路', 'setProfile 也写版本');
  assert.deepEqual(statusOf(() => restoreProfile(db, 99)), { status: 404, message: '版本不存在' });
  done();
});
