import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';
import {
  createDoc,
  deleteDoc,
  deleteSection,
  docProductId,
  finalizeDoc,
  getDoc,
  getRevision,
  listDocs,
  listRevisions,
  prepareGenerate,
  restoreSection,
  saveSection,
  unfinalizeDoc,
  writeGenerated,
} from './docs-store.ts';
import { ENTITY_FIELDS, saveEntity, saveFacts } from './facts.ts';
import type { Answers } from './rules.ts';
import { CpError, assessAndMerge, createProduct, deleteProduct } from './store.ts';

const writer = (o: Answers = {}): Answers => ({
  forms: ['app'], audience: 'public', overseas: 'no', charge: ['paid'], ai_use: 'cn_api', ai_output: 'raw', ai_media: ['text'], algo: 'no',
  social: ['none'], companion: 'no', scale: 'prelaunch', pi: ['general'], minors: 'no', cross_border: 'no', ...o,
});
const FULL_FACTS = { effective_date: '2026-12-01', data_location: '北京', retention: '一年', sdks: [] };
const throwsCp = (fn: () => unknown, status: number, msg?: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof CpError && e.status === status && (!msg || msg.test(e.message)));

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-cpd-'));
  const db = openDb(path.join(dir, 't.db'));
  saveEntity(db, Object.fromEntries(ENTITY_FIELDS.map((f) => [f.key, f.key === 'credit_code' ? '91110108MA01ABCD2X' : f.key === 'contact_email' ? 'a@b.cn' : `E${f.key}`])));
  const pid = createProduct(db, { name: '写作 App', description: '帮人写稿' });
  assessAndMerge(db, pid, writer(), []);
  const bare = createProduct(db, { name: '未判定' });
  return { db, pid, bare, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}
const sec = (db: DB, id: number, key: string) => getDoc(db, id).sections.find((s) => s.key === key)!;
function genAll(db: DB, id: number, body = '正文') {
  for (const s of getDoc(db, id).sections) {
    if (s.removed || s.mode !== 'model' || s.rev > 0) continue;
    writeGenerated(db, id, s.key, body, 'generate', prepareGenerate(db, id, s.key).hash);
  }
}
function refreshFixed(db: DB, id: number) {
  for (const s of getDoc(db, id).sections) {
    if (s.removed || s.mode !== 'fixed') continue;
    const g = prepareGenerate(db, id, s.key);
    writeGenerated(db, id, s.key, g.chapter.render!(g.ctx), 'fixed', g.hash);
  }
}

test('起草：未判定、不需要、未知 400；重复 409；固定章写版本 1，模型章 rev 0；产品不存在 404', () => {
  const { db, pid, bare, done } = setup();
  throwsCp(() => createDoc(db, bare, 'privacy_policy'), 400, /请先完成问卷判定/);
  throwsCp(() => createDoc(db, pid, 'security_report'), 400, /当前判定不需要这份材料/);
  throwsCp(() => createDoc(db, pid, 'nope'), 400, /未知材料/);
  throwsCp(() => createDoc(db, pid, 3), 400, /未知材料/);
  throwsCp(() => createDoc(db, 999, 'privacy_policy'), 404);
  const d = createDoc(db, pid, 'privacy_policy', 10);
  throwsCp(() => createDoc(db, pid, 'privacy_policy'), 409, /材料已存在/);
  assert.deepEqual([d.kind, d.name, d.usage, d.status, d.template_version, d.product_id], ['privacy_policy', '隐私政策', 'public', 'draft', 1, pid]);
  assert.deepEqual(d.sections.map((s) => s.key), ['intro', 'collect', 'ai', 'cookies', 'sharing', 'sdks', 'storage', 'security', 'rights', 'updates', 'contact']);
  const intro = d.sections[0];
  assert.deepEqual([intro.rev, intro.origin, intro.mode, intro.title, intro.stale], [1, 'fixed', 'fixed', '引言与适用范围', false]);
  assert.deepEqual(intro.placeholders, ['材料生效日期']);
  const collect = d.sections[1];
  assert.deepEqual([collect.rev, collect.origin, collect.body, collect.stale], [0, null, '', false]);
  assert.deepEqual(listRevisions(db, d.id, 'intro').map((r) => [r.n, r.origin]), [[1, 'fixed']]);
  assert.equal(docProductId(db, d.id), pid);
  throwsCp(() => docProductId(db, 999), 404, /材料不存在/);
  throwsCp(() => getDoc(db, 999), 404);
  done();
});

