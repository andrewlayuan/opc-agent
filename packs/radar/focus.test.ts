import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import type { Llm } from '../../packages/core/llm.ts';
import { generateBrief, mergeTopics, retagPending } from './analyze.ts';
import { syncSources } from './collect.ts';
import { getInterests, setInterests } from './prefs.ts';
import { topicsOfProfile } from './profiles.ts';
import { listItems } from './query.ts';
import { TopicMatcher, loadTopics, topicsRev } from './text.ts';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-focus-'));
  const db = openDb(path.join(dir, 't.db'));
  syncSources(db);
  return { db, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}

function fakeLlm(impl: { chat?: (m: { content: string }[]) => string; json?: (m: { content: string }[]) => unknown }): Llm {
  return {
    enabled: true,
    chat: async (m: { content: string }[]) => impl.chat?.(m) ?? '',
    json: async (m: { content: string }[]) => impl.json?.(m) ?? {},
  } as unknown as Llm;
}

const topics = loadTopics();

test('AI 硬件主题：芯片/算力命中，只提公司名不命中', () => {
  const m = new TopicMatcher(topics);
  assert.ok(m.match('NVIDIA ships GB300 NVL72 racks').includes('hardware'));
  assert.ok(m.match('寒武纪发布新一代 AI 芯片').includes('hardware'));
  assert.ok(m.match('Google unveils Ironwood TPU').includes('hardware'));
  assert.ok(!m.match('NVIDIA open models for European retail').includes('hardware'));
  assert.ok(!m.match('Paragraph about hardware stores').includes('hardware'));
});

test('各身份的主题不串味：硬件加速器不算创业加速器，零售新闻不算宏观数据，案例盘点不算判例', () => {
  const m = new TopicMatcher(topics);
  assert.ok(!m.match('New accelerator for data centers').includes('fd-startup'));
  assert.ok(!m.match('Retail with open models').includes('fi-macro'));
  assert.ok(!m.match('产品设计案例盘点').includes('lg-case'));
  assert.ok(m.match('YC startup accelerator applications open').includes('fd-startup'));
  assert.ok(m.match('美国 5 月零售销售环比上升').includes('fi-macro'));
  assert.ok(m.match('法院判决平台承担侵权责任').includes('lg-case'));
});

test('分析后主题 = 模型判定 ∪ 标题/摘要关键词，过滤非法主题', () => {
  assert.deepEqual(mergeTopics(topics, ['llm', 'evil', 42], 'Qwen 4 on Blackwell').sort(), ['hardware', 'llm']);
  assert.deepEqual(mergeTopics(topics, 'not-array', 'nothing relevant'), []);
  // AI 产品的关键词太宽泛（发布/launch），分析后只认模型判定
  assert.deepEqual(mergeTopics(topics, [], 'OpenAI 发布新 app'), []);
  assert.deepEqual(mergeTopics(topics, ['product'], 'OpenAI 发布新 app'), ['product']);
});

test('我的关注：校验、保存、读取', () => {
  const { db, done } = tmpDb();
  assert.deepEqual(getInterests(db, topics), { topics: [], minImportance: 3 });
  const v = setInterests(db, topics, { topics: ['llm', 'hardware', 'llm', 'bogus', 1], minImportance: 99 });
  assert.deepEqual(v, { topics: ['llm', 'hardware'], minImportance: 3 });
  setInterests(db, topics, { topics: ['hardware'], minImportance: 4 });
  assert.deepEqual(getInterests(db, topics), { topics: ['hardware'], minImportance: 4 });
  assert.deepEqual(setInterests(db, topics, 'garbage'), { topics: [], minImportance: 3 });
  done();
});

test('我的关注按身份保存：在另一个身份下设置不会丢掉原身份的关注，同一身份再存只替换本身份的主题', () => {
  const { db, done } = tmpDb();
  const tech = topicsOfProfile(topics, 'tech');
  const fin = topicsOfProfile(topics, 'finance');
  setInterests(db, tech, { topics: ['llm', 'hardware'], minImportance: 4 }, topics);
  assert.deepEqual(getInterests(db, fin), { topics: [], minImportance: 4 }, '金融身份下看不到 tech 的主题；重点阈值是全局偏好，不分身份');
  setInterests(db, fin, { topics: ['fi-policy'], minImportance: 3 }, topics);
  assert.deepEqual(getInterests(db, tech).topics, ['llm', 'hardware'], '切回 tech 关注还在');
  assert.deepEqual(getInterests(db, fin).topics, ['fi-policy']);
  setInterests(db, tech, { topics: ['rag'], minImportance: 0 }, topics);
  assert.deepEqual(getInterests(db, tech), { topics: ['rag'], minImportance: 0 });
  assert.deepEqual(getInterests(db, fin).topics, ['fi-policy'], '金融的关注也没被覆盖');
  done();
});

