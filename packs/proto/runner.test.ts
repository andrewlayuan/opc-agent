import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, type DB } from '../../packages/core/db.ts';
import type { EventInput } from '../memory/events.ts';
import type { LlmPort } from '../pm/ingest.ts';
import { ProtoRunner } from './runner.ts';
import { getVersion, listVersions } from './store.ts';
import { ProtoError } from './types.ts';

type ChatArgs = Parameters<LlmPort['chat']>;
const OUTLINE = {
  product: '律审通', device: 'phone', theme: 'green', nav: ['home'], data: {},
  pages: [
    { slug: 'home', title: '首页', purpose: 'p', content: 'c', links: [] },
    { slug: 'detail', title: '详情', purpose: 'p', content: 'c', links: [] },
    { slug: 'me', title: '我的', purpose: 'p', content: 'c', links: [] },
  ],
};
const OUTLINE_JSON = JSON.stringify(OUTLINE);

function setup(reviewStatus = 'done', extra = false): DB {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO pm_reviews(id, created_at, updated_at, status, mode, input) VALUES (1, 1, 1, ?, 'prd', '律审通')").run(reviewStatus);
  db.prepare("INSERT INTO pm_versions(review_id, n, created_at, source, content) VALUES (1, 1, 1, 'initial', ?)").run('PRD 正文');
  if (extra) {
    db.prepare("INSERT INTO pm_reviews(id, created_at, updated_at, status, mode, input) VALUES (2, 1, 1, 'done', 'prd', '二号')").run();
    db.prepare("INSERT INTO pm_versions(review_id, n, created_at, source, content) VALUES (2, 1, 1, 'initial', 'PRD 正文')").run();
  }
  return db;
}

interface StubOpts {
  enabled?: boolean;
  outline?: (call: number) => string | Promise<string>;
  page?: (slug: string, call: number, prompt: string) => string | Promise<string>;
  onCall?: (prompt: string, opts: ChatArgs[1]) => void;
}

function makeLlm(o: StubOpts = {}) {
  const prompts: string[] = [];
  const pageCalls = new Map<string, number>();
  let outlineCalls = 0;
  let active = 0;
  let maxActive = 0;
  const llm: LlmPort = {
    enabled: o.enabled ?? true,
    chat: async (...args: ChatArgs): Promise<string> => {
      const [msgs, opts] = args;
      const prompt = msgs.map((m) => String(m.content)).join('\n');
      prompts.push(prompt);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        o.onCall?.(prompt, opts);
        if (prompt.includes('原型大纲')) {
          const i = outlineCalls++;
          return o.outline ? await o.outline(i) : OUTLINE_JSON;
        }
        const m = /<page>\n([\s\S]*?)\n<\/page>/.exec(prompt);
        const slug = m ? (JSON.parse(m[1]) as { slug: string }).slug : 'home';
        const i = (pageCalls.get(slug) ?? 0) + 1;
        pageCalls.set(slug, i);
        return o.page ? await o.page(slug, i, prompt) : `<main><div class="card">${slug}</div></main>`;
      } finally {
        active--;
      }
    },
  };
  return { llm, prompts, pageCalls, peak: () => maxActive, outlineCount: () => outlineCalls };
}

interface DepsOpts {
  status?: string;
  content?: string;
  missing?: boolean;
  limits?: Record<string, number>;
  onEvent?: (e: EventInput) => void;
}

function makeDeps(o: DepsOpts = {}) {
  return {
    prd: (id: number, n: number) =>
      o.missing || id < 1 || id > 2 || n !== 1
        ? null
        : { title: '律审通', content: o.content ?? 'PRD 正文', status: o.status ?? 'done' },
    limits: { pageConcurrency: 3, globalTasks: 2, taskMs: 5000, outlineTimeoutMs: 1000, pageTimeoutMs: 1000, ...o.limits },
    onEvent: o.onEvent,
  } as ConstructorParameters<typeof ProtoRunner>[2];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('首次生成：done、每页 HTML、进度 3/3 与 proto_create 事件', async () => {
  const db = setup();
  const events: EventInput[] = [];
  const stub = makeLlm();
  const runner = new ProtoRunner(db, stub.llm, makeDeps({ onEvent: (e) => events.push(e) }));
  runner.generate(1, 1);
  await runner.idle();
  const v = getVersion(db, 1, 1)!;
  assert.equal(v.status, 'done');
  assert.equal(v.pages.length, 3);
  assert.ok(v.pages.every((p) => p.html.includes('<div class="card">')));
  assert.deepEqual(v.progress, { stage: 'pages', done: 3, total: 3 });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'proto_create');
  assert.equal(events[0].refType, 'review');
  assert.equal(events[0].summary, '生成原型：律审通，3 页');
});