test('生成、编辑、回退各加版本；baseRev 不符 409；超长与格式 400；差异方向为 版本→当前', () => {
  const { db, pid, done } = setup();
  const id = createDoc(db, pid, 'privacy_policy').id;
  const g = prepareGenerate(db, id, 'collect');
  assert.equal(g.chapter.key, 'collect');
  assert.equal(g.ctx.product.name, '写作 App');
  assert.match(g.hash, /^[0-9a-f]{64}$/);
  const s1 = writeGenerated(db, id, 'collect', '正文一', 'generate', g.hash, 11);
  assert.deepEqual([s1.rev, s1.origin, s1.body], [1, 'generate', '正文一']);
  throwsCp(() => saveSection(db, id, 'collect', 'x', 0), 409, /内容已在别处更新/);
  throwsCp(() => saveSection(db, id, 'collect', 'x', '1'), 400);
  throwsCp(() => saveSection(db, id, 'collect', 3, 1), 400);
  throwsCp(() => saveSection(db, id, 'nope', 'x', 1), 404, /章节不存在/);
  const s2 = saveSection(db, id, 'collect', '正文二', 1, 12);
  assert.deepEqual([s2.rev, s2.origin], [2, 'edit']);
  throwsCp(() => saveSection(db, id, 'collect', '字'.repeat(20001), 2), 400);
  const r = restoreSection(db, id, 'collect', 1, 13);
  assert.deepEqual([r.rev, r.body, r.origin], [3, '正文一', 'restore']);
  throwsCp(() => restoreSection(db, id, 'collect', 99), 404);
  throwsCp(() => restoreSection(db, id, 'collect', 'x'), 400);
  assert.deepEqual(listRevisions(db, id, 'collect').map((x) => [x.n, x.origin, x.chars]), [[3, 'restore', 3], [2, 'edit', 3], [1, 'generate', 3]]);
  const rv = getRevision(db, id, 'collect', 2);
  assert.deepEqual([rv.n, rv.body, rv.origin], [2, '正文二', 'edit']);
  assert.deepEqual(rv.diff.lines, [{ t: '-', s: '正文二' }, { t: '+', s: '正文一' }]);
  done();
});

test('版本上限 50：最早的被删，取已删版本 404', () => {
  const { db, pid, done } = setup();
  const id = createDoc(db, pid, 'privacy_policy').id;
  for (let i = 0; i < 55; i++) saveSection(db, id, 'collect', `v${i}`, sec(db, id, 'collect').rev);
  const list = listRevisions(db, id, 'collect');
  assert.equal(list.length, 50);
  assert.deepEqual([list[0].n, list[49].n], [55, 6]);
  throwsCp(() => getRevision(db, id, 'collect', 5), 404);
  assert.equal(getRevision(db, id, 'collect', 6).body, 'v5');
  done();
});

test('定稿：未生成 400 带 pending；有待填 400 带 placeholders；补全后通过；定稿锁定；取消定稿恢复', () => {
  const { db, pid, done } = setup();
  const id = createDoc(db, pid, 'privacy_policy').id;
  assert.throws(() => finalizeDoc(db, id), (e: unknown) => e instanceof CpError && e.status === 400 && e.message === '还有未生成的章节' && (e.detail?.pending as string[]).includes('collect'));
  genAll(db, id);
  assert.throws(() => finalizeDoc(db, id), (e: unknown) => {
    if (!(e instanceof CpError) || e.status !== 400 || e.message !== '还有待填内容') return false;
    const ph = e.detail?.placeholders as { key: string; title: string; fields: string[] }[];
    return ph.some((p) => p.key === 'storage' && p.title === '存储地点和保存期限' && p.fields.join() === '数据存放地,个人信息保存期限');
  });
  saveFacts(db, pid, FULL_FACTS);
  refreshFixed(db, id);
  const f = finalizeDoc(db, id, 50);
  assert.deepEqual([f.status, f.finalized_at], ['final', 50]);
  assert.equal(finalizeDoc(db, id, 60).finalized_at, 50);
  const rev = sec(db, id, 'collect').rev;
  const g = prepareGenerate;
  throwsCp(() => g(db, id, 'collect'), 409, /材料已定稿/);
  throwsCp(() => saveSection(db, id, 'collect', 'x', rev), 409, /材料已定稿/);
  throwsCp(() => restoreSection(db, id, 'collect', 1), 409);
  throwsCp(() => writeGenerated(db, id, 'collect', 'x', 'generate', 'h'), 409);
  throwsCp(() => deleteDoc(db, id), 409);
  const u = unfinalizeDoc(db, id);
  assert.deepEqual([u.status, u.finalized_at], ['draft', null]);
  assert.equal(saveSection(db, id, 'collect', '改', rev).rev, rev + 1);
  done();
});

