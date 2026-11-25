import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DB } from '../../packages/core/db.ts';
import { syncSources } from '../radar/collect.ts';
import { organize } from './organize.ts';
import { createOp, getOp, getPageRow } from './store.ts';
import { revertOp } from './revert.ts';
import { stubLlm, tmpWikiDb } from './testutil.ts';
import { generateTrends, pickItems, trendDomains, trendSlug } from './trend.ts';
import type { Pooled } from './trend.ts';
import { ensurePath, pageNodes, placePage } from './tree.ts';

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 25, 12).getTime();

function env() {
  const t = tmpWikiDb();
  syncSources(t.db);
  return t;
}

/** 在领域下加页面；标题用英文词，便于与情报标题的三字片段匹配 */
function addPage(db: DB, domain: string[], slug: string, title: string, kind = 'concept'): number {
  const id = Number(
    db.prepare("INSERT INTO wiki_pages(slug, kind, title, summary, body, created_at, updated_at) VALUES (?, ?, ?, ?, '正文', 1, 1)").run(slug, kind, title, `${title} 的摘要`).lastInsertRowid,
  );
  const node = ensurePath(db, domain, { now: 1 });
  placePage(db, id, node);
  return id;
}

let seq = 0;
function addItem(db: DB, title: string, o: { ageDays?: number; importance?: number; dup?: boolean; url?: string; analyzed?: boolean } = {}): number {
  seq++;
  const at = NOW - (o.ageDays ?? 1) * DAY;
  return Number(
    db
      .prepare(
        `INSERT INTO items(source_id, url, title, norm_title, published_at, fetched_at, content, topics, importance, analyzed_at, title_zh, summary_zh, dup_of)
         VALUES ('openai', ?, ?, '', ?, ?, '', '[]', ?, ?, ?, ?, ?)`,
      )
      .run(o.url ?? `https://news.test/${seq}`, title, at, at, o.importance ?? 4, o.analyzed === false ? null : at, title, `${title} 的摘要`, o.dup ? 1 : null).lastInsertRowid,
  );
}

const AGENT = ['Agent 开发'];
function seedAgentDomain(db: DB): void {
  addPage(db, AGENT, 'agent-frameworks', 'Agent frameworks');
  addPage(db, AGENT, 'tool-calling', 'Tool calling');
  addPage(db, AGENT, 'agent-memory', 'Agent memory');
}
function seedAgentItems(db: DB, n = 6): number[] {
  return Array.from({ length: n }, (_, i) => addItem(db, `New agent frameworks add tool calling and memory v${i}`, { ageDays: i + 1 }));
}

const reply = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ summary: '智能体框架趋于统一', body: '## 近期信号\n- 框架增多 [1]\n\n## 趋势判断\n- 工具调用成为标配 [3]（置信度：中）', evidence: [1, 99, 'x'], ...o });

test('trendDomains：有二级分类的按二级分类（含子孙）成领域；没有子分类的一级分类自成领域；系统节点、source/answer/trend 页不算', () => {
  const { db, done } = env();
  addPage(db, ['A', 'A1'], 'p1', 'P1');
  addPage(db, ['A', 'A1', 'A11'], 'p3', 'P3');
  addPage(db, ['A', 'A2'], 'p4', 'P4');
  addPage(db, ['A'], 'p2', 'P2');
  addPage(db, ['B'], 'b1', 'B1');
  addPage(db, ['资料摘要'], 'src-1', 'S', 'source');
  addPage(db, ['A', 'A1'], 'ans', 'Q', 'answer');
  addPage(db, ['A', 'A1'], 'trend-a', '趋势：A', 'trend');
  const gone = addPage(db, ['A', 'A1'], 'gone', 'G');
  db.prepare('UPDATE wiki_pages SET deleted = 1 WHERE id = ?').run(gone);
  const ds = trendDomains(db);
  assert.deepEqual(
    ds.map((d) => [d.title, d.pages.map((p) => p.slug).sort()]),
    [['A / A1', ['p1', 'p3']], ['A / A2', ['p4']], ['B', ['b1']]],
    '直接挂在 A 下的 p2 不属于任何领域',
  );
  done();
});

