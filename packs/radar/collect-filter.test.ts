import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { DB } from '../../packages/core/db.ts';
import { openDb } from '../../packages/core/db.ts';
import { filterTopicIds, insertEntries, syncSources } from './collect.ts';
import type { SourceRow } from './collect.ts';
import { TopicMatcher, loadTopics } from './text.ts';

const topics = loadTopics();
const matcher = new TopicMatcher(topics);

function tmpDb(): { db: DB; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-cfilter-'));
  const db = openDb(path.join(dir, 't.db'));
  syncSources(db);
  return { db, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}

const srcRow = (db: DB, id: string): SourceRow => db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow;

let seq = 0;
function entry(title: string) {
  seq++;
  return { title, url: `https://example.com/${seq}`, content: '', publishedAt: Date.now() };
}

test('filterTopicIds：综合源只认本档案的主题，泛化的「AI 产品」不算', () => {
  const techIds = filterTopicIds({ id: 'hn' }, topics);
  assert.ok(techIds.has('llm') && techIds.has('agent'), '技术主题算命中');
  assert.ok(!techIds.has('fi-market'), '金融主题不算技术源的命中');
  assert.ok(!techIds.has('lg-privacy'), '法务主题不算技术源的命中');
  assert.ok(!techIds.has('rs-ml'), '科研主题不算技术源的命中');
  assert.ok(!techIds.has('product'), '「AI 产品」关键词太宽，不参与过滤');

  const researchIds = filterTopicIds({ id: 'arxiv-lg' }, topics);
  assert.ok(researchIds.has('rs-ml'), '科研源认科研主题');
  assert.ok(!researchIds.has('llm'), '科研源不认只属于技术的主题');

  const sharedIds = filterTopicIds({ id: 'producthunt' }, topics);
  assert.ok(sharedIds.has('pm-compete') && sharedIds.has('llm') && sharedIds.has('fd-market'), '多档案共享源认各自的主题');
  assert.ok(!sharedIds.has('fi-market'), '未共享的档案主题仍不算');

  const customIds = filterTopicIds({ id: 'mine', custom: 1 }, topics);
  assert.ok(customIds.has('llm') && customIds.has('fi-market'), '自定义源没有档案归属，按全部主题过滤');
  assert.ok(!customIds.has('product'));
});

test('insertEntries：filter 源丢掉只命中其它档案主题的条目，保留命中本档案的条目', () => {
  const { db, done } = tmpDb();
  const hn = srcRow(db, 'hn');
  // 只有金融主题命中
  const fin = insertEntries(db, hn, [entry('Nasdaq 标普 500 大跌，selloff 加剧，bond yield 走高')], matcher, 14);
  assert.equal(fin.length, 0, '技术源不应收录纯金融市场条目');
  // 只命中「AI 产品」的泛化词
  const generic = insertEntries(db, hn, [entry('Notion 上线 beta：一款新的 app 正式 available 了')], matcher, 14);
  assert.equal(generic.length, 0, '只命中泛化主题的条目仍被过滤');
  // 命中技术主题
  const tech = insertEntries(db, hn, [entry('OpenAI 发布 GPT-5，开源模型 Llama 也有更新')], matcher, 14);
  assert.equal(tech.length, 1, '命中技术主题的条目要留下');

  const arxiv = srcRow(db, 'arxiv-lg');
  assert.equal(insertEntries(db, arxiv, [entry('A scaling law for deep learning benchmark performance')], matcher, 14).length, 1);
  assert.equal(insertEntries(db, arxiv, [entry('Fed raises rates as treasury yields climb')], matcher, 14).length, 0);
  done();
});
