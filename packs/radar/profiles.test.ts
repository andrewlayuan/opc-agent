import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';
import { loadSourceDefs, syncSources } from './collect.ts';
import { ProfileError, applyProfile, getActiveProfile, listProfiles, loadProfiles, profilesOf } from './profiles.ts';

function tmpDb(): { db: DB; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-prof-'));
  const db = openDb(path.join(dir, 't.db'));
  return { db, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}
const enabledIds = (db: DB) => new Set((db.prepare('SELECT id FROM sources WHERE enabled = 1').all() as { id: string }[]).map((r) => r.id));
const idsOf = (profile: string) => new Set(loadSourceDefs().filter((d) => profilesOf(d).includes(profile)).map((d) => d.id));
const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

test('档案数据：id 唯一；每个档案都有信息源；源引用的档案都存在；源的 id 与地址不重复', () => {
  const ps = loadProfiles();
  assert.deepEqual(ps.map((p) => p.id), ['ai', 'dev', 'finance', 'investor']);
  const defs = loadSourceDefs();
  const known = new Set(ps.map((p) => p.id));
  for (const d of defs) for (const id of d.profiles ?? []) assert.ok(known.has(id), `${d.id} 引用了不存在的档案 ${id}`);
  for (const p of ps) assert.ok(idsOf(p.id).size >= 8, `${p.id} 的信息源太少`);
  assert.equal(new Set(defs.map((d) => d.id)).size, defs.length, 'id 重复');
  assert.equal(new Set(defs.map((d) => d.url)).size, defs.length, '地址重复');
  for (const d of defs) assert.ok(/^https:\/\//.test(d.url), `${d.id} 不是 https`);
  assert.ok(defs.filter((d) => !d.profiles).length >= 60, '原有的内置源都归 ai');
  assert.ok(!defs.some((d) => d.profiles && d.filter), '新增的非 AI 源不按 AI 主题过滤');
});

test('首次同步：默认档案 ai 的源启用，其它档案独有的源停用；重复同步不改已有源的启用状态', () => {
  const { db, done } = tmpDb();
  syncSources(db);
  assert.equal(getActiveProfile(db), 'ai');
  assert.ok(same(enabledIds(db), idsOf('ai')));
  db.prepare("UPDATE sources SET enabled = 0 WHERE id = 'openai'").run();
  db.prepare("UPDATE sources SET enabled = 1 WHERE id = 'ruanyifeng'").run();
  syncSources(db);
  const row = (id: string) => (db.prepare('SELECT enabled FROM sources WHERE id = ?').get(id) as { enabled: number }).enabled;
  assert.equal(row('openai'), 0, '手动停用的保持');
  assert.equal(row('ruanyifeng'), 1, '手动启用的保持');
  done();
});

test('当前档案不是 ai 时：新出现的内置源只有属于当前档案才启用', () => {
  const { db, done } = tmpDb();
  db.prepare("INSERT INTO prefs(key, value, updated_at) VALUES ('source_profile', 'finance', 1)").run();
  syncSources(db);
  assert.ok(same(enabledIds(db), idsOf('finance')));
  done();
});

test('切换档案：启用该档案的内置源、停用其它内置源，保存当前档案；共享的源在两个档案里都启用', () => {
  const { db, done } = tmpDb();
  syncSources(db);
  const r = applyProfile(db, 'dev');
  assert.equal(r.id, 'dev');
  assert.equal(r.enabled, idsOf('dev').size);
  assert.equal(r.enabled + r.disabled, loadSourceDefs().length);
  assert.ok(same(enabledIds(db), idsOf('dev')));
  assert.equal(getActiveProfile(db), 'dev');
  assert.equal(listProfiles(db).active, 'dev');
  assert.ok(idsOf('dev').has('techmeme') && idsOf('investor').has('techmeme'));
  applyProfile(db, 'investor');
  assert.ok(enabledIds(db).has('techmeme') && enabledIds(db).has('sec-press') && !enabledIds(db).has('hn-front'));
  applyProfile(db, 'finance');
  assert.ok(enabledIds(db).has('sec-press') && !enabledIds(db).has('techmeme'));
  applyProfile(db, 'ai');
  assert.ok(same(enabledIds(db), idsOf('ai')), '切回 ai 恢复原样（此前手动停用的被重置）');
  done();
});

test('切换档案不碰自定义源：启用的保持启用，停用的保持停用', () => {
  const { db, done } = tmpDb();
  syncSources(db);
  const ins = db.prepare("INSERT INTO sources(id, name, url, kind, grp, lang, filter, max_items, custom, enabled) VALUES (?, ?, ?, 'feed', 'custom', 'en', 0, 20, 1, ?)");
  ins.run('custom-on', 'on', 'https://on.example/feed', 1);
  ins.run('custom-off', 'off', 'https://off.example/feed', 0);
  applyProfile(db, 'finance');
  const e = enabledIds(db);
  assert.ok(e.has('custom-on') && !e.has('custom-off'));
  done();
});

test('切换档案：未知或非字符串的 id 报错，且不改变任何状态', () => {
  const { db, done } = tmpDb();
  syncSources(db);
  const before = enabledIds(db);
  for (const bad of ['nope', '', undefined, 1, null, { id: 'dev' }]) assert.throws(() => applyProfile(db, bad), ProfileError);
  assert.ok(same(enabledIds(db), before));
  assert.equal(getActiveProfile(db), 'ai');
  done();
});

test('prefs 里的档案 id 无效时回落到 ai', () => {
  const { db, done } = tmpDb();
  db.prepare("INSERT INTO prefs(key, value, updated_at) VALUES ('source_profile', 'ghost', 1)").run();
  assert.equal(getActiveProfile(db), 'ai');
  assert.deepEqual(listProfiles(db).profiles.map((p) => p.count > 0), [true, true, true, true]);
  done();
});
