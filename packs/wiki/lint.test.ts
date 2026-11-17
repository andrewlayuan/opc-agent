import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DB } from '../../packages/core/db.ts';
import { LlmError } from '../../packages/core/llm.ts';
import { deleteDoc } from '../kb/docs.ts';
import { lintChecks, runLint } from './lint.ts';
import { revertOp } from './revert.ts';
import { createOp, finishOp, getOp, getPage, tx, writePages } from './store.ts';
import type { PageDraft } from './store.ts';
import { seedDoc, stubLlm, tmpWikiDb } from './testutil.ts';

const put = (db: DB, drafts: PageDraft[]) =>
  tx(db, () => {
    const id = createOp(db, 'edit', { status: 'running' });
    finishOp(db, id, { status: 'done', pages: writePages(db, id, drafts).changes });
  });
const pg = (slug: string, title: string, body: string, kind: PageDraft['kind'] = 'concept'): PageDraft => ({ slug, kind, title, summary: '', body });

test('lintChecks：六类程序问题都能识别', () => {
  const { db, done } = tmpWikiDb();
  const a = seedDoc(db, '资料A', '## 一\n内容A');
  const b = seedDoc(db, '资料B', '## 一\n内容B');
  const c = seedDoc(db, '资料C', '## 一\n内容C');
  put(db, [
    pg('alpha', 'Alpha', `见 [[beta]] 与 [[ghost]][^${a}:0]`),
    pg('beta', 'Beta', `这里提到 Alpha 但没有链接[^${a}:0]`),
    pg('gamma', 'Gamma', '没有任何出处 [[beta]]'),
    pg('delta', 'Delta', `依据 B[^${b}:0] [[beta]]`),
    pg('eps', 'Epsilon', `依据 C[^${c}:0] [[beta]]`),
  ]);
  db.prepare('UPDATE kb_docs SET updated_at = ? WHERE id = ?').run(Date.now() + 86_400_000, b);
  deleteDoc(db, c);
  const issues = lintChecks(db);
  const has = (type: string, key: string) => issues.some((i) => i.type === type && (i.slug === key || i.target === key));
  assert.ok(has('orphan', 'alpha'), '孤立页');
  assert.ok(has('missing', 'ghost'), '缺页');
  assert.equal(issues.find((i) => i.type === 'missing')!.refs, 1);
  assert.ok(has('broken_cite', 'eps'), '依据失效');
  assert.ok(has('stale', 'delta'), '页面过时');
  assert.ok(has('no_cite', 'gamma'), '无依据');
  assert.ok(has('missing_link', 'beta'), '缺少链接');
  assert.equal(issues.find((i) => i.type === 'missing_link')!.target, 'alpha');
  assert.ok(!has('orphan', 'beta'));
  done();
});

test('runLint：自动修复生成可撤销的 fix 操作；只给标题第一次出现处加链接；删除失效引用', async () => {
  const { db, done } = tmpWikiDb();
  const c = seedDoc(db, '资料C', '## 一\n内容C');
  put(db, [pg('alpha', 'Alpha', '定义'), pg('beta', 'Beta', `Alpha 很重要，Alpha 也很常见。`), pg('eps', 'Epsilon', `依据[^${c}:0]`)]);
  deleteDoc(db, c);
  const op = createOp(db, 'lint', { status: 'running' });
  await runLint(db, stubLlm([JSON.stringify({ conflicts: [] }), JSON.stringify({ gaps: [] })]), op, { maxCalls: 2 });
  const note = JSON.parse(getOp(db, op)!.note) as { fixOp: number; issues: { type: string; fixed?: boolean }[] };
  assert.ok(note.fixOp > 0);
  assert.equal(getPage(db, 'beta')!.body, '[[alpha|Alpha]] 很重要，Alpha 也很常见。');
  assert.equal(getPage(db, 'eps')!.body, '依据');
  assert.ok(note.issues.filter((i) => i.type === 'missing_link' || i.type === 'broken_cite').every((i) => i.fixed));
  assert.equal(getOp(db, op)!.status, 'done');
  revertOp(db, note.fixOp);
  assert.equal(getPage(db, 'beta')!.body, 'Alpha 很重要，Alpha 也很常见。');
  done();
});

test('runLint：矛盾检查不超过 maxCalls，模型报出的矛盾写入 issues', async () => {
  const { db, done } = tmpWikiDb();
  const pages = Array.from({ length: 12 }, (_, i) => pg(`p${i}`, `页面${i}`, `[[p${(i + 1) % 12}]] 内容${i}`));
  put(db, pages);
  const replies = [JSON.stringify({ conflicts: [{ slugs: ['p0', 'p1'], claim: '成本说法相反', cites: [] }] }), ...Array.from({ length: 10 }, () => JSON.stringify({ conflicts: [] }))];
  const llm = stubLlm(replies);
  const op = createOp(db, 'lint', { status: 'running' });
  const r = await runLint(db, llm, op, { maxCalls: 3 });
  assert.ok(llm.calls.length <= 3);
  assert.equal(r.llmCalls, llm.calls.length);
  const note = JSON.parse(getOp(db, op)!.note) as { issues: { type: string; slugs?: string[]; detail: string }[] };
  const cf = note.issues.find((i) => i.type === 'conflict')!;
  assert.deepEqual(cf.slugs, ['p0', 'p1']);
  assert.match(cf.detail, /成本说法相反/);
  done();
});

test('runLint：模型调用失败时程序检查结果照常写入，op 为 done，并注明模型检查失败', async () => {
  const { db, done } = tmpWikiDb();
  put(db, [pg('alpha', 'Alpha', '无出处 [[ghost]]'), pg('beta', 'Beta', '[[alpha]]')]);
  const op = createOp(db, 'lint', { status: 'running' });
  await runLint(db, stubLlm([new LlmError('模型服务暂时不可用')]), op);
  const o = getOp(db, op)!;
  assert.equal(o.status, 'done');
  const note = JSON.parse(o.note) as { issues: { type: string }[]; modelError?: string };
  assert.ok(note.issues.some((i) => i.type === 'missing'));
  assert.match(note.modelError ?? '', /模型检查失败/);
  done();
});