test('多主题筛选（任一命中）+ 重要度', () => {
  const { db, done } = tmpDb();
  const ins = db.prepare("INSERT INTO items(source_id, url, title, norm_title, published_at, fetched_at, topics, importance) VALUES ('openai', ?, ?, '', ?, ?, ?, ?)");
  const now = Date.now();
  ins.run('https://x.com/1', 'a', now, now, '["llm"]', 4);
  ins.run('https://x.com/2', 'b', now, now, '["hardware","product"]', 3);
  ins.run('https://x.com/3', 'c', now, now, '["rag"]', 5);
  ins.run('https://x.com/4', 'd', now, now, '["hardware"]', 2);
  assert.equal(listItems(db, { topics: ['llm', 'hardware'] }).length, 3);
  assert.equal(listItems(db, { topics: ['llm', 'hardware'], minImportance: 3 }).length, 2);
  assert.equal(listItems(db, { topics: ["x') OR 1=1 --"] }).length, 0);
  done();
});

test('主题校准：按新主题清单重新归类，完成后不再重复', async () => {
  const { db, done } = tmpDb();
  const ins = db.prepare(
    "INSERT INTO items(source_id, url, title, norm_title, published_at, fetched_at, topics, title_zh, summary_zh, analyzed_at, importance) VALUES ('openai', ?, ?, '', ?, ?, ?, ?, ?, 1, 3)",
  );
  const now = Date.now();
  ins.run('https://x.com/1', 'Retail with open models', now, now, '["llm","hardware"]', '零售业开放模型', '用开放模型改造零售');
  ins.run('https://x.com/2', 'New accelerator', now, now, '[]', '新的推理芯片发布', '面向数据中心');
  let calls = 0;
  const llm = fakeLlm({
    json: (m) => {
      calls++;
      assert.match(m[1].content, /hardware=AI 硬件/);
      return { items: [{ id: 1, topics: ['llm'] }, { id: 2, topics: ['hardware', 'nope'] }] };
    },
  });
  assert.equal(await retagPending(db, llm, topics, 100), 2);
  const rows = db.prepare('SELECT id, topics, topics_rev FROM items ORDER BY id').all() as { id: number; topics: string; topics_rev: string }[];
  assert.deepEqual(JSON.parse(rows[0].topics), ['llm']); // 正文顺带提及造成的误标被去掉
  assert.deepEqual(JSON.parse(rows[1].topics), ['hardware']);
  assert.equal(rows[0].topics_rev, topicsRev(topics));
  assert.equal(await retagPending(db, llm, topics, 100), 0);
  assert.equal(calls, 1);
  done();
});

test('按我的关注生成简报：只纳入关注主题，并标注范围', async () => {
  const { db, done } = tmpDb();
  const ins = db.prepare(
    "INSERT INTO items(source_id, url, title, norm_title, published_at, fetched_at, topics, title_zh, summary_zh, analyzed_at, importance) VALUES ('openai', ?, ?, '', ?, ?, ?, ?, ?, 1, 4)",
  );
  const now = Date.now();
  ins.run('https://x.com/1', 'GPU', now, now, '["hardware"]', '新 GPU', 's');
  ins.run('https://x.com/2', 'RAG', now, now, '["rag"]', 'RAG 框架', 's');
  let prompt = '';
  const llm = fakeLlm({ chat: (m) => ((prompt = m[1].content), '## 今日要点\n- 新 GPU 发布 [1] https://evil.example/x') });
  const b = await generateBrief(db, llm, topics, 24, ['hardware', 'bogus']);
  assert.match(prompt, /新 GPU/);
  assert.doesNotMatch(prompt, /RAG 框架/);
  assert.match(b.content, /^范围：我的关注（AI 硬件）/);
  assert.doesNotMatch(b.content, /https?:/);
  assert.equal(b.items.length, 1);
  done();
});
