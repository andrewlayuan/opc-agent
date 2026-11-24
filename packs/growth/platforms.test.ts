import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import { GrowthError } from './types.ts';
import { PLATFORMS, cps, getPlatform, lengthNotes, missingPaths, renderCopy, setTextAt, textAt, textPaths, validateFields } from './platforms.ts';

const statusOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof GrowthError) return { status: e.status, message: e.message };
    throw e;
  }
  return null;
};

test('迁移 13：运营表存在，user_version=13', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-gr-'));
  const db = openDb(path.join(dir, 't.db'));
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'gr_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  assert.deepEqual(names, ['gr_campaigns', 'gr_copies', 'gr_revisions']);
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 16);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getPlatform：四个平台按顺序，未知平台 400', () => {
  assert.deepEqual(PLATFORMS.map((p) => p.id), ['xhs', 'wechat', 'video', 'landing']);
  assert.equal(getPlatform('wechat').name, '微信公众号');
  assert.deepEqual(statusOf(() => getPlatform('x')), { status: 400, message: '不支持的平台' });
  assert.deepEqual(statusOf(() => getPlatform(undefined)), { status: 400, message: '不支持的平台' });
});

test('cps 按码点计数并去首尾空白，emoji 算 1', () => {
  assert.equal(cps(' 好用😀 '), 3);
  assert.equal(cps(''), 0);
});

test('textPaths / textAt / setTextAt：嵌套路径，不改原对象', () => {
  const f = { hook: 'h', shots: [{ scene: 's', line: 'l' }], cta: 'c' };
  assert.deepEqual(textPaths(getPlatform('video'), f), ['hook', 'shots.0.scene', 'shots.0.line', 'cta']);
  assert.deepEqual(textPaths(getPlatform('xhs'), { title: 't', body: 'b', tags: ['a', 'b'] }), ['title', 'body', 'tags.0', 'tags.1']);
  const g = setTextAt(f, 'shots.0.line', 'x');
  assert.equal(textAt(g, 'shots.0.line'), 'x');
  assert.equal(f.shots[0].line, 'l');
  assert.equal(textAt(f, 'shots.3.line'), null);
  assert.equal(textAt(f, 'nope'), null);
  assert.equal(textAt(setTextAt({ title: 't', body: 'b', tags: ['a', 'b'] }, 'tags.1', 'z'), 'tags.1'), 'z');
});

test('validateFields：补缺、去 #、去重截数组、超倍数报字段过长、非对象报错', () => {
  const p = getPlatform('xhs');
  const f = validateFields(p, { title: ' t ', tags: ['#a', 'a', ...'bcdefghij'] }, 3);
  assert.equal(f.title, 't');
  assert.equal(f.body, '');
  assert.deepEqual(f.tags, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.deepEqual(statusOf(() => validateFields(p, { title: 'x'.repeat(61), body: '', tags: [] }, 3)), { status: 400, message: '字段过长：title' });
  assert.equal(validateFields(p, { title: 'x'.repeat(60) }, 3).title, 'x'.repeat(60));
  const v = validateFields(getPlatform('video'), { hook: 1, shots: [{ scene: 's' }, 'bad'], cta: null }, 3);
  assert.deepEqual(v, { hook: '', shots: [{ scene: 's', line: '' }, { scene: '', line: '' }], cta: '' });
  assert.deepEqual(statusOf(() => validateFields(p, 'nope', 3)), { status: 400, message: '文案格式不对' });
  assert.deepEqual(statusOf(() => validateFields(getPlatform('landing'), { points: [{ title: '一'.repeat(37), desc: '' }] }, 3)), { status: 400, message: '字段过长：points.0.title' });
});

test('lengthNotes：标题超限、标签不足、口播合计、条数超出', () => {
  const xhs = lengthNotes(getPlatform('xhs'), { title: '一'.repeat(23), body: '正'.repeat(300), tags: ['a', 'b'] });
  assert.deepEqual(xhs, [
    { path: 'title', text: '标题 23 字，超过 20 字' },
    { path: 'tags', text: '话题标签 2 个，少于 3 个' },
  ]);
  assert.deepEqual(lengthNotes(getPlatform('xhs'), { title: '好', body: '短', tags: ['a', 'b', 'c'] }), [{ path: 'body', text: '正文 1 字，少于 300 字' }]);
  const video = lengthNotes(getPlatform('video'), { hook: '钩', shots: [], cta: '买' }).map((n) => n.text);
  assert.ok(video.includes('分镜 0 段，少于 4 段'));
  assert.ok(video.includes('口播合计 2 字，少于 240 字'));
  const land = lengthNotes(getPlatform('landing'), { slogan: 's', subtitle: 's', points: [{ title: '一'.repeat(13), desc: 'd' }, { title: 't', desc: 'd' }, { title: 't', desc: 'd' }], store_desc: 'x' });
  assert.deepEqual(land, [{ path: 'points.0.title', text: '卖点 1 标题 13 字，超过 12 字' }]);
});

test('missingPaths：空字段与空数组；条数不足只在 lengthNotes 里提示，不算缺失', () => {
  assert.deepEqual(missingPaths(getPlatform('xhs'), { title: '', body: 'b', tags: [] }), ['title', 'tags']);
  assert.deepEqual(missingPaths(getPlatform('landing'), { slogan: 's', subtitle: 's', points: [{ title: 't', desc: '' }, { title: 't', desc: 'd' }, { title: 't', desc: 'd' }], store_desc: 'x' }), ['points.0.desc']);
  assert.deepEqual(missingPaths(getPlatform('landing'), { slogan: 's', subtitle: 's', points: [{ title: 't', desc: 'd' }], store_desc: 'x' }), []);
});

test('renderCopy：四个平台格式', () => {
  assert.equal(renderCopy(getPlatform('xhs'), { title: '标题', body: '正文', tags: ['效率', 'AI'] }), '### 标题\n\n正文\n\n#效率 #AI');
  assert.equal(renderCopy(getPlatform('wechat'), { title: '标题', digest: '摘要', body: '## 一\n内容' }), '### 标题\n\n> 摘要\n\n## 一\n内容');
  assert.equal(
    renderCopy(getPlatform('video'), { hook: '你还在手写周报？', shots: [{ scene: '办公室', line: '每周五' }, { scene: '屏幕', line: '一键生成' }], cta: '点主页试用' }),
    '**开头 3 秒**：你还在手写周报？\n\n1. 画面：办公室／口播：每周五\n2. 画面：屏幕／口播：一键生成\n\n**结尾**：点主页试用',
  );
  assert.equal(
    renderCopy(getPlatform('landing'), { slogan: '标语', subtitle: '副标题', points: [{ title: '快', desc: '一分钟' }], store_desc: '简介' }),
    '### 标语\n\n副标题\n\n- **快**：一分钟\n\n**商店简介**：简介',
  );
});
