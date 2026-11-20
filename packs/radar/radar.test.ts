import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import { parseEntries, syncSources } from './collect.ts';
import { getItem, listItems } from './query.ts';
import { TopicMatcher, detectLang, loadTopics, normTitle, normalizeUrl, titleSimilarity } from './text.ts';

test('URL 规范化去掉跟踪参数与锚点', () => {
  assert.equal(normalizeUrl('http://Example.com/a/?utm_source=x&b=2&a=1#top'), 'https://example.com/a/?a=1&b=2');
  assert.equal(normalizeUrl('https://example.com/post/'), 'https://example.com/post');
});

test('标题相似度识别转载', () => {
  assert.ok(titleSimilarity(normTitle('OpenAI releases GPT-6 with new reasoning'), normTitle('OpenAI releases GPT-6, with new reasoning!')) > 0.8);
  assert.ok(titleSimilarity(normTitle('DeepSeek 发布 V4 多模态模型'), normTitle('DeepSeek发布V4多模态模型')) > 0.5);
  assert.ok(titleSimilarity(normTitle('Mem0 adds graph memory'), normTitle('Pipecat 1.0 released')) < 0.2);
});

test('主题匹配：短词按整词', () => {
  const m = new TopicMatcher(loadTopics());
  assert.ok(m.match('A new RAG pipeline with rerankers').includes('rag'));
  assert.ok(!m.match('Paragraph about storage').includes('rag'));
  assert.ok(m.match('Realtime voice agent with LiveKit').includes('voice'));
  assert.ok(m.match('Anthropic Skills 与 MCP 工具调用').includes('skills'));
  assert.ok(m.match('长期记忆 for agents').includes('memory'));
});

test('语言检测', () => {
  assert.equal(detectLang('这是一个关于大模型的新闻'), 'zh');
  assert.equal(detectLang('This is English news about LLMs'), 'en');
});

test('查询：过滤、全文检索与 SQL 特殊字符安全', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-test-'));
  const db = openDb(path.join(dir, 't.db'));
  syncSources(db);
  const ins = db.prepare("INSERT INTO items(source_id, url, title, norm_title, published_at, fetched_at, content, topics, importance) VALUES ('openai', ?, ?, '', ?, ?, ?, ?, ?)");
  const now = Date.now();
  ins.run('https://x.com/1', 'Voice agents get memory', now, now, 'long-term memory for realtime voice', '["voice","memory"]', 4);
  ins.run('https://x.com/2', '多模态模型发布', now - 1000, now, '视频生成', '["multimodal"]', 3);
  ins.run('https://x.com/3', "Robert'); DROP TABLE items;--", now - 2000, now, '100% _wild_', '[]', 1);
  assert.equal(listItems(db, { topic: 'voice' }).length, 1);
  assert.equal(listItems(db, { minImportance: 3 }).length, 2);
  assert.equal(listItems(db, { q: 'memory' })[0].url, 'https://x.com/1');
  assert.equal(listItems(db, { q: '多模态' }).length, 1); // 2 字符走 LIKE
  assert.equal(listItems(db, { q: '"memory OR' }).length, 0);
  assert.equal(listItems(db, { q: '%' }).length, 1);
  assert.equal(listItems(db, { q: 'DROP TABLE' }).length, 1);
  assert.ok(getItem(db, 1));
  assert.equal(getItem(db, 999), null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('全文补全判定：短摘要的博客/媒体需要，论文/Release/长正文不需要', async () => {
  const { needsFulltext } = await import('./enrich.ts');
  assert.equal(needsFulltext({ content: 'short summary', kind: 'feed', grp: 'media', fulltext_at: null }), true);
  assert.equal(needsFulltext({ content: 'short', kind: 'feed', grp: 'media', fulltext_at: 1 }), false);
  assert.equal(needsFulltext({ content: 'x'.repeat(2000), kind: 'feed', grp: 'blog', fulltext_at: null }), false);
  assert.equal(needsFulltext({ content: 'short', kind: 'feed', grp: 'paper', fulltext_at: null }), false);
  assert.equal(needsFulltext({ content: 'short', kind: 'github-releases', grp: 'release', fulltext_at: null }), false);
  assert.equal(needsFulltext({ content: 'short', kind: 'reach', grp: 'community', fulltext_at: null }), false);
});

test('parseEntries：page-list 解析为 0 条时报结构变化；feed 非 XML 仍报不是 RSS/Atom', () => {
  const url = 'https://www.cac.gov.cn/wxzw/wxfb/A093702index_1.htm';
  assert.throws(() => parseEntries({ kind: 'page-list', url }, '<ul><li>无链接</li></ul>'), /页面结构可能已变化/);
  const ok = parseEntries({ kind: 'page-list', url }, '<li><a href=//www.cac.gov.cn/2026-11/10/c_1.htm title="t">t</a>2026-11-10</li>');
  assert.equal(ok.length, 1);
  assert.throws(() => parseEntries({ kind: 'feed', url: 'https://a.example/feed' }, '<html>blocked</html>'), /不是 RSS\/Atom/);
  assert.equal(parseEntries({ kind: 'feed', url: 'https://a.example/feed' }, '<rss><channel></channel></rss>').length, 0);
});

test('sources.json：网信办两个栏目登记为 page-list、合规监管分组', () => {
  const defs = JSON.parse(fs.readFileSync(new URL('./sources.json', import.meta.url), 'utf8')).sources;
  for (const id of ['cac-wxfb', 'cac-zcfg']) {
    const d = defs.find((x: { id: string }) => x.id === id);
    assert.ok(d, id);
    assert.deepEqual([d.kind, d.grp, d.lang], ['page-list', 'reg', 'zh']);
    assert.equal(new URL(d.url).hostname, 'www.cac.gov.cn');
  }
});