test('等模型期间被定稿或删除：写入时 409 / 404', () => {
  const { db, pid, done } = setup();
  saveFacts(db, pid, FULL_FACTS);
  const id = createDoc(db, pid, 'privacy_policy').id;
  genAll(db, id);
  const g = prepareGenerate(db, id, 'collect');
  finalizeDoc(db, id);
  throwsCp(() => writeGenerated(db, id, 'collect', '新', 'generate', g.hash), 409);
  unfinalizeDoc(db, id);
  const g2 = prepareGenerate(db, id, 'collect');
  deleteDoc(db, id);
  throwsCp(() => writeGenerated(db, id, 'collect', '新', 'generate', g2.hash), 404);
  throwsCp(() => deleteDoc(db, id), 404);
  done();
});

test('资料变更后用到该字段的章 stale；未生成章不算 stale；重新生成后清除', () => {
  const { db, pid, done } = setup();
  const id = createDoc(db, pid, 'privacy_policy').id;
  assert.equal(sec(db, id, 'storage').stale, false);
  saveFacts(db, pid, { data_location: '北京' });
  assert.equal(sec(db, id, 'storage').stale, true);
  assert.equal(sec(db, id, 'rights').stale, false);
  assert.equal(sec(db, id, 'security').stale, false);
  refreshFixed(db, id);
  assert.equal(sec(db, id, 'storage').stale, false);
  writeGenerated(db, id, 'ai', '正文', 'generate', prepareGenerate(db, id, 'ai').hash);
  saveFacts(db, pid, { data_location: '北京', model_name: 'M' });
  assert.equal(sec(db, id, 'ai').stale, true);
  done();
});

test('条件章：改答后 removed，改回恢复且正文保留；只能删已移除章；删后再适用以 rev 0 补建', () => {
  const { db, pid, done } = setup();
  const id = createDoc(db, pid, 'privacy_policy').id;
  assert.ok(!getDoc(db, id).sections.some((s) => s.key === 'cross_border'));
  assessAndMerge(db, pid, writer({ cross_border: 'lt10w' }), []);
  const keys = getDoc(db, id).sections.map((s) => s.key);
  assert.equal(keys.indexOf('cross_border'), keys.indexOf('storage') + 1);
  writeGenerated(db, id, 'cross_border', '出境正文', 'generate', prepareGenerate(db, id, 'cross_border').hash);
  assessAndMerge(db, pid, writer(), []);
  const gone = sec(db, id, 'cross_border');
  assert.deepEqual([gone.removed, gone.body, gone.rev], [true, '出境正文', 1]);
  assert.equal(getDoc(db, id).sections.at(-1)!.key, 'cross_border');
  throwsCp(() => prepareGenerate(db, id, 'cross_border'), 409, /章节已从模板移除/);
  throwsCp(() => deleteSection(db, id, 'collect'), 400, /只能删除模板已移除的章节/);
  assessAndMerge(db, pid, writer({ cross_border: 'lt10w' }), []);
  const back = sec(db, id, 'cross_border');
  assert.deepEqual([back.removed, back.body, back.rev], [false, '出境正文', 1]);
  assessAndMerge(db, pid, writer(), []);
  getDoc(db, id);
  deleteSection(db, id, 'cross_border');
  assert.ok(!getDoc(db, id).sections.some((s) => s.key === 'cross_border'));
  assessAndMerge(db, pid, writer({ cross_border: 'lt10w' }), []);
  assert.deepEqual([sec(db, id, 'cross_border').rev, sec(db, id, 'cross_border').body], [0, '']);
  done();
});

test('删产品级联清空材料、章、版本', () => {
  const { db, pid, done } = setup();
  createDoc(db, pid, 'privacy_policy');
  createDoc(db, pid, 'terms');
  deleteProduct(db, pid);
  for (const t of ['cp_docs', 'cp_doc_sections', 'cp_doc_revisions']) assert.equal((db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n, 0, t);
  done();
});

test('listDocs：可起草与原因；待填、需更新、未生成计数', () => {
  const { db, pid, bare, done } = setup();
  const id = createDoc(db, pid, 'privacy_policy').id;
  const cards = listDocs(db, pid);
  assert.equal(cards.length, 10);
  const pp = cards.find((c) => c.kind === 'privacy_policy')!;
  assert.deepEqual([pp.available, pp.reason, pp.name, pp.usage], [true, null, '隐私政策', 'public']);
  assert.deepEqual(pp.doc, { id, status: 'draft', placeholders: 4, stale: 0, pending: 5 });
  const sr = cards.find((c) => c.kind === 'security_report')!;
  assert.deepEqual([sr.available, sr.reason, sr.doc, sr.items], [false, '当前判定不需要这份材料', null, ['security_assess']]);
  assert.ok(listDocs(db, bare).every((c) => !c.available && c.reason === '请先完成问卷判定'));
  throwsCp(() => listDocs(db, 999), 404);
  done();
});
