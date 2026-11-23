import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';
import { assessAndMerge, createProduct, deleteProduct } from '../compliance/store.ts';
import type { Answers } from '../compliance/rules.ts';
import { NO_CTX } from './checker.ts';
import type { Fields } from './platforms.ts';
import {
  addCopy, contextFor, copyCampaign, createCampaign, deleteCampaign, deleteCopy, finalizeCopy, getCampaign, getCopy, getRevision,
  inputHash, keepHit, listCampaigns, listRevisions, replaceHits, restoreRevision, saveCopy, saveReview, unfinalizeCopy, updateCampaign, writeRevision,
} from './store.ts';
import { GrowthError } from './types.ts';

function setup(): { db: DB; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-gr-'));
  const db = openDb(path.join(dir, 't.db'));
  return { db, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}
const statusOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof GrowthError) return { status: e.status, message: e.message };
    throw e;
  }
  return null;
};
const C = { name: 'v1.2 上线', product_name: '周报助手', product_desc: '自动生成周报', points: ['接 GitHub', '一键导出'], audience: '研发负责人', offer: '', tone: 'warm' };
const XHS = (body: string, title = '标题'): Fields => ({ title, body, tags: ['效率', '周报', 'AI'] });
const answers: Answers = {
  forms: ['app'], audience: 'public', overseas: 'no', charge: ['paid'], ai_use: 'cn_api', ai_output: 'raw', ai_media: ['text'], algo: 'no',
  social: ['none'], companion: 'no', scale: 'prelaunch', pi: ['general'], minors: 'maybe', cross_border: 'no',
};
const copyOf = (db: DB, cid: number, platform: string) => getCampaign(db, cid).copies.find((c) => c.platform === platform)!;

test('投放：校验、平台按顺序建空文案、合规上下文、产品删除后置空', () => {
  const { db, done } = setup();
  assert.deepEqual(statusOf(() => createCampaign(db, { ...C, points: [' ', ''] }, ['xhs'])), { status: 400, message: '请至少填写一条卖点' });
  assert.deepEqual(statusOf(() => createCampaign(db, { ...C, product_name: '' }, ['xhs'])), { status: 400, message: '请填写产品名' });
  assert.deepEqual(statusOf(() => createCampaign(db, C, [])), { status: 400, message: '至少选择一个平台' });
  assert.deepEqual(statusOf(() => createCampaign(db, C, ['xhs', 'tw'])), { status: 400, message: '不支持的平台' });
  assert.deepEqual(statusOf(() => createCampaign(db, { ...C, tone: 'x' }, ['xhs'])), { status: 400, message: '语气不对' });
  assert.deepEqual(statusOf(() => createCampaign(db, { ...C, product_id: 999 }, ['xhs'])), { status: 400, message: '关联的合规产品不存在' });
  assert.deepEqual(statusOf(() => createCampaign(db, { ...C, points: Array(11).fill('x') }, ['xhs'])), { status: 400, message: '卖点需在 1–10 条之间' });
  assert.deepEqual(statusOf(() => createCampaign(db, { ...C, name: 'x'.repeat(61) }, ['xhs'])), { status: 400, message: '投放名称需在 1–60 字之间' });
  const pid = createProduct(db, { name: '周报助手', description: 'd' });
  const id0 = createCampaign(db, { ...C, product_id: pid }, ['xhs']);
  assert.deepEqual(getCampaign(db, id0).ctx, NO_CTX, '未判定的产品：上下文全假');
  assessAndMerge(db, pid, answers, []);
  const id = createCampaign(db, { ...C, product_id: pid, points: [' 接 GitHub ', '', '一键导出'] }, ['landing', 'xhs', 'xhs']);
  const v = getCampaign(db, id);
  assert.deepEqual(v.points, ['接 GitHub', '一键导出']);
  assert.deepEqual(v.copies.map((c) => [c.platform, c.rev, c.status]), [['xhs', 0, 'draft'], ['landing', 0, 'draft']]);
  assert.deepEqual(v.ctx, { minors: true, ai: true, paid: true });
  assert.deepEqual(contextFor(db, pid), v.ctx);
  assert.deepEqual(contextFor(db, 12345), NO_CTX);
  deleteProduct(db, pid);
  assert.equal(getCampaign(db, id).product_id, null);
  assert.deepEqual(getCampaign(db, id).ctx, NO_CTX);
  assert.deepEqual(statusOf(() => getCampaign(db, 999)), { status: 404, message: '投放不存在' });
  done();
});

