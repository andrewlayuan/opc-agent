import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';
import { docHtml, docMarkdown, exportDoc, exportFileName, parseFormat } from './docs-export.ts';
import { createDoc, finalizeDoc, getDoc, prepareGenerate, saveSection, writeGenerated } from './docs-store.ts';
import { ENTITY_FIELDS, saveEntity, saveFacts } from './facts.ts';
import type { Answers } from './rules.ts';
import { CpError, assessAndMerge, createProduct } from './store.ts';

const writer = (o: Answers = {}): Answers => ({
  forms: ['app'], audience: 'public', overseas: 'no', charge: ['paid'], ai_use: 'cn_api', ai_output: 'raw', ai_media: ['text'], algo: 'no',
  social: ['none'], companion: 'no', scale: 'prelaunch', pi: ['general'], minors: 'no', cross_border: 'no', ...o,
});
const DAY = Date.UTC(2026, 10, 20, 1);

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-cpx-'));
  const db = openDb(path.join(dir, 't.db'));
  const pid = createProduct(db, { name: 'a/b', description: '写作' });
  assessAndMerge(db, pid, writer({ cross_border: 'lt10w' }), []);
  const id = createDoc(db, pid, 'privacy_policy').id;
  writeGenerated(db, id, 'cross_border', '出境正文', 'generate', prepareGenerate(db, id, 'cross_border').hash);
  assessAndMerge(db, pid, writer(), []);
  return { db, pid, id, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}
const rev = (db: DB, id: number, key: string) => getDoc(db, id).sections.find((s) => s.key === key)!.rev;
function complete(db: DB, pid: number, id: number) {
  saveEntity(db, Object.fromEntries(ENTITY_FIELDS.map((f) => [f.key, f.key === 'credit_code' ? '91110108MA01ABCD2X' : f.key === 'contact_email' ? 'a@b.cn' : `E${f.key}`])));
  saveFacts(db, pid, { effective_date: '2026-12-01', data_location: '北京', retention: '一年', sdks: [] });
  for (const s of getDoc(db, id).sections) {
    if (s.removed) continue;
    const g = prepareGenerate(db, id, s.key);
    writeGenerated(db, id, s.key, s.mode === 'fixed' ? g.chapter.render!(g.ctx) : `${s.title}正文`, s.mode === 'fixed' ? 'fixed' : 'generate', g.hash);
  }
}

test('docMarkdown：抬头、草稿提示、中文序号、跳过已移除章、末尾声明', () => {
  const { db, id, done } = setup();
  const md = docMarkdown(db, id, DAY);
  assert.ok(md.startsWith('# 隐私政策\n'));
  assert.ok(md.includes('产品：a/b　主体：【待填：公司全称】　日期：2026-11-20'));
  assert.ok(md.includes('草稿（未定稿），仅供参考，以属地主管部门口径为准'));
  assert.ok(md.includes('## 一、引言与适用范围\n'));
  assert.ok(md.includes('## 二、我们收集和使用的个人信息\n'));
  assert.ok(md.includes('## 十一、联系我们\n'));
  assert.ok(!md.includes('个人信息出境') && !md.includes('出境正文'));
  assert.ok(md.trimEnd().endsWith('---\n\n本材料由 AI 辅助起草，提交或公示前请由专业人士审核'));
  done();
});

test('docHtml：单文件无外部资源；占位 mark；资料与正文全部转义', () => {
  const { db, pid, id, done } = setup();
  saveEntity(db, { company_name: '<script>alert(1)</script>' });
  saveFacts(db, pid, { public_name: '<img src=x onerror=alert(2)>' });
  saveSection(db, id, 'collect', '<img src=x onerror=alert(1)>\n\n联系 【待填：联系邮箱】', rev(db, id, 'collect'));
  const html = docHtml(db, id, DAY);
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<meta charset="utf-8">') && html.includes('<style>'));
  assert.ok(!/<(script|img|link|iframe|a)\b/i.test(html));
  assert.ok(!/<[^>]+\s(src|href|on\w+)=/i.test(html));
  assert.ok(html.includes('&lt;script&gt;') && html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('<mark style="background:#ffeb3b">【待填：联系邮箱】</mark>'));
  assert.ok(html.includes('<h2>一、引言与适用范围</h2>'));
  assert.ok(html.includes('草稿（未定稿）'));
  done();
});

test('exportDoc：各格式类型与文件名；docx 交给 convert；定稿后无草稿提示；parseFormat', async () => {
  const { db, pid, id, done } = setup();
  let got = '';
  const r = await exportDoc(db, id, 'docx', { convert: async (h) => ((got = h), Buffer.from('DOCX')), now: DAY });
  assert.deepEqual([r.name, r.body.toString(), r.type], ['a b-隐私政策-20261120.docx', 'DOCX', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
  assert.ok(got.includes('<mark'));
  const md = await exportDoc(db, id, 'md', { now: DAY });
  assert.deepEqual([md.name, md.type], ['a b-隐私政策-20261120.md', 'text/markdown; charset=utf-8']);
  assert.equal(md.body.toString('utf8'), docMarkdown(db, id, DAY));
  assert.equal((await exportDoc(db, id, 'html', { now: DAY })).type, 'text/html; charset=utf-8');
  complete(db, pid, id);
  finalizeDoc(db, id);
  assert.ok(!docMarkdown(db, id, DAY).includes('草稿'));
  assert.ok(docMarkdown(db, id, DAY).includes('产品：a/b　主体：Ecompany_name'));
  assert.equal(exportFileName('x', '隐私政策', Date.UTC(2026, 10, 19, 16, 30), 'md'), 'x-隐私政策-20261120.md');
  assert.equal(parseFormat('md'), 'md');
  for (const bad of ['pdf', null, '']) assert.throws(() => parseFormat(bad), (e: unknown) => e instanceof CpError && e.status === 400 && e.message === '导出格式不对');
  done();
});
