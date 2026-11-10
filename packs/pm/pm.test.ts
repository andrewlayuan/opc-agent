import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import type { Llm } from '../../packages/core/llm.ts';
import { syncSources } from '../radar/collect.ts';
import { PmAdvisor, modeLabel } from './advisor.ts';
import type { PmError } from './advisor.ts';
import { loadPmSkills, parseSkill } from './skills.ts';
import type { PmSkill } from './skills.ts';

const md = (name: string, desc = 'Use when testing.') => `---\nname: ${name}\ndescription: "${desc}"\n---\n# ${name}\n\nYou are an expert for $ARGUMENTS.\n`;

test('解析 SKILL.md：只接受合法 name/description', () => {
  assert.deepEqual(parseSkill(md('lean-canvas', 'Generate a "Lean" canvas')), {
    name: 'lean-canvas',
    description: 'Generate a "Lean" canvas',
    body: '# lean-canvas\n\nYou are an expert for $ARGUMENTS.',
  });
  assert.equal(parseSkill('# no frontmatter'), null);
  assert.equal(parseSkill(md('../etc/passwd')), null);
  assert.equal(parseSkill(md('Bad Name')), null);
  assert.equal(parseSkill('---\nname: x\n---\nbody'), null); // 缺 description
});

test('加载技能目录：固定层级、排除无关插件、拒绝符号链接与超大文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-pm-'));
  const put = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  put('pm-product-strategy/skills/lean-canvas/SKILL.md', md('lean-canvas'));
  put('pm-execution/skills/pre-mortem/SKILL.md', md('pre-mortem'));
  put('pm-toolkit/skills/draft-nda/SKILL.md', md('draft-nda'));
  put('pm-execution/skills/huge/SKILL.md', md('huge') + 'x'.repeat(70 * 1024));
  put('pm-execution/skills/dup/SKILL.md', md('pre-mortem'));
  put('other/skills/x/SKILL.md', md('x'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-pm-out-'));
  fs.mkdirSync(path.join(outside, 'evil'));
  fs.writeFileSync(path.join(outside, 'evil', 'SKILL.md'), md('evil'));
  fs.symlinkSync(path.join(outside, 'evil'), path.join(dir, 'pm-execution/skills/evil'));
  const names = loadPmSkills(dir).map((s) => s.name).sort();
  assert.deepEqual(names, ['lean-canvas', 'pre-mortem']);
  assert.deepEqual(loadPmSkills(path.join(dir, 'missing')), []);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function setup(llmImpl: { json?: (m: { content: string }[]) => unknown; chat?: (m: { content: string }[]) => string | Promise<string> }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-pm-db-'));
  const db = openDb(path.join(dir, 't.db'));
  syncSources(db);
  const skills: PmSkill[] = ['value-proposition', 'identify-assumptions-new', 'pre-mortem', 'lean-canvas', 'monetization-strategy', 'pricing-strategy', 'create-prd', 'strategy-red-team', 'swot-analysis'].map((name) => ({
    name,
    plugin: 'pm-product-strategy',
    description: `${name} desc`,
    body: `BODY-${name} for $ARGUMENTS`,
  }));
  const llm = {
    enabled: true,
    json: async (m: { content: string }[]) => llmImpl.json?.(m) ?? {},
    chat: async (m: { content: string }[]) => llmImpl.chat?.(m) ?? '',
  } as unknown as Llm;
  const advisor = new PmAdvisor(db, llm, skills, () => {});
  return { db, advisor, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}

async function waitDone(advisor: PmAdvisor, id: number) {
  for (let i = 0; i < 100; i++) {
    const r = advisor.get(id);
    if (r && r.status !== 'running') return r;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timeout');
}

test('产品顾问：参数校验', () => {
  const { advisor, done } = setup({});
  const ok = '一个足够长的产品点子描述内容';
  assert.throws(() => advisor.start({ input: '太短', presets: [], skills: [], useRadar: false }), /至少/);
  assert.throws(() => advisor.start({ input: 'x'.repeat(4001), presets: [], skills: [], useRadar: false }), /过长/);
  assert.throws(() => advisor.start({ input: ok, presets: ['nope'], skills: [], useRadar: false }), /未知/);
  assert.throws(() => advisor.start({ input: ok, presets: [], skills: ['../x'], useRadar: false }), /无效/);
  assert.throws(() => advisor.start({ input: ok, presets: ['idea', 'business', 'redteam'], skills: [], useRadar: false }), /最多组合 6 个框架（当前 7 个）/);
  // 预设里不存在的技能会被过滤掉
  assert.deepEqual(advisor.presets().find((p) => p.id === 'idea')?.skills, ['value-proposition', 'identify-assumptions-new', 'pre-mortem']);
  assert.equal(advisor.presets().find((p) => p.id === 'market'), undefined);
  done();
});

test('产品顾问：多选合并、去重、上限与模式名称', () => {
  const { advisor, done } = setup({});
  // 不选或只选 auto = 智能匹配；非数组参数按未选择处理
  assert.deepEqual(advisor.resolve([], []), { mode: 'auto', auto: true, prd: false, chosen: [] });
  assert.equal(advisor.resolve(['auto'], undefined).auto, true);
  assert.equal(advisor.resolve('idea', { x: 1 }).auto, true);
  // 方案 + 自选框架合并，按选择顺序去重（pre-mortem 同时在 idea 与 redteam 中）
  const p = advisor.resolve(['idea', 'redteam', 'auto'], ['swot-analysis', 'pre-mortem']);
  assert.deepEqual(p.chosen, ['value-proposition', 'identify-assumptions-new', 'pre-mortem', 'strategy-red-team', 'swot-analysis']);
  assert.equal(p.auto, false);
  assert.equal(p.mode, 'idea+redteam+custom');
  assert.equal(modeLabel(p.mode), '点子快评 + 战略红队 + 自选框架');
  assert.equal(modeLabel('auto'), '智能匹配');
  // 只选 PRD 才输出 PRD 格式；和别的组合时作为一个框架参与评审
  assert.equal(advisor.resolve(['prd'], []).prd, true);
  assert.equal(advisor.resolve(['prd'], ['lean-canvas']).prd, false);
  // 正好 6 个可以，7 个拒绝
  assert.equal(advisor.resolve(['idea', 'business'], []).chosen.length, 6);
  assert.throws(() => advisor.resolve(['idea', 'business'], ['swot-analysis']), /最多组合 6/);
  done();
});

test('产品顾问：多框架组合时按数量均分框架说明长度，并放宽篇幅', async () => {
  let system = '';
  let user = '';
  let opts: { maxTokens?: number } = {};
  const { advisor, done } = setup({});
  (advisor.llm as unknown as { chat: unknown }).chat = async (m: { content: string }[], o: { maxTokens?: number }) => {
    system = m[0].content;
    user = m[1].content;
    opts = o;
    return '## 一句话结论\n- 值得做';
  };
  for (const s of advisor.skills) s.body = `BODY-${s.name} ` + 'x'.repeat(20000);
  const id = advisor.start({ input: '一个足够长的产品点子描述内容', presets: ['idea', 'business'], skills: [], useRadar: false });
  const r = await waitDone(advisor, id);
  assert.equal(r.status, 'done');
  assert.equal(r.skills.length, 6);
  assert.equal(r.mode_label, '点子快评 + 商业模式与变现');
  for (const n of r.skills) assert.match(system, new RegExp(`<skill name="${n}">`));
  assert.ok(system.length < 45000, `system prompt too long: ${system.length}`);
  assert.match(user, /4500 字以内/);
  assert.equal(opts.maxTokens, 8000);
  done();
});

test('产品顾问：智能匹配框架 + 引用雷达情报 + 去掉 URL', async () => {
  let system = '';
  let user = '';
  const { db, advisor, done } = setup({
    json: () => ({ skills: ['lean-canvas', 'not-a-skill', 'pre-mortem'], keywords: ['AI glasses', 'x', 42] }),
    chat: (m) => {
      system = m[0].content;
      user = m[1].content;
      return '## 一句话结论\n- 有条件地做 [1] 详见 https://evil.example/p';
    },
  });
  const now = Date.now();
  db.prepare("INSERT INTO items(source_id, url, title, norm_title, published_at, fetched_at, content, topics, title_zh, summary_zh, analyzed_at, importance) VALUES ('openai', 'https://a.com/1', 'Meta AI glasses sales double', '', ?, ?, 'AI glasses market', '[]', 'Meta AI 眼镜销量翻倍', '销量翻倍', 1, 4)").run(now, now);
  const id = advisor.start({ input: '做一款面向老人的 AI 眼镜，提醒吃药和识别熟人', presets: [], skills: [], useRadar: true });
  const r = await waitDone(advisor, id);
  assert.equal(r.status, 'done');
  assert.deepEqual(r.skills, ['lean-canvas', 'pre-mortem']);
  assert.match(system, /BODY-lean-canvas for 用户在 <request> 中提交的内容/);
  assert.doesNotMatch(system, /BODY-value-proposition/);
  assert.match(user, /<radar>\n\[1\] \(OpenAI News｜/);
  assert.match(user, /老人的 AI 眼镜/);
  assert.doesNotMatch(r.content ?? '', /https?:/);
  assert.deepEqual(r.refs.map((x) => x.url), ['https://a.com/1']);
  assert.equal(advisor.list()[0].id, id);
  assert.ok(advisor.delete(id));
  assert.equal(advisor.get(id), null);
  done();
});

test('产品顾问：模型失败时记录错误；重启后进行中的任务标记中断', async () => {
  const { db, advisor, done } = setup({ chat: () => Promise.reject(new Error('模型调用失败（HTTP 401）')) });
  const id = advisor.start({ input: '给团队做一个周报自动生成工具', presets: ['idea'], skills: [], useRadar: false });
  const r = await waitDone(advisor, id);
  assert.equal(r.status, 'error');
  assert.match(r.error ?? '', /401/);
  db.prepare("INSERT INTO pm_reviews(created_at, status, mode, input) VALUES (1, 'running', 'auto', 'x')").run();
  new PmAdvisor(db, advisor.llm, advisor.skills, () => {});
  assert.equal((db.prepare("SELECT count(*) AS n FROM pm_reviews WHERE status='running'").get() as { n: number }).n, 0);
  done();
});

test('多轮：首版完成写入 v1 并更新 updated_at', async () => {
  const { db, advisor, done } = setup({ chat: () => '# 结论\n' + '正文'.repeat(150) });
  const id = advisor.start({ input: '给团队做一个周报自动生成工具', presets: ['idea'], skills: [], useRadar: false });
  await waitDone(advisor, id);
  const v = db.prepare('SELECT n, source, content FROM pm_versions WHERE review_id=?').all(id) as { n: number; source: string; content: string }[];
  assert.equal(v.length, 1);
  assert.equal(v[0].n, 1);
  assert.equal(v[0].source, 'ai_initial');
  assert.match(v[0].content, /^# 结论/);
  assert.ok(Number((db.prepare('SELECT updated_at FROM pm_reviews WHERE id=?').get(id) as { updated_at: number }).updated_at) > 0);
  done();
});

test('多轮：迁移把旧的已完成评审回填为 v1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-pm-mig-'));
  const file = path.join(dir, 't.db');
  let db = openDb(file);
  db.exec('DROP TABLE IF EXISTS pm_messages; DROP TABLE IF EXISTS pm_versions; PRAGMA user_version = 3;');
  const cols = db.prepare('PRAGMA table_info(pm_reviews)').all() as { name: string }[];
  if (cols.some((c) => c.name === 'updated_at')) db.exec('ALTER TABLE pm_reviews DROP COLUMN updated_at');
  db.prepare("INSERT INTO pm_reviews(created_at, finished_at, status, mode, input, content) VALUES (1, 2, 'done', 'idea', 'x', '旧内容')").run();
  db.prepare("INSERT INTO pm_reviews(created_at, status, mode, input) VALUES (1, 'error', 'idea', 'y')").run();
  db.close();
  db = openDb(file);
  const v = db.prepare('SELECT review_id, n, source, content, created_at FROM pm_versions').all();
  assert.deepEqual(v.map((x) => ({ ...x })), [{ review_id: 1, n: 1, source: 'ai_initial', content: '旧内容', created_at: 2 }]);
  assert.equal((db.prepare('SELECT updated_at FROM pm_reviews WHERE id=2').get() as { updated_at: number }).updated_at, 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('多轮：重启时进行中的轮次标记为中断', () => {
  const { db, advisor, done } = setup({});
  const rid = Number(db.prepare("INSERT INTO pm_reviews(created_at, status, mode, input, content) VALUES (1, 'done', 'idea', 'x', 'c')").run().lastInsertRowid);
  db.prepare("INSERT INTO pm_messages(review_id, created_at, role, kind, status) VALUES (?, 1, 'assistant', 'ask', 'running')").run(rid);
  new PmAdvisor(db, advisor.llm, advisor.skills, () => {});
  const m = db.prepare('SELECT status, error FROM pm_messages').get() as { status: string; error: string };
  assert.equal(m.status, 'error');
  assert.equal(m.error, '服务重启，已中断');
  done();
});

const LONG_DOC = (tag: string) => `# ${tag}\n` + '详细内容'.repeat(80);
/** 首版返回 v1 文档；之后最后一条 user 消息含「改」则改写，否则回答 */
function fakeTurn(m: { content: string }[]): string {
  const last = m.at(-1)!.content;
  if (m.length <= 2) return LONG_DOC('首版');
  return /改/.test(last) ? `[改写]\n${LONG_DOC('改写版')}\n---变更说明---\n改了定价` : '[回答]\n解释';
}
async function doneReview(advisor: PmAdvisor): Promise<number> {
  const id = advisor.start({ input: '给团队做一个周报自动生成工具', presets: ['idea'], skills: [], useRadar: false });
  const r = await waitDone(advisor, id);
  assert.equal(r.status, 'done');
  return id;
}
async function waitTurn(advisor: PmAdvisor, id: number) {
  for (let i = 0; i < 200; i++) {
    if (!advisor.get(id)!.messages.some((x) => x.status === 'running')) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timeout');
}
const statusOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return { status: (e as PmError).status, message: (e as Error).message };
  }
  return null;
};

test('多轮：回答不产生版本，改写产生 v2，并以最新版为上下文', async () => {
  const seen: string[] = [];
  const { advisor, done } = setup({ chat: (m) => (seen.push(m.map((x) => x.content).join('\n')), fakeTurn(m)) });
  const id = await doneReview(advisor);
  let r = advisor.get(id)!;
  assert.equal(r.latest, 1);
  assert.deepEqual(r.versions.map((v) => v.source), ['ai_initial']);
  advisor.ask(id, '为什么选这个市场？', 'auto');
  await waitTurn(advisor, id);
  r = advisor.get(id)!;
  assert.equal(r.latest, 1);
  assert.deepEqual(r.messages.map((x) => [x.role, x.kind, x.status]), [['user', 'ask', 'done'], ['assistant', 'ask', 'done']]);
  assert.equal(r.messages[1].content, '解释');
  advisor.ask(id, '把定价改成年费', 'auto');
  await waitTurn(advisor, id);
  r = advisor.get(id)!;
  assert.equal(r.latest, 2);
  assert.equal(r.versions[1].source, 'ai_revise');
  assert.equal(r.versions[1].note, '改了定价');
  assert.equal(r.messages.at(-1)!.version_n, 2);
  assert.equal(r.messages.at(-1)!.kind, 'revise');
  assert.match(r.content ?? '', /^# 改写版/);
  assert.match(seen.at(-1)!, /当前文档（v1）[\s\S]*# 首版/);
  assert.match(seen.at(-1)!, /为什么选这个市场？[\s\S]*解释/);
  assert.match(advisor.version(id, 1)!.content, /^# 首版/);
  assert.equal(advisor.version(id, 9), null);
  done();
});

test('多轮：首版未完成或失败、长度、并发都会被拒绝；进行中不能删除', async () => {
  let hang = false;
  const { db, advisor, done } = setup({ chat: (m) => (hang && m.length > 2 ? new Promise<string>(() => {}) : fakeTurn(m)) });
  const running = Number(db.prepare("INSERT INTO pm_reviews(created_at, status, mode, input) VALUES (1, 'running', 'idea', 'x')").run().lastInsertRowid);
  assert.deepEqual(statusOf(() => advisor.ask(running, '为什么呢', 'auto')), { status: 400, message: '首版评审完成后才能继续对话' });
  const failed = Number(db.prepare("INSERT INTO pm_reviews(created_at, status, mode, input) VALUES (1, 'error', 'idea', 'x')").run().lastInsertRowid);
  assert.equal(statusOf(() => advisor.ask(failed, '为什么呢', 'auto'))!.status, 400);
  assert.equal(statusOf(() => advisor.ask(999, '为什么呢', 'auto'))!.status, 404);
  const id = await doneReview(advisor);
  assert.equal(statusOf(() => advisor.ask(id, 'x', 'auto'))!.status, 400);
  assert.equal(statusOf(() => advisor.ask(id, 'x'.repeat(4001), 'auto'))!.status, 400);
  hang = true;
  advisor.ask(id, '为什么呢', 'auto');
  assert.deepEqual(statusOf(() => advisor.ask(id, '再问一次', 'auto')), { status: 409, message: '上一轮还在进行中' });
  assert.deepEqual(statusOf(() => advisor.delete(id)), { status: 409, message: '上一轮还在进行中' });
  assert.equal(statusOf(() => advisor.saveManual(id, '# 手改\n内容', 1))!.status, 409);
  done();
});

test('多轮：手动版本、冲突、内容未变化，之后的追问基于手动版', async () => {
  const seen: string[] = [];
  const { advisor, done } = setup({ chat: (m) => (seen.push(m.map((x) => x.content).join('\n')), fakeTurn(m)) });
  const id = await doneReview(advisor);
  assert.equal(advisor.saveManual(id, '# 手改\n我补充的内容', 1), 2);
  const r = advisor.get(id)!;
  assert.equal(r.versions[1].source, 'manual');
  assert.equal(r.versions[1].note, null);
  assert.equal(r.messages.length, 0);
  assert.deepEqual(statusOf(() => advisor.saveManual(id, '# 另一版', 1)), { status: 409, message: '已有更新的 v2' });
  assert.deepEqual(statusOf(() => advisor.saveManual(id, '  # 手改\n我补充的内容 ', 2)), { status: 400, message: '内容没有变化' });
  assert.equal(statusOf(() => advisor.saveManual(id, '   ', 2))!.status, 400);
  assert.equal(statusOf(() => advisor.saveManual(id, 'x'.repeat(40001), 2))!.status, 400);
  assert.equal(statusOf(() => advisor.saveManual(id, '# 新', 'abc'))!.status, 409);
  advisor.ask(id, '为什么这么改', 'auto');
  await waitTurn(advisor, id);
  assert.match(seen.at(-1)!, /当前文档（v2）[\s\S]*# 手改/);
  done();
});

test('多轮：模型失败时该轮标记错误、文档不变；revise 模式强制改写', async () => {
  let fail = false;
  const { advisor, done } = setup({ chat: (m) => (fail && m.length > 2 ? Promise.reject(new Error('模型调用超时')) : m.length > 2 ? LONG_DOC('强制改写') : fakeTurn(m)) });
  const id = await doneReview(advisor);
  fail = true;
  advisor.ask(id, '为什么呢', 'auto');
  await waitTurn(advisor, id);
  let r = advisor.get(id)!;
  assert.equal(r.messages.at(-1)!.status, 'error');
  assert.match(r.messages.at(-1)!.error ?? '', /超时/);
  assert.equal(r.latest, 1);
  fail = false;
  advisor.ask(id, '整体再精简一点', 'revise');
  await waitTurn(advisor, id);
  r = advisor.get(id)!;
  assert.equal(r.latest, 2);
  assert.equal(r.versions[1].note, '根据你的要求修订');
  done();
});

test('多轮：删除会话时级联删除消息与版本；list 返回 latest/turns 并按更新时间排序', async () => {
  const { db, advisor, done } = setup({ chat: fakeTurn });
  const a = await doneReview(advisor);
  const b = await doneReview(advisor);
  await new Promise((r) => setTimeout(r, 5));
  advisor.ask(a, '把定价改成年费', 'auto');
  await waitTurn(advisor, a);
  const list = advisor.list();
  assert.deepEqual(list.map((x) => x.id), [a, b]);
  assert.equal(list[0].latest, 2);
  assert.equal(list[0].turns, 1);
  assert.equal(list[1].latest, 1);
  assert.equal(list[1].turns, 0);
  assert.ok(advisor.delete(a));
  const n = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t} WHERE review_id=?`).get(a) as { n: number }).n;
  assert.equal(n('pm_messages'), 0);
  assert.equal(n('pm_versions'), 0);
  done();
});