test('pickItems：关键词命中不足的不选；按命中数排序；最多 trendItems 条', () => {
  const d = { id: 1, title: 'Agent 开发', pages: [{ id: 1, slug: 'a', title: 'Agent frameworks', summary: '' }] };
  const mk = (id: number, hay: string): Pooled => ({ id, url: 'https://x/' + id, title: hay, summary: '', published_at: id, source: 's', importance: 4, hay: hay.toLowerCase() });
  const pool = [mk(1, 'cooking recipes'), mk(2, 'agent frameworks are growing'), mk(3, 'agent'), mk(4, 'Agent frameworks and the agent boom')];
  const got = pickItems(pool, d).map((x) => x.id);
  assert.ok(got.includes(2) && got.includes(4));
  assert.ok(!got.includes(1), '无关的不选');
  assert.ok(!got.includes(3), '只命中 1 个关键词的不选');
  const many = Array.from({ length: 100 }, (_, i) => mk(100 + i, 'agent frameworks news'));
  assert.equal(pickItems(many, d).length, 40);
});

test('pickItems：中文按相邻两字匹配', () => {
  const d = { id: 1, title: '大模型', pages: [{ id: 1, slug: 'a', title: '推理优化', summary: '' }] };
  const mk = (id: number, hay: string): Pooled => ({ id, url: 'https://x/' + id, title: hay, summary: '', published_at: id, source: 's', importance: 4, hay });
  const got = pickItems([mk(1, '大模型推理成本下降'), mk(2, '今日天气晴朗'), mk(3, '模型发布')], d).map((x) => x.id);
  assert.deepEqual(got, [1]);
});