test('补加平台与删除：重复 409，删除投放连带文案', () => {
  const { db, done } = setup();
  const id = createCampaign(db, C, ['xhs']);
  assert.equal(addCopy(db, id, 'video').platform, 'video');
  assert.deepEqual(statusOf(() => addCopy(db, id, 'xhs')), { status: 409, message: '该平台的文案已存在' });
  assert.deepEqual(statusOf(() => addCopy(db, 999, 'xhs')), { status: 404, message: '投放不存在' });
  const vid = copyOf(db, id, 'video').id;
  deleteCopy(db, vid);
  assert.deepEqual(statusOf(() => getCopy(db, vid)), { status: 404, message: '文案不存在' });
  const xid = copyOf(db, id, 'xhs').id;
  writeRevision(db, xid, XHS('正文'), 'generate', {});
  deleteCampaign(db, id);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM gr_revisions').get() as { n: number }).n, 0);
  assert.deepEqual(statusOf(() => deleteCampaign(db, id)), { status: 404, message: '投放不存在' });
  done();
});

test('版本：生成写入、stale、冲突、未变化不写、定稿 409、删除 404、上限 50', () => {
  const { db, done } = setup();
  const id = createCampaign(db, C, ['xhs']);
  const cid = copyOf(db, id, 'xhs').id;
  const c1 = writeRevision(db, cid, XHS('正文'), 'generate', { genHash: inputHash(getCampaign(db, id)) });
  assert.deepEqual([c1.rev, c1.origin, c1.stale], [1, 'generate', false]);
  updateCampaign(db, id, { ...C, points: ['新卖点'] });
  assert.equal(getCopy(db, cid).stale, true);
  assert.equal(copyCampaign(db, cid).campaign.points[0], '新卖点');
  assert.deepEqual(statusOf(() => saveCopy(db, cid, XHS('改'), 0)), { status: 409, message: '内容已在别处更新，请刷新' });
  assert.deepEqual(statusOf(() => saveCopy(db, cid, XHS('改'), 'x')), { status: 400, message: '版本号不对' });
  assert.equal(saveCopy(db, cid, XHS('正文'), 1).rev, 1, '内容未变化不写新版本');
  const c2 = saveCopy(db, cid, XHS('改'), 1);
  assert.deepEqual([c2.rev, c2.origin], [2, 'edit']);
  assert.deepEqual(statusOf(() => saveCopy(db, cid, { title: 'x'.repeat(61) }, 2)), { status: 400, message: '字段过长：title' });
  finalizeCopy(db, cid);
  assert.deepEqual(statusOf(() => writeRevision(db, cid, XHS('x'), 'generate', {})), { status: 409, message: '文案已定稿，先取消定稿' });
  assert.deepEqual(statusOf(() => saveCopy(db, cid, XHS('x'), 2)), { status: 409, message: '文案已定稿，先取消定稿' });
  unfinalizeCopy(db, cid);
  for (let i = 0; i < 53; i++) writeRevision(db, cid, XHS(`第 ${i} 版`), 'edit', {});
  const revs = listRevisions(db, cid);
  assert.equal(revs.length, 50);
  assert.equal(revs[0].n, 55);
  assert.equal(revs.at(-1)!.n, 6);
  deleteCopy(db, cid);
  assert.deepEqual(statusOf(() => writeRevision(db, cid, XHS('x'), 'generate', {})), { status: 404, message: '文案不存在' });
  done();
});

