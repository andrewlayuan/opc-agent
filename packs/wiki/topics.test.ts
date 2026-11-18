import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DB } from '../../packages/core/db.ts';
import { createOp, finishOp, tx, writePages } from './store.ts';
import type { PageDraft } from './store.ts';
import { seedDoc, tmpWikiDb } from './testutil.ts';
import { pageTopics } from './topics.ts';

const put = (db: DB, drafts: PageDraft[]) =>
  tx(db, () => {
    const id = createOp(db, 'edit', { status: 'running' });
    finishOp(db, id, { status: 'done', pages: writePages(db, id, drafts).changes });
  });
const pg = (slug: string, title: string, body: string, kind: PageDraft['kind'] = 'concept'): PageDraft => ({ slug, kind, title, summary: '', body });
const topicOf = (db: DB) => Object.fromEntries(pageTopics(db).of);

test('pageTopics：每页归到链接距离最近的总览页，总览页归自己；主题按页数从多到少排列', () => {
  const { db, done } = tmpWikiDb();
  put(db, [
    pg('agent', 'Agent 总览', '[[rag]] [[memory]]', 'overview'),
    pg('speaker', '音箱总览', '[[tuya]]', 'overview'),
    pg('rag', 'RAG', '见 [[vector]]'),
    pg('memory', '记忆', '正文'),
    pg('vector', '向量库', '正文'),
    pg('tuya', '涂鸦', '正文', 'entity'),
  ]);
  assert.deepEqual(topicOf(db), { agent: 'agent', speaker: 'speaker', rag: 'agent', memory: 'agent', vector: 'agent', tuya: 'speaker' });
  assert.deepEqual(pageTopics(db).topics, [
    { slug: 'agent', title: 'Agent 总览', count: 4 },
    { slug: 'speaker', title: '音箱总览', count: 2 },
  ]);
  done();
});

test('pageTopics：链接是双向看待的；同样距离时按相邻页面多数归属决定', () => {
  const { db, done } = tmpWikiDb();
  put(db, [
    pg('a', '总览甲', '[[a1]] [[a2]]', 'overview'),
    pg('b', '总览乙', '[[b1]]', 'overview'),
    pg('a1', '甲一', '正文'),
    pg('a2', '甲二', '正文'),
    pg('b1', '乙一', '正文'),
    pg('x', '跨界页', '提到 [[a1]]、[[a2]] 和 [[b1]]'),
  ]);
  assert.equal(topicOf(db).x, 'a');
  done();
});

test('pageTopics：没有任何链接的页面按引用的资料归到同资料页面最多的主题；仍无法判断时为 null', () => {
  const { db, done } = tmpWikiDb();
  const d = seedDoc(db, '音箱资料', '## 一\n内容');
  put(db, [
    pg('a', '总览甲', '[[a1]]', 'overview'),
    pg('b', '总览乙', '[[b1]]', 'overview'),
    pg('a1', '甲一', '正文'),
    pg('b1', '乙一', `依据[^${d}:0]`),
    pg('lonely', '孤立页', `也依据[^${d}:0]`),
    pg('nowhere', '无关页', '没有链接也没有引用'),
  ]);
  const t = topicOf(db);
  assert.equal(t.lonely, 'b');
  assert.equal(t.nowhere, null);
  done();
});

test('pageTopics：没有总览页时所有页面都没有主题，主题列表为空', () => {
  const { db, done } = tmpWikiDb();
  put(db, [pg('a1', '甲一', '[[a2]]'), pg('a2', '甲二', '正文')]);
  assert.deepEqual(topicOf(db), { a1: null, a2: null });
  assert.deepEqual(pageTopics(db).topics, []);
  done();
});