test('页面并发不超过 pageConcurrency', async () => {
  const db = setup();
  const stub = makeLlm({ page: async () => { await sleep(20); return '<main><div>x</div></main>'; } });
  const runner = new ProtoRunner(db, stub.llm, makeDeps({ limits: { pageConcurrency: 2 } }));
  runner.generate(1, 1);
  await runner.idle();
  assert.ok(stub.peak() <= 2, `peak=${stub.peak()}`);
  assert.equal(getVersion(db, 1, 1)!.status, 'done');
});

test('页面截断后重试一次，重试提示带「上次输出过长被截断」', async () => {
  const db = setup();
  const retryPrompts: string[] = [];
  const stub = makeLlm({
    page: (slug, call, prompt) => {
      if (slug === 'home' && call === 1) return '<main><div>';
      if (call > 1) retryPrompts.push(prompt);
      return `<main><div class="card">${slug}</div></main>`;
    },
  });
  const runner = new ProtoRunner(db, stub.llm, makeDeps());
  runner.generate(1, 1);
  await runner.idle();
  const v = getVersion(db, 1, 1)!;
  assert.equal(v.status, 'done');
  assert.equal(stub.pageCalls.get('home'), 2);
  assert.ok(v.pages.find((p) => p.slug === 'home')!.html.includes('home'));
  assert.ok(retryPrompts.some((p) => p.includes('上次输出过长被截断')));
});

test('部分页面失败仍为 done；全部失败为 error', async () => {
  const db = setup();
  const fail = makeLlm({ page: (slug) => { if (slug === 'detail') throw new Error('模型错误'); return `<main><div>${slug}</div></main>`; } });
  const runner = new ProtoRunner(db, fail.llm, makeDeps());
  runner.generate(1, 1);
  await runner.idle();
  const v = getVersion(db, 1, 1)!;
  assert.equal(v.status, 'done');
  const detail = v.pages.find((p) => p.slug === 'detail')!;
  assert.equal(detail.html, '');
  assert.ok(detail.error);

  const db2 = setup();
  const allFail = new ProtoRunner(db2, makeLlm({ page: () => { throw new Error('模型错误'); } }).llm, makeDeps());
  allFail.generate(1, 1);
  await allFail.idle();
  const v2 = getVersion(db2, 1, 1)!;
  assert.equal(v2.status, 'error');
  assert.equal(v2.error, '页面生成失败，请重试');
});

test('模型写在页面里的脚本与事件属性被清理后才入库', async () => {
  const db = setup();
  const stub = makeLlm({ page: (slug) => (slug === 'home' ? '<main><script>x</script><div onclick="y">ok</div></main>' : `<main><div>${slug}</div></main>`) });
  const runner = new ProtoRunner(db, stub.llm, makeDeps());
  runner.generate(1, 1);
  await runner.idle();
  assert.equal(getVersion(db, 1, 1)!.pages.find((p) => p.slug === 'home')!.html, '<div>ok</div>');
});

test('大纲两次失败：error「原型规划失败，请重试」', async () => {
  const db = setup();
  const stub = makeLlm({ outline: () => 'not json' });
  const runner = new ProtoRunner(db, stub.llm, makeDeps());
  runner.generate(1, 1);
  await runner.idle();
  const v = getVersion(db, 1, 1)!;
  assert.equal(v.status, 'error');
  assert.equal(v.error, '原型规划失败，请重试');
  assert.equal(stub.outlineCount(), 2);
});