test('替换：同字段多处从后往前、emoji 偏移、key 找不到或版本旧 409', () => {
  const { db, done } = setup();
  const id = createCampaign(db, C, ['xhs']);
  const cid = copyOf(db, id, 'xhs').id;
  const c = writeRevision(db, cid, XHS('😀第一，第一', '最好用'), 'generate', {});
  const keys = c.check.hits.map((h) => h.key);
  assert.deepEqual(keys, ['superlative:title:最好:0', 'superlative:body:第一:0', 'superlative:body:第一:1']);
  const r = replaceHits(db, cid, 1, keys.map((key, i) => ({ key, with: i ? '受欢迎' : '很好' })));
  assert.equal(r.rev, 2);
  assert.equal(r.origin, 'replace');
  assert.deepEqual([r.fields.title, r.fields.body], ['很好用', '😀受欢迎，受欢迎']);
  assert.equal(r.check.mustOpen, 0);
  assert.deepEqual(statusOf(() => replaceHits(db, cid, 1, [{ key: keys[0], with: 'x' }])), { status: 409, message: '内容已在别处更新，请刷新' });
  assert.deepEqual(statusOf(() => replaceHits(db, cid, 2, [{ key: keys[0], with: 'x' }])), { status: 409, message: '内容已在别处更新，请刷新' });
  assert.deepEqual(statusOf(() => replaceHits(db, cid, 2, [])), { status: 400, message: '替换内容不对' });
  done();
});

test('保留：跨版本延续，命中消失后清理；理由长度 400；命中不存在 409', () => {
  const { db, done } = setup();
  const id = createCampaign(db, C, ['xhs']);
  const cid = copyOf(db, id, 'xhs').id;
  writeRevision(db, cid, XHS('100% 开源，第一'), 'generate', {});
  const key = 'absolute:body:100%:0';
  assert.deepEqual(statusOf(() => keepHit(db, cid, key, '')), null, '取消一个不存在的保留不报错');
  assert.deepEqual(statusOf(() => keepHit(db, cid, key, 'x'.repeat(201))), { status: 400, message: '保留理由需在 1–200 字之间' });
  assert.deepEqual(statusOf(() => keepHit(db, cid, 'absolute:body:永久:0', '理由')), { status: 409, message: '内容已在别处更新，请刷新' });
  const k = keepHit(db, cid, key, ' 代码确实全部开源 ');
  assert.deepEqual(k.check.hits.find((h) => h.key === key)!.kept?.reason, '代码确实全部开源');
  assert.equal(k.check.mustOpen, 1);
  const e = saveCopy(db, cid, XHS('100% 开源，第一', '新标题'), 1);
  assert.equal(e.check.hits.find((h) => h.key === key)!.kept?.reason, '代码确实全部开源', '改别的字段后仍保留');
  saveCopy(db, cid, XHS('开源，第一'), 2);
  const row = db.prepare('SELECT kept FROM gr_copies WHERE id = ?').get(cid) as { kept: string };
  assert.deepEqual(JSON.parse(row.kept), {}, '命中消失后清理');
  done();
});

