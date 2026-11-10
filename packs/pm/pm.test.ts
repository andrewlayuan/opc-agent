import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import type { Llm } from '../../packages/core/llm.ts';
import { syncSources } from '../radar/collect.ts';
import { PmAdvisor } from './advisor.ts';
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
  const skills: PmSkill[] = ['value-proposition', 'identify-assumptions-new', 'pre-mortem', 'lean-canvas', 'create-prd'].map((name) => ({
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
  assert.throws(() => advisor.start({ input: '太短', mode: 'auto', useRadar: false }), /至少/);
  assert.throws(() => advisor.start({ input: 'x'.repeat(4001), mode: 'auto', useRadar: false }), /过长/);
  assert.throws(() => advisor.start({ input: '一个足够长的产品点子描述内容', mode: 'nope', useRadar: false }), /未知/);
  assert.throws(() => advisor.start({ input: '一个足够长的产品点子描述内容', mode: 'custom', skill: '../x', useRadar: false }), /有效/);
  // 预设里不存在的技能会被过滤掉
  assert.deepEqual(advisor.presets().find((p) => p.id === 'idea')?.skills, ['value-proposition', 'identify-assumptions-new', 'pre-mortem']);
  assert.equal(advisor.presets().find((p) => p.id === 'market'), undefined);
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
  const id = advisor.start({ input: '做一款面向老人的 AI 眼镜，提醒吃药和识别熟人', mode: 'auto', useRadar: true });
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
  const id = advisor.start({ input: '给团队做一个周报自动生成工具', mode: 'idea', useRadar: false });
  const r = await waitDone(advisor, id);
  assert.equal(r.status, 'error');
  assert.match(r.error ?? '', /401/);
  db.prepare("INSERT INTO pm_reviews(created_at, status, mode, input) VALUES (1, 'running', 'auto', 'x')").run();
  new PmAdvisor(db, advisor.llm, advisor.skills, () => {});
  assert.equal((db.prepare("SELECT count(*) AS n FROM pm_reviews WHERE status='running'").get() as { n: number }).n, 0);
  done();
});