test('生成趋势页：落在领域下、固定位置、依据只列用到的情报；页面不足或情报不足的领域跳过且不调用模型', async () => {
  const { db, done } = env();
  seedAgentDomain(db);
  const ids = seedAgentItems(db);
  addPage(db, ['冷门'], 'only-one', 'Only one');
  addItem(db, 'weird unrelated cooking news', { ageDays: 1 });
  addItem(db, 'New agent frameworks add tool calling and memory OLD', { ageDays: 40 });
  addItem(db, 'New agent frameworks add tool calling and memory LOW', { importance: 2 });
  addItem(db, 'New agent frameworks add tool calling and memory DUP', { dup: true });
  addItem(db, 'New agent frameworks add tool calling and memory NOTANALYZED', { analyzed: false });
  addItem(db, 'New agent frameworks add tool calling and memory FTP', { url: 'ftp://x/y' });
  const llm = stubLlm([reply()]);
  const op = createOp(db, 'trend', { status: 'running', now: NOW });
  const r = await generateTrends(db, llm, op, { now: NOW });
  assert.equal(r.llmCalls, 1);
  assert.equal(llm.calls.length, 1);
  assert.match(r.note, /生成 1 个领域的趋势页/);
  assert.match(r.note, /冷门（页面不足）/);

  const page = getPageRow(db, trendSlug('Agent 开发'))!;
  assert.equal(page.kind, 'trend');
  assert.equal(page.title, '趋势：Agent 开发');
  assert.equal(page.summary, '智能体框架趋于统一');
  const node = db.prepare('SELECT id FROM wiki_nodes WHERE title = ? AND parent_id IS NULL').get('Agent 开发') as { id: number };
  assert.deepEqual(pageNodes(db).get(page.id), { node_id: node.id, manual: true });
  // 依据：正文里的 [1]、[3] 加上 evidence 的 1；无效的 99、'x' 被忽略
  assert.match(page.body, /\n## 依据\n1\. .*· openai|\n## 依据\n1\. /);
  const refs = page.body.split('## 依据\n')[1].split('\n');
  assert.deepEqual(refs.map((l) => l.split('.')[0]), ['1', '3']);
  assert.ok(refs.every((l) => /· \d{4}-\d{2}-\d{2} · https:\/\/news\.test\/\d+$/.test(l)), refs.join('\n'));
  // 过滤：旧的 / 低重要度 / 重复 / 未分析 / 非 http 的情报没进入提示词
  const prompt = llm.calls[0].map((m) => m.content).join('\n');
  for (const bad of ['OLD', 'LOW', 'DUP', 'NOTANALYZED', 'FTP', 'cooking']) assert.ok(!prompt.includes(bad), bad);
  assert.ok(prompt.includes('Agent frameworks') && prompt.includes('<items>'));
  // 操作记录：改动 1 页，可撤销（新页 → 软删除）
  const o = getOp(db, op)!;
  assert.equal(o.status, 'done');
  assert.equal(o.pages.length, 1);
  assert.equal(o.llm_calls, 1);
  assert.equal(revertOp(db, op).conflicts.length, 0);
  assert.equal(getPageRow(db, page.slug)!.deleted, 1);
  void ids;
  done();
});

test('没有够格的领域：不调用模型，操作完成并说明原因；页面为空列表（界面据此不显示撤销）', async () => {
  const { db, done } = env();
  seedAgentDomain(db);
  seedAgentItems(db, 2);
  const llm = stubLlm([]);
  const op = createOp(db, 'trend', { status: 'running', now: NOW });
  const r = await generateTrends(db, llm, op, { now: NOW });
  assert.equal(llm.calls.length, 0);
  assert.equal(r.llmCalls, 0);
  assert.match(r.note, /没有够格的领域.*Agent 开发（近 30 天相关情报不足）/);
  assert.deepEqual(getOp(db, op)!.pages, []);
  done();
});

test('再次生成：沿用同一页并升版本，提示词带上一期判断（不含旧的依据小节）', async () => {
  const { db, done } = env();
  seedAgentDomain(db);
  seedAgentItems(db);
  const llm = stubLlm([reply({ summary: '第一期' }), reply({ summary: '第二期', body: '## 与上期对比\n- 印证 [2]' })]);
  await generateTrends(db, llm, createOp(db, 'trend', { status: 'running', now: NOW }), { now: NOW });
  const op2 = createOp(db, 'trend', { status: 'running', now: NOW });
  await generateTrends(db, llm, op2, { now: NOW + DAY });
  const p = getPageRow(db, trendSlug('Agent 开发'))!;
  assert.equal(p.rev, 2);
  assert.equal(p.summary, '第二期');
  assert.equal(db.prepare("SELECT count(*) AS n FROM wiki_pages WHERE kind = 'trend'").get()!.n, 1);
  const second = llm.calls[1].map((m) => m.content).join('\n');
  assert.match(second, /上一期判断/);
  assert.match(second, /工具调用成为标配/);
  assert.ok(!/## 依据/.test(second), '旧的依据小节不再送给模型');
  // 撤销第二期回到第一期
  assert.equal(revertOp(db, op2).conflicts.length, 0);
  assert.equal(getPageRow(db, p.slug)!.summary, '第一期');
  done();
});

test('情报标题里的 [[链接]] / [^引用] 不会进入页面成为真链接；正文里无效的 [^引用] 被丢弃', async () => {
  const { db, done } = env();
  seedAgentDomain(db);
  seedAgentItems(db, 5);
  addItem(db, 'Agent frameworks tool calling memory [[evil-page]] [^1:1]\nnext', { ageDays: 0 });
  const llm = stubLlm([reply({ body: '## 近期信号\n- 看 [[agent-frameworks]] [^1:1] [6]' })]);
  const op = createOp(db, 'trend', { status: 'running', now: NOW });
  await generateTrends(db, llm, op, { now: NOW });
  const p = getPageRow(db, trendSlug('Agent 开发'))!;
  const refs = p.body.split('## 依据\n')[1];
  assert.ok(!refs.includes('[['), refs);
  assert.ok(!/\[\^/.test(p.body), '无效引用被删');
  assert.ok(!db.prepare("SELECT 1 FROM wiki_links WHERE to_slug = 'evil-page'").get(), '没有指向 evil-page 的链接');
  assert.ok(db.prepare("SELECT 1 FROM wiki_links WHERE to_slug = 'agent-frameworks'").get(), '正常的 Wiki 链接保留');
  done();
});

test('某个领域失败不影响其他领域；全部失败时抛错且不写任何页面', async () => {
  const { db, done } = env();
  seedAgentDomain(db);
  seedAgentItems(db);
  const D2 = ['Chip 芯片'];
  addPage(db, D2, 'gpu-supply', 'GPU supply');
  addPage(db, D2, 'gpu-memory', 'GPU memory');
  addPage(db, D2, 'chip-export', 'Chip export');
  for (let i = 0; i < 6; i++) addItem(db, `GPU supply and chip export, GPU memory shortage ${i}`);
  const op = createOp(db, 'trend', { status: 'running', now: NOW });
  const r = await generateTrends(db, stubLlm([new Error('boom'), reply()]), op, { now: NOW });
  assert.match(r.note, /生成 1 个领域的趋势页/);
  assert.match(r.note, /失败：Agent 开发/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM wiki_pages WHERE kind = 'trend'").get()!.n, 1);

  const op2 = createOp(db, 'trend', { status: 'running', now: NOW });
  const before = db.prepare('SELECT count(*) AS n FROM wiki_revisions').get()!.n;
  await assert.rejects(generateTrends(db, stubLlm([new Error('x1'), new Error('x2')]), op2, { now: NOW }), /x1/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM wiki_revisions').get()!.n, before);
  done();
});

test('一次最多 trendCalls 次调用，其余领域跳过', async () => {
  const { db, done } = env();
  for (let i = 0; i < 14; i++) {
    const w = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november'][i];
    const d = [`领域${w}`];
    for (const k of ['one', 'two', 'three']) addPage(db, d, `${w}-${k}`, `${w}${w} ${k}${k}`);
    for (let j = 0; j < 5; j++) addItem(db, `${w}${w} ${w}${w} oneone twotwo threethree news ${j}`);
  }
  const llm = stubLlm(Array.from({ length: 14 }, () => reply()));
  const r = await generateTrends(db, llm, createOp(db, 'trend', { status: 'running', now: NOW }), { now: NOW });
  assert.equal(llm.calls.length, 12);
  assert.match(r.note, /生成 12 个领域的趋势页/);
  assert.match(r.note, /本次调用已达上限/);
  done();
});

test('整理目录不动趋势页：即使它没有手动固定，也不参与整理', async () => {
  const { db, done } = env();
  seedAgentDomain(db);
  seedAgentItems(db);
  await generateTrends(db, stubLlm([reply()]), createOp(db, 'trend', { status: 'running', now: NOW }), { now: NOW });
  const p = getPageRow(db, trendSlug('Agent 开发'))!;
  db.prepare('UPDATE wiki_page_node SET manual = 0 WHERE page_id = ?').run(p.id);
  db.prepare('UPDATE wiki_page_node SET manual = 1').run();
  db.prepare('UPDATE wiki_page_node SET manual = 0 WHERE page_id = ?').run(p.id);
  const llm = stubLlm([]);
  const r = await organize(db, llm, createOp(db, 'organize', { status: 'running', now: NOW }));
  assert.equal(llm.calls.length, 0, '趋势页不进入待整理列表');
  assert.equal(r.note, '没有需要整理的页面');
  done();
});

test('领域按二级分类生成：趋势页放在二级分类下，标题带一级名称', async () => {
  const { db, done } = env();
  const D = ['Agent 开发', '工具与记忆'];
  addPage(db, D, 'agent-frameworks', 'Agent frameworks');
  addPage(db, D, 'tool-calling', 'Tool calling');
  addPage(db, D, 'agent-memory', 'Agent memory');
  seedAgentItems(db);
  await generateTrends(db, stubLlm([reply()]), createOp(db, 'trend', { status: 'running', now: NOW }), { now: NOW });
  const p = getPageRow(db, trendSlug('Agent 开发 / 工具与记忆'))!;
  assert.equal(p.title, '趋势：Agent 开发 / 工具与记忆');
  const sub = db.prepare('SELECT id FROM wiki_nodes WHERE title = ?').get('工具与记忆') as { id: number };
  assert.equal(pageNodes(db).get(p.id)!.node_id, sub.id);
  done();
});

test('领域多于单次上限时轮流覆盖：没有趋势页的先做，其次是最久没更新的', async () => {
  const { db, done } = env();
  const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november'];
  for (const w of names) {
    for (const k of ['one', 'two', 'three']) addPage(db, [`领域${w}`], `${w}-${k}`, `${w}${w} ${k}${k}`);
    for (let j = 0; j < 5; j++) addItem(db, `${w}${w} ${w}${w} oneone twotwo threethree news ${j}`);
  }
  const replies = () => Array.from({ length: 14 }, () => reply());
  await generateTrends(db, stubLlm(replies()), createOp(db, 'trend', { status: 'running', now: NOW }), { now: NOW });
  const have = () => (db.prepare("SELECT slug FROM wiki_pages WHERE kind = 'trend'").all() as { slug: string }[]).length;
  assert.equal(have(), 12);
  const llm2 = stubLlm(replies());
  await generateTrends(db, llm2, createOp(db, 'trend', { status: 'running', now: NOW }), { now: NOW + DAY });
  assert.equal(have(), 14, '第二次先补上没有趋势页的两个领域');
  const firstTwo = llm2.calls.slice(0, 2).map((c) => c.map((m) => m.content).join(' '));
  assert.ok(firstTwo.some((t) => t.includes('领域mike')) && firstTwo.some((t) => t.includes('领域november')), '最后两个领域排在最前');
  done();
});

test('页面名：过长的领域名截断到 80 个字符以内，同名领域得到同一页面名', () => {
  const long = '甲'.repeat(120);
  assert.ok([...trendSlug(long)].length <= 80);
  assert.equal(trendSlug(long), trendSlug(long));
  assert.equal(trendSlug('!!!'), '');
});