test('总时限：未完成的页面记为「超时」，其余成功时版本仍为 done', async () => {
  const db = setup();
  const stub = makeLlm({ page: (slug) => (slug === 'me' ? new Promise<string>(() => {}) : `<main><div>${slug}</div></main>`) });
  const runner = new ProtoRunner(db, stub.llm, makeDeps({ limits: { taskMs: 60 } }));
  runner.generate(1, 1);
  await runner.idle();
  const v = getVersion(db, 1, 1)!;
  assert.equal(v.status, 'done');
  const me = v.pages.find((p) => p.slug === 'me')!;
  assert.equal(me.error, '超时');
  assert.equal(me.html, '');
});

test('评审在页面生成中被删除：不抛错、不写库、不发事件', async () => {
  const db = setup();
  const events: EventInput[] = [];
  const stub = makeLlm({
    page: (slug) => {
      if (slug === 'home') db.prepare('DELETE FROM pm_reviews WHERE id = 1').run();
      return `<main><div>${slug}</div></main>`;
    },
  });
  const runner = new ProtoRunner(db, stub.llm, makeDeps({ onEvent: (e) => events.push(e) }));
  runner.generate(1, 1);
  await runner.idle();
  assert.equal(getVersion(db, 1, 1), null);
  assert.equal(events.length, 0);
});

test('全站排队：globalTasks=1 时第二个版本先显示 queued，最终两个都成功', async () => {
  const db = setup('done', true);
  const stub = makeLlm({ page: async (slug) => { await sleep(15); return `<main><div>${slug}</div></main>`; } });
  const runner = new ProtoRunner(db, stub.llm, makeDeps({ limits: { globalTasks: 1 } }));
  runner.generate(1, 1);
  const second = runner.generate(2, 1);
  assert.equal(second.progress.stage, 'queued');
  assert.equal(listVersions(db, 2)[0].progress.stage, 'queued');
  await runner.idle();
  assert.equal(getVersion(db, 1, 1)!.status, 'done');
  assert.equal(getVersion(db, 2, 1)!.status, 'done');
});

test('同一评审已有 running 时再次 generate 报 409', async () => {
  const db = setup();
  const runner = new ProtoRunner(db, makeLlm().llm, makeDeps());
  runner.generate(1, 1);
  assert.throws(() => runner.generate(1, 1), (e: unknown) => e instanceof ProtoError && e.status === 409 && e.message === '原型正在生成');
  await runner.idle();
});

test('前置检查：模型未配置 503、版本不存在 400、评审未完成 409', () => {
  const db = setup();
  assert.throws(() => new ProtoRunner(db, makeLlm({ enabled: false }).llm, makeDeps()).generate(1, 1),
    (e: unknown) => e instanceof ProtoError && e.status === 503 && e.message === '未配置模型，无法生成原型');
  assert.throws(() => new ProtoRunner(db, makeLlm().llm, makeDeps({ missing: true })).generate(1, 1),
    (e: unknown) => e instanceof ProtoError && e.status === 400 && e.message === '文档版本不存在');
  const other = setup('reviewing');
  assert.throws(() => new ProtoRunner(other, makeLlm().llm, makeDeps({ status: 'reviewing' })).generate(1, 1),
    (e: unknown) => e instanceof ProtoError && e.status === 409 && e.message === '评审还没完成');
});

test('PRD 截断：大纲提示词的 PRD 不超过 12000 字，并带「后文已截断」', async () => {
  const db = setup();
  let outlinePromptText = '';
  const stub = makeLlm({ onCall: (p) => { if (p.includes('原型大纲') && !outlinePromptText) outlinePromptText = p; } });
  const runner = new ProtoRunner(db, stub.llm, makeDeps({ content: '长'.repeat(15000) }));
  runner.generate(1, 1);
  await runner.idle();
  const m = /<prd>\n([\s\S]*?)\n<\/prd>/.exec(outlinePromptText)!;
  assert.ok([...m[1]].length <= 12000);
  assert.ok(outlinePromptText.includes('后文已截断'));
});