test('保留按前后文对到新命中：替换前一处后仍保留；前面插入同词不继承；数组下标前移后仍保留', () => {
  const { db, done } = setup();
  const id = createCampaign(db, C, ['xhs']);
  const cid = copyOf(db, id, 'xhs').id;
  writeRevision(db, cid, { title: '标题', body: 'A 方案最好用。B 方案也最好看。', tags: ['效率', '周报', '行业第一'] }, 'generate', {});
  keepHit(db, cid, 'superlative:body:最好:1', '引用用户原话');
  keepHit(db, cid, 'superlative:tags.2:第一:0', '榜单名称');
  const kept = (v: ReturnType<typeof getCopy>) => v.check.hits.map((h) => [h.path, h.key.split(':').at(-1), h.kept?.reason ?? null]);
  const r = replaceHits(db, cid, 1, [{ key: 'superlative:body:最好:0', with: '很好' }]);
  assert.equal(r.fields.body, 'A 方案很好用。B 方案也最好看。');
  assert.deepEqual(kept(r), [['body', '0', '引用用户原话'], ['tags.2', '0', '榜单名称']], '前一处被替换后，原来保留的那处换成新序号仍保留');
  const e = saveCopy(db, cid, { title: '标题', body: '最好的开始。A 方案很好用。B 方案也最好看。', tags: ['周报', '行业第一'] }, 2);
  assert.deepEqual(kept(e), [['body', '0', null], ['body', '1', '引用用户原话'], ['tags.1', '0', '榜单名称']], '前面新插入的同词不继承；标签前移后仍保留');
  assert.equal(e.check.mustOpen, 1);
  done();
});

test('替换：同一个 key 提交两次 400，不改坏文本', () => {
  const { db, done } = setup();
  const id = createCampaign(db, C, ['xhs']);
  const cid = copyOf(db, id, 'xhs').id;
  writeRevision(db, cid, XHS('正文', '最好用的'), 'generate', {});
  const key = 'superlative:title:最好:0';
  assert.deepEqual(statusOf(() => replaceHits(db, cid, 1, [{ key, with: 'A' }, { key, with: 'BBB' }])), { status: 400, message: '替换内容不对' });
  assert.equal(getCopy(db, cid).rev, 1);
  done();
});

test('定稿：未保留必须改与空字段拦截并带 issues；保留后可定稿；定稿后保留 409；取消定稿', () => {
  const { db, done } = setup();
  const id = createCampaign(db, C, ['xhs', 'landing']);
  const lid = copyOf(db, id, 'landing').id;
  const e0 = (() => {
    try {
      finalizeCopy(db, lid);
    } catch (e) {
      return e as GrowthError;
    }
  })()!;
  assert.deepEqual([e0.status, e0.message, e0.issues], [400, '还有必须修改的问题', [{ path: '', text: '还没有生成或填写文案', label: '未生成' }]]);
  writeRevision(db, lid, { slogan: '最好用的周报', subtitle: '', points: [{ title: '快', desc: '' }, { title: '准', desc: 'd' }, { title: '省', desc: 'd' }], store_desc: '简介' }, 'generate', {});
  const err = (() => {
    try {
      finalizeCopy(db, lid);
    } catch (e) {
      return e as GrowthError;
    }
  })()!;
  assert.deepEqual(err.issues, [
    { path: 'subtitle', text: '未填写', label: '副标题' },
    { path: 'points.0.desc', text: '未填写', label: '卖点 1 说明' },
    { path: 'slogan', text: '最好', label: '极限用语' },
  ]);
  saveCopy(db, lid, { slogan: '最好用的周报', subtitle: '副', points: [{ title: '快', desc: 'd' }, { title: '准', desc: 'd' }, { title: '省', desc: 'd' }], store_desc: '简介' }, 1);
  keepHit(db, lid, 'superlative:slogan:最好:0', '用户调研第一名');
  const f = finalizeCopy(db, lid);
  assert.equal(f.status, 'final');
  assert.deepEqual(statusOf(() => keepHit(db, lid, 'superlative:slogan:最好:0', '')), { status: 409, message: '文案已定稿，先取消定稿' });
  assert.deepEqual(statusOf(() => restoreRevision(db, lid, 1)), { status: 409, message: '文案已定稿，先取消定稿' });
  assert.deepEqual(listCampaigns(db)[0].copies, [{ platform: 'xhs', state: 'empty' }, { platform: 'landing', state: 'final' }]);
  assert.equal(unfinalizeCopy(db, lid).status, 'draft');
  done();
});

