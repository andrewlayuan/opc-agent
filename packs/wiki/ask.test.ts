import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DB } from '../../packages/core/db.ts';
import { askWiki, saveAnswer } from './ask.ts';
import { recallWiki } from './recall.ts';
import { createOp, finishOp, getPage, tx, writePages } from './store.ts';
import type { PageDraft } from './store.ts';
import { seedDoc, stubLlm, tmpWikiDb } from './testutil.ts';

const put = (db: DB, drafts: PageDraft[]) =>
  tx(db, () => {
    const id = createOp(db, 'edit', { status: 'running' });
    finishOp(db, id, { status: 'done', pages: writePages(db, id, drafts).changes });
  });

test('askWiki：过滤不存在的 slug；回答附页面与引用；记一条 ask 操作计入额度', async () => {
  const { db, done } = tmpWikiDb();
  const doc = seedDoc(db, '定价资料', '## 定价\n合同审查按席位收费');
  put(db, [{ slug: 'pricing', kind: 'concept', title: '定价策略', summary: '按席位', body: `按席位收费[^${doc}:0]` }]);
  const llm = stubLlm([JSON.stringify({ slugs: ['pricing', 'nope'] }), `建议按席位[[定价策略]][^${doc}:0]`]);
  const r = await askWiki(db, llm, '合同审查怎么定价？');
  assert.equal(r.answer, `建议按席位[[定价策略]][^${doc}:0]`);
  assert.deepEqual(r.pages, [{ slug: 'pricing', title: '定价策略' }]);
  assert.deepEqual(r.cites.map((c) => [c.doc, c.ord, c.title]), [[doc, 0, '定价资料']]);
  assert.ok(String(llm.calls[1][1].content).includes('合同审查按席位收费'), '回答时附原文');
  const op = db.prepare('SELECT kind, status, llm_calls FROM wiki_ops WHERE id = ?').get(r.opId) as Record<string, unknown>;
  assert.deepEqual({ ...op }, { kind: 'ask', status: 'done', llm_calls: 2 });
  done();
});

test('askWiki：额度用完抛 429 且不调用模型；问题为空或过长抛 400', async () => {
  const { db, done } = tmpWikiDb();
  put(db, [{ slug: 'p', kind: 'concept', title: 'P', summary: '', body: 'x' }]);
  const llm = stubLlm([]);
  await assert.rejects(askWiki(db, llm, '问题', { usedToday: () => 200, limit: 200 }), { status: 429 });
  await assert.rejects(askWiki(db, llm, '  '), { status: 400 });
  await assert.rejects(askWiki(db, llm, '字'.repeat(501)), { status: 400 });
  assert.equal(llm.calls.length, 0);
  done();
});

test('askWiki：Wiki 为空时不调用模型', async () => {
  const { db, done } = tmpWikiDb();
  const llm = stubLlm([]);
  const r = await askWiki(db, llm, '随便问问');
  assert.match(r.answer, /还没有内容/);
  assert.equal(llm.calls.length, 0);
  done();
});

test('saveAnswer：生成 answer 页与 query_save 操作；同一问题再存得到 -2；之后召回能命中', () => {
  const { db, done } = tmpWikiDb();
  const a = saveAnswer(db, '合同审查怎么定价', '合同审查定价建议按席位收费');
  assert.equal(a.slug, 'q-合同审查怎么定价');
  const p = getPage(db, a.slug)!;
  assert.equal(p.kind, 'answer');
  assert.ok(p.body.includes('## 问题') && p.body.includes('## 回答'));
  assert.equal((db.prepare('SELECT kind FROM wiki_ops WHERE id = ?').get(a.opId) as { kind: string }).kind, 'query_save');
  assert.equal(saveAnswer(db, '合同审查怎么定价', '再答一次').slug, 'q-合同审查怎么定价-2');
  assert.ok(recallWiki(db, '合同审查定价').refs.some((r) => r.wiki === a.slug));
  assert.throws(() => saveAnswer(db, '', 'x'), { status: 400 });
  done();
});
