import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';
import { loadSourceDefs, syncSources } from './collect.ts';
import { isLegacyProfileId } from './profile-id.ts';
import {
  DEFAULT_PROFILE,
  ProfileError,
  activeProfile,
  applyProfile,
  getActiveProfile,
  lensFor,
  listProfiles,
  loadProfiles,
  migrateLegacyProfile,
  profilesOf,
  topicsOfProfile,
  withProfileFlag,
} from './profiles.ts';
import { loadTopics } from './text.ts';

function tmpDb(): { db: DB; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-prof-'));
  const db = openDb(path.join(dir, 't.db'));
  return { db, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}
const enabledIds = (db: DB) => new Set((db.prepare('SELECT id FROM sources WHERE enabled = 1').all() as { id: string }[]).map((r) => r.id));
const idsOf = (profile: string) => new Set(loadSourceDefs().filter((d) => profilesOf(d).includes(profile)).map((d) => d.id));
const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
const topics = loadTopics();

test('档案数据：7 个身份，id 唯一；每个身份都有适用人群、关注点、选择理由和分析口径', () => {
  const ps = loadProfiles();
  assert.deepEqual(
    ps.map((p) => p.id),
    ['tech', 'product', 'growth', 'founder', 'finance', 'legal', 'research'],
  );
  for (const p of ps) {
    assert.ok(p.name && p.who, `${p.id} 缺少名称或适用人群`);
    assert.ok(p.focus.length >= 2, `${p.id} 的关注点太少`);
    assert.ok(p.why.length >= 20, `${p.id} 没有说明为什么选这些源`);
    assert.ok(p.role && p.brief && p.importance && p.angle && p.sections, `${p.id} 缺少分析口径`);
  }
});

test('档案数据：每个身份都有信息源和主题；源/主题引用的身份都存在；源的 id 与地址不重复', () => {
  const ps = loadProfiles();
  const defs = loadSourceDefs();
  const known = new Set(ps.map((p) => p.id));
  for (const d of defs) for (const id of profilesOf(d)) assert.ok(known.has(id), `${d.id} 引用了不存在的档案 ${id}`);
  for (const t of topics) for (const id of profilesOf(t)) assert.ok(known.has(id), `主题 ${t.id} 引用了不存在的档案 ${id}`);
  for (const p of ps) {
    assert.ok(idsOf(p.id).size >= 8, `${p.id} 的信息源太少`);
    assert.ok(topicsOfProfile(topics, p.id).length >= 4, `${p.id} 的主题太少`);
  }
  assert.equal(new Set(defs.map((d) => d.id)).size, defs.length, '源 id 重复');
  assert.equal(new Set(defs.map((d) => d.url)).size, defs.length, '源地址重复');
  assert.equal(new Set(topics.map((t) => t.id)).size, topics.length, '主题 id 重复');
  for (const d of defs) assert.ok(/^https:\/\//.test(d.url), `${d.id} 不是 https`);
});

test('旧身份合并：ai/dev 并入 tech，investor 并入 founder，源里不再引用旧 id', () => {
  const ps = loadProfiles();
  for (const old of ['ai', 'dev', 'investor']) {
    assert.ok(!ps.some((p) => p.id === old), `${old} 应该已经合并`);
    assert.ok(isLegacyProfileId(old));
  }
  assert.equal(DEFAULT_PROFILE, 'tech');
  for (const d of loadSourceDefs()) assert.ok(!(d.profiles ?? []).some((p) => isLegacyProfileId(p)), `${d.id} 还在引用旧身份`);
  // 合并后的 tech 同时包含 AI 与通用开发两类源
  const tech = idsOf('tech');
  for (const id of ['openai', 'deepmind', 'hn-front', 'ruanyifeng', 'go-blog', 'fowler', 'arxiv-cl']) assert.ok(tech.has(id), `tech 缺少 ${id}`);
});

test('首次同步：默认身份 tech 的源启用，其它身份独有的源停用；重复同步不改已有源的启用状态', () => {
  const { db, done } = tmpDb();
  syncSources(db);
  assert.equal(getActiveProfile(db), 'tech');
  assert.ok(same(enabledIds(db), idsOf('tech')));
  assert.ok(!enabledIds(db).has('nature') && !enabledIds(db).has('edpb'), '其它身份独有的源默认停用');
  db.prepare("UPDATE sources SET enabled = 0 WHERE id = 'openai'").run();
  db.prepare("UPDATE sources SET enabled = 1 WHERE id = 'hn-front'").run();
  syncSources(db);
  const row = (id: string) => (db.prepare('SELECT enabled FROM sources WHERE id = ?').get(id) as { enabled: number }).enabled;
  assert.equal(row('openai'), 0, '手动停用的保持');
  assert.equal(row('hn-front'), 1, '手动启用的保持');
  done();
});

test('当前身份不是默认身份时：新出现的内置源只有属于当前身份才启用', () => {
  const { db, done } = tmpDb();
  db.prepare("INSERT INTO prefs(key, value, updated_at) VALUES ('source_profile', 'finance', 1)").run();
  syncSources(db);
  assert.ok(same(enabledIds(db), idsOf('finance')));
  done();
});

test('切换身份：启用该身份的内置源、停用其它内置源，保存当前身份；共享的源在两个身份里都启用', () => {
  const { db, done } = tmpDb();
  syncSources(db);
  const r = applyProfile(db, 'product');
  assert.equal(r.id, 'product');
  assert.equal(r.name, '产品 / 设计');
  assert.equal(r.enabled, idsOf('product').size);
  assert.equal(r.enabled + r.disabled, loadSourceDefs().length);
  assert.ok(same(enabledIds(db), idsOf('product')));
  assert.equal(getActiveProfile(db), 'product');
  assert.equal(listProfiles(db).active, 'product');
  assert.ok(idsOf('product').has('producthunt') && idsOf('tech').has('producthunt'), '共享的源两边都在');
  assert.equal(activeProfile(db).id, 'product');

  applyProfile(db, 'founder');
  assert.ok(enabledIds(db).has('producthunt') && enabledIds(db).has('techmeme') && enabledIds(db).has('sec-press'));
  assert.ok(!enabledIds(db).has('hn-front') && !enabledIds(db).has('nature'));

  applyProfile(db, 'research');
  assert.ok(enabledIds(db).has('nature') && enabledIds(db).has('arxiv-lg'));
  assert.ok(!enabledIds(db).has('techmeme'));

  applyProfile(db, 'tech');
  assert.ok(same(enabledIds(db), idsOf('tech')), '切回 tech 恢复原样（此前手动停用的被重置）');
  done();
});

test('切换身份不碰自定义源：启用的保持启用，停用的保持停用', () => {
  const { db, done } = tmpDb();
  syncSources(db);
  const ins = db.prepare("INSERT INTO sources(id, name, url, kind, grp, lang, filter, max_items, custom, enabled) VALUES (?, ?, ?, 'feed', 'custom', 'en', 0, 20, 1, ?)");
  ins.run('custom-on', 'on', 'https://on.example/feed', 1);
  ins.run('custom-off', 'off', 'https://off.example/feed', 0);
  applyProfile(db, 'legal');
  const e = enabledIds(db);
  assert.ok(e.has('custom-on') && !e.has('custom-off'));
  done();
});

test('切换身份：未知或非字符串的 id 报错，且不改变任何状态', () => {
  const { db, done } = tmpDb();
  syncSources(db);
  const before = enabledIds(db);
  for (const bad of ['nope', 'ai', '', undefined, 1, null, { id: 'product' }]) assert.throws(() => applyProfile(db, bad), ProfileError);
  assert.ok(same(enabledIds(db), before));
  assert.equal(getActiveProfile(db), 'tech');
  done();
});

test('prefs 里的身份 id 无效或还是旧 id 时：读取回落到 tech', () => {
  const { db, done } = tmpDb();
  db.prepare("INSERT INTO prefs(key, value, updated_at) VALUES ('source_profile', 'ghost', 1)").run();
  assert.equal(getActiveProfile(db), 'tech');
  const r = listProfiles(db, topics);
  assert.equal(r.profiles.length, 7);
  assert.deepEqual(
    r.profiles.map((p) => p.count > 0),
    r.profiles.map(() => true),
  );
  assert.ok(r.profiles.every((p) => p.topicCount > 0), '每个身份都有主题');
  done();
});

test('旧身份迁移：ai / dev → tech，investor → founder；迁移后重新应用一次信息源；已经不是旧 id 时不动', () => {
  for (const [from, to] of [
    ['ai', 'tech'],
    ['dev', 'tech'],
    ['investor', 'founder'],
  ] as const) {
    const { db, done } = tmpDb();
    syncSources(db);
    db.prepare("INSERT INTO prefs(key, value, updated_at) VALUES ('source_profile', ?, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(from);
    // 迁移前是一份与目标身份不一致的启用状态
    db.prepare("UPDATE sources SET enabled = 0 WHERE custom = 0").run();
    db.prepare("UPDATE sources SET enabled = 1 WHERE id = 'nature'").run();
    assert.equal(migrateLegacyProfile(db), to);
    assert.equal(getActiveProfile(db), to);
    assert.ok(same(enabledIds(db), idsOf(to)), `${from} 迁移后应启用 ${to} 的信息源`);
    assert.equal(migrateLegacyProfile(db), null, '迁移一次后不再重复');
    done();
  }
  const { db, done } = tmpDb();
  syncSources(db);
  assert.equal(migrateLegacyProfile(db), null, '没有 prefs 时不迁移');
  done();
});

test('当前身份的主题与分析口径：topicsOfProfile / lensFor / activeProfile 只返回本身份的范围', () => {
  const { db, done } = tmpDb();
  syncSources(db);
  for (const p of loadProfiles()) {
    applyProfile(db, p.id);
    const lens = lensFor(db, topics);
    assert.equal(lens.role, p.role);
    assert.equal(lens.brief, p.brief);
    assert.equal(lens.sections, p.sections);
    const mine = topicsOfProfile(topics, p.id);
    assert.ok(mine.length >= 4);
    assert.ok(mine.every((t) => profilesOf(t).includes(p.id)));
    assert.deepEqual(
      lens.topics.map((t) => t.id),
      mine.map((t) => t.id),
    );
  }
  applyProfile(db, 'legal');
  const legal = topicsOfProfile(topics, 'legal').map((t) => t.id);
  assert.ok(legal.includes('lg-privacy') && !legal.includes('llm'), '法务身份看不到技术主题');
  // 主题列表为空时退回全部，避免身份配错导致筛选栏空掉
  assert.deepEqual(
    topicsOfProfile(topics, 'ghost').map((t) => t.id),
    topics.map((t) => t.id),
  );
  done();
});

test('withProfileFlag：内置源按当前身份标记，自定义源总是属于当前身份；切换后跟着变', () => {
  const { db, done } = tmpDb();
  syncSources(db);
  db.prepare("INSERT INTO sources(id, name, url, kind, grp, lang, filter, max_items, custom, enabled) VALUES ('custom-x', 'x', 'https://x.example/f', 'feed', 'custom', 'en', 0, 20, 1, 0)").run();
  const flags = () => new Map(withProfileFlag(db, db.prepare('SELECT id, custom FROM sources').all() as { id: string; custom: number }[]).map((r) => [r.id, r.in_profile]));
  let f = flags();
  assert.equal(f.get('openai'), true);
  assert.equal(f.get('nature'), false);
  assert.equal(f.get('custom-x'), true);
  applyProfile(db, 'product');
  f = flags();
  assert.equal(f.get('openai'), false);
  assert.equal(f.get('producttalk'), true);
  assert.equal(f.get('producthunt'), true);
  assert.equal(f.get('custom-x'), true);
  assert.equal([...f.values()].filter(Boolean).length, idsOf('product').size + 1);
  done();
});