test('复核：写到指定版本；手改与替换继承仍在原文中的条目；生成不继承；新版本在后时同步', () => {
  const { db, done } = setup();
  const id = createCampaign(db, C, ['xhs']);
  const cid = copyOf(db, id, 'xhs').id;
  writeRevision(db, cid, XHS('用了就不焦虑。每天都很轻松。'), 'generate', {});
  saveReview(db, cid, 1, [
    { quote: '用了就不焦虑', issue: '制造焦虑', suggestion: '改为…' },
    { quote: '每天都很轻松', issue: '绝对化', suggestion: '改为…' },
  ], 100);
  const c1 = getCopy(db, cid);
  assert.deepEqual([c1.review?.length, c1.review_base, c1.reviewed_at], [2, 1, 100]);
  const c2 = saveCopy(db, cid, XHS('用了就不焦虑。'), 1);
  assert.deepEqual([c2.review?.map((r) => r.quote), c2.review_base], [['用了就不焦虑'], 1]);
  const c3 = writeRevision(db, cid, XHS('全新内容'), 'generate', {});
  assert.equal(c3.review, null);
  saveCopy(db, cid, XHS('全新内容，用了就不焦虑。'), 3);
  saveReview(db, cid, 3, [{ quote: '全新内容', issue: 'i', suggestion: 's' }], 200);
  const c4 = getCopy(db, cid);
  assert.deepEqual([c4.rev, c4.review?.map((r) => r.quote), c4.review_base], [4, ['全新内容'], 3], '复核期间有新版本：同步到当前版本');
  assert.equal(listRevisions(db, cid).find((r) => r.n === 3)!.reviewed, true);
  done();
});

test('历史与回退：diff 基于渲染文本；回退写 restore；版本不存在 404', () => {
  const { db, done } = setup();
  const id = createCampaign(db, C, ['xhs']);
  const cid = copyOf(db, id, 'xhs').id;
  writeRevision(db, cid, XHS('旧正文'), 'generate', {});
  saveCopy(db, cid, XHS('新正文'), 1);
  const r = getRevision(db, cid, 1, true);
  assert.equal(r.revision.text, '### 标题\n\n旧正文\n\n#效率 #周报 #AI');
  assert.deepEqual(r.diff!.lines.filter((l) => l.t !== ' '), [{ t: '-', s: '旧正文' }, { t: '+', s: '新正文' }]);
  assert.equal(getRevision(db, cid, 1, false).diff, undefined);
  assert.deepEqual(statusOf(() => getRevision(db, cid, 9, false)), { status: 404, message: '版本不存在' });
  const back = restoreRevision(db, cid, 1);
  assert.deepEqual([back.rev, back.origin, back.fields.body], [3, 'restore', '旧正文']);
  assert.deepEqual(statusOf(() => restoreRevision(db, cid, 9)), { status: 404, message: '版本不存在' });
  assert.deepEqual(listRevisions(db, cid).map((x) => [x.n, x.origin]), [[3, 'restore'], [2, 'edit'], [1, 'generate']]);
  done();
});

test('列表：按更新时间倒序，平台状态', () => {
  const { db, done } = setup();
  const a = createCampaign(db, { ...C, name: 'A' }, ['xhs', 'wechat'], 1);
  createCampaign(db, { ...C, name: 'B' }, ['video'], 2);
  writeRevision(db, copyOf(db, a, 'xhs').id, XHS('限时免费'), 'generate', {}, 3);
  writeRevision(db, copyOf(db, a, 'wechat').id, { title: '标题', digest: '摘要', body: '正文' }, 'generate', {}, 4);
  const l = listCampaigns(db);
  assert.deepEqual(l.map((c) => c.name), ['A', 'B']);
  assert.deepEqual(l[0].copies, [{ platform: 'xhs', state: 'warn' }, { platform: 'wechat', state: 'ok' }]);
  done();
});
