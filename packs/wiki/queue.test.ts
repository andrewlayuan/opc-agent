import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DB } from '../../packages/core/db.ts';
import { realClock } from '../memory/consolidate.ts';
import { docHash } from './ingest.ts';
import type { IngestResult } from './ingest.ts';
import { WikiQueue, defaultBusy } from './queue.ts';
import { createOp, finishOp, getOp, tx, writePages } from './store.ts';
import { seedDoc, stubLlm, tmpWikiDb } from './testutil.ts';

const ops = (db: DB, where = '1=1') => db.prepare(`SELECT id, kind, doc_id, status, llm_calls, error FROM wiki_ops WHERE ${where} ORDER BY id`).all() as Record<string, unknown>[];
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

function setup(o: { now?: number; busy?: () => boolean; dailyCalls?: number; ingest?: (db: DB, opId: number, docId: number) => Promise<IngestResult> } = {}) {
  const env = tmpWikiDb();
  let now = o.now ?? local(2026, 11, 17, 10);
  const ran: string[] = [];
  const ok = (calls: number) => async (db: DB, opId: number, docId?: number): Promise<IngestResult> => {
    ran.push(`ingest:${docId}`);
    tx(db, () => {
      finishOp(db, opId, { status: 'done', llmCalls: calls, now });
      db.prepare(
        "INSERT INTO wiki_docs(doc_id, body_hash, state, fails, ingested_at) VALUES (?, ?, 'done', 0, ?) ON CONFLICT(doc_id) DO UPDATE SET body_hash = excluded.body_hash, state = 'done', fails = 0",
      ).run(docId!, docHash(db, docId!), now);
    });
    return { changes: [], llmCalls: calls, note: '' };
  };
  const q = new WikiQueue(env.db, stubLlm([]), {
    clock: { ...realClock, now: () => now },
    log: () => {},
    busy: o.busy ?? (() => false),
    dailyCalls: o.dailyCalls ?? 200,
    run: {
      ingest: (_llm, opId, docId) => (o.ingest ?? ok(5))(env.db, opId, docId),
      lint: async (_llm, opId) => {
        ran.push('lint');
        finishOp(env.db, opId, { status: 'done', llmCalls: 1, now, note: JSON.stringify({ issues: [{ type: 'orphan' }], fixOp: null }) });
        return { changes: [], llmCalls: 1, note: '' };
      },
      generate: async (_llm, opId, slug) => {
        ran.push(`generate:${slug}`);
        finishOp(env.db, opId, { status: 'done', llmCalls: 1, now });
        return { changes: [], llmCalls: 1, note: '' };
      },
      organize: async (_llm, opId) => {
        ran.push('organize');
        finishOp(env.db, opId, { status: 'done', llmCalls: 1, now });
        return { llmCalls: 1, note: '' };
      },
      trend: async (_llm, opId) => {
        ran.push('trend');
        finishOp(env.db, opId, { status: 'done', llmCalls: 1, now });
        return { llmCalls: 1, note: '' };
      },
    },
  });
  return { ...env, q, ran, setNow: (t: number) => (now = t) };
}

const seedPage = (db: DB) =>
  tx(db, () => {
    const id = createOp(db, 'edit', { status: 'running' });
    finishOp(db, id, { status: 'done', pages: writePages(db, id, [{ slug: 'p', kind: 'concept', title: 'P', summary: '', body: 'x' }]).changes });
  });

test('scan：新资料入队一次；重复 scan 不重复入队；非 ready 不入队', () => {
  const { db, q, done } = setup();
  const a = seedDoc(db, '甲', '## 一\n内容甲');
  const b = seedDoc(db, '乙', '## 一\n内容乙');
  db.prepare("UPDATE kb_docs SET status = 'processing' WHERE id = ?").run(b);
  assert.equal(q.scan(), 1);
  assert.equal(q.scan(), 0);
  assert.deepEqual(ops(db).map((o) => [o.kind, o.doc_id, o.status]), [['ingest', a, 'queued']]);
  done();
});

test('drain：执行排队任务；已编入且哈希不变的资料不再入队；原文变化后重新入队', async () => {
  const { db, q, ran, done } = setup();
  const a = seedDoc(db, '甲', '## 一\n内容甲');
  await q.tick();
  assert.deepEqual(ran, [`ingest:${a}`]);
  assert.equal(q.scan(), 0);
  db.prepare("UPDATE kb_chunks SET body = '新内容' WHERE doc_id = ?").run(a);
  db.prepare('UPDATE kb_docs SET updated_at = updated_at + 100000 WHERE id = ?').run(a);
  assert.equal(q.scan(), 1);
  done();
});

test('scan：已撤销的资料哈希不变时不入队；手动 enqueueIngest 会入队并清除撤销状态', () => {
  const { db, q, done } = setup();
  const a = seedDoc(db, '甲', '## 一\n内容甲');
  db.prepare("INSERT INTO wiki_docs(doc_id, body_hash, state, fails, ingested_at) VALUES (?, ?, 'reverted', 0, 0)").run(a, docHash(db, a));
  assert.equal(q.scan(), 0);
  const id = q.enqueueIngest(a, { manual: true });
  assert.equal(getOp(db, id)!.status, 'queued');
  assert.equal(q.enqueueIngest(a, { manual: true }), id, '已有排队任务时返回同一个');
  assert.equal(db.prepare('SELECT 1 FROM wiki_docs WHERE doc_id = ?').get(a), undefined);
  done();
});

test('失败 3 次后不再自动入队；原文变化后重新入队；失败记录调用次数', async () => {
  const { db, q, done } = setup({
    ingest: async () => {
      throw new Error('模型挂了');
    },
  });
  const a = seedDoc(db, '甲', '## 一\n内容甲');
  for (let i = 0; i < 3; i++) await q.tick();
  assert.equal(ops(db, "status = 'error'").length, 3);
  assert.equal(q.scan(), 0);
  assert.equal((db.prepare('SELECT fails FROM wiki_docs WHERE doc_id = ?').get(a) as { fails: number }).fails, 3);
  assert.equal(ops(db)[0].error, '模型挂了');
  db.prepare("UPDATE kb_chunks SET body = '新内容' WHERE doc_id = ?").run(a);
  assert.equal(q.scan(), 1);
  done();
});

test('drain：busy() 为 true 时不执行，变为 false 后执行', async () => {
  let busy = true;
  const { db, q, ran, done } = setup({ busy: () => busy });
  seedDoc(db, '甲', '## 一\n内容甲');
  await q.tick();
  assert.deepEqual(ran, []);
  busy = false;
  await q.tick();
  assert.equal(ran.length, 1);
  done();
});

test('drain：当天调用数达到上限后停止，次日 0 点后继续', async () => {
  const { db, q, ran, setNow, done } = setup({ dailyCalls: 8 });
  for (let i = 0; i < 3; i++) seedDoc(db, `资料${i}`, `## 一\n内容${i}`);
  await q.tick();
  assert.equal(ran.length, 2, '5 + 5 = 10 ≥ 8 后停止');
  assert.equal(q.status().usedToday, 10);
  setNow(local(2026, 11, 18, 0, 1));
  await q.tick();
  assert.equal(ran.length, 3);
  done();
});

test('recover：running 变为 error，资料随后能重新入队，队列不会卡住', async () => {
  const { db, q, ran, done } = setup();
  const a = seedDoc(db, '甲', '## 一\n内容甲');
  const id = createOp(db, 'ingest', { docId: a, status: 'running' });
  assert.equal(q.recover(), 1);
  assert.deepEqual({ ...ops(db)[0] }, { id, kind: 'ingest', doc_id: a, status: 'error', llm_calls: 0, error: '服务重启中断' });
  await q.tick();
  assert.deepEqual(ran, [`ingest:${a}`]);
  done();
});

test('每周体检：周一 03:05 入队一次，当天再 tick 不重复；Wiki 为空时不体检', async () => {
  const { db, q, ran, setNow, done } = setup({ now: local(2026, 11, 16, 3, 5) });
  await q.tick();
  assert.deepEqual(ran, [], 'Wiki 为空');
  seedPage(db);
  await q.tick();
  assert.deepEqual(ran, ['lint', 'trend'], '从没生成过趋势预测时一并入队');
  setNow(local(2026, 11, 16, 9));
  await q.tick();
  assert.deepEqual(ran, ['lint', 'trend']);
  await q.tick();
  assert.deepEqual(ran, ['lint', 'trend'], '同一周不重复');
  assert.equal(q.status().lastLint?.issues, 1);
  done();
});

test('每周体检：停机 9 天后启动立即补跑', async () => {
  const { db, q, ran, done } = setup({ now: local(2026, 11, 19, 10) });
  seedPage(db);
  db.prepare("INSERT INTO wiki_ops(kind, status, created_at) VALUES ('lint', 'done', ?)").run(local(2026, 11, 10, 3, 1));
  await q.tick();
  assert.deepEqual(ran, ['lint', 'trend']);
  done();
});

test('每周趋势预测：满 7 天才入队；Wiki 为空不入队；排队中不重复；失败可重试', async () => {
  const { db, q, setNow, done } = setup({ now: local(2026, 11, 16, 10) });
  assert.equal(q.maybeWeeklyTrend(), null, 'Wiki 为空');
  seedPage(db);
  db.prepare("INSERT INTO wiki_ops(kind, status, created_at) VALUES ('trend', 'done', ?)").run(local(2026, 11, 9, 11));
  assert.equal(q.maybeWeeklyTrend(), null, '上次在 6 天 23 小时前');
  setNow(local(2026, 11, 16, 11, 1));
  const id = q.maybeWeeklyTrend();
  assert.ok(id != null && id > 0, '满 7 天入队');
  assert.equal(getOp(db, id!)!.kind, 'trend');
  assert.equal(q.enqueueTrend(), id, '已有排队的不重复入队');
  assert.equal(q.maybeWeeklyTrend(), null, '排队中再检查不新增');
  db.prepare("UPDATE wiki_ops SET status = 'done' WHERE id = ?").run(id);
  assert.equal(q.maybeWeeklyTrend(), null, '刚生成过');
  db.prepare("UPDATE wiki_ops SET status = 'error' WHERE id = ?").run(id);
  const r = q.retry(id!);
  assert.notEqual(r, id);
  assert.deepEqual([getOp(db, r)!.kind, getOp(db, r)!.status], ['trend', 'queued']);
  done();
});

test('retry：只能重试 error 的操作，新任务与原任务同类型同资料；generate 保留页面名', async () => {
  const { db, q, ran, done } = setup();
  const a = seedDoc(db, '甲', '## 一\n内容甲');
  const bad = createOp(db, 'ingest', { docId: a, status: 'error' });
  const okOp = createOp(db, 'ingest', { docId: a, status: 'done' });
  assert.throws(() => q.retry(okOp), { status: 400 });
  const r = q.retry(bad);
  assert.deepEqual([getOp(db, r)!.kind, getOp(db, r)!.doc_id, getOp(db, r)!.status], ['ingest', a, 'queued']);
  db.prepare("UPDATE wiki_ops SET status = 'done' WHERE id = ?").run(r);
  const g = q.enqueueGenerate('长上下文');
  db.prepare("UPDATE wiki_ops SET status = 'error' WHERE id = ?").run(g);
  q.retry(g);
  await q.drain();
  assert.ok(ran.includes('generate:长上下文'));
  done();
});

test('docStates 与 status：排队和完成状态', async () => {
  const { db, q, done } = setup();
  const a = seedDoc(db, '甲', '## 一\n内容甲');
  q.scan();
  assert.equal(q.docStates().get(a), 'queued');
  assert.equal(q.status().queued, 1);
  await q.drain();
  assert.equal(q.docStates().get(a), 'done');
  done();
});

test('defaultBusy：有进行中的评审时为 true', () => {
  const { db, done } = tmpWikiDb();
  assert.equal(defaultBusy(db), false);
  db.prepare("INSERT INTO pm_reviews(created_at, updated_at, status, mode, input) VALUES (1, 1, 'running', 'idea', 'x')").run();
  assert.equal(defaultBusy(db), true);
  done();
});

// ---------------- 整理目录结构 ----------------

function setupOrganize(o: { organize?: (opId: number) => Promise<{ llmCalls: number; note: string }>; dailyCalls?: number } = {}) {
  const env = tmpWikiDb();
  const now = local(2026, 11, 17, 10);
  const ran: string[] = [];
  const q = new WikiQueue(env.db, stubLlm(['{}', '{}', '{}']), {
    clock: { ...realClock, now: () => now },
    log: () => {},
    busy: () => false,
    dailyCalls: o.dailyCalls ?? 200,
    run: {
      ingest: async () => ({ changes: [], llmCalls: 0, note: '' }),
      lint: async () => ({ llmCalls: 0 }),
      generate: async () => ({ changes: [], llmCalls: 0, note: '' }),
      trend: async () => ({ llmCalls: 0, note: '' }),
      organize: async (llm, opId) => {
        ran.push(`organize:${opId}`);
        await llm.chat([{ role: 'user', content: 'x' }]);
        const r = await (o.organize ?? (async () => ({ llmCalls: 1, note: '整理 0 个页面，新建 0 个节点' })))(opId);
        finishOp(env.db, opId, { status: 'done', llmCalls: r.llmCalls, note: r.note, now });
        return r;
      },
    },
  });
  return { ...env, q, ran };
}

test('enqueueOrganize：已有排队或进行中的整理时返回同一个 id；完成后可再入队', async () => {
  const { db, q, done } = setupOrganize();
  const a = q.enqueueOrganize();
  assert.equal(q.enqueueOrganize(), a);
  assert.equal(ops(db, "kind = 'organize'").length, 1);
  db.prepare("UPDATE wiki_ops SET status = 'running' WHERE id = ?").run(a);
  assert.equal(q.enqueueOrganize(), a);
  db.prepare("UPDATE wiki_ops SET status = 'done' WHERE id = ?").run(a);
  assert.notEqual(q.enqueueOrganize(), a);
  done();
});

test('drain：执行 organize 并把调用数计入 llm_calls（计入每日额度）', async () => {
  const { db, q, ran, done } = setupOrganize({ organize: async () => ({ llmCalls: 3, note: '整理 5 个页面，新建 2 个节点' }) });
  const id = q.enqueueOrganize();
  await q.drain();
  assert.deepEqual(ran, [`organize:${id}`]);
  const op = getOp(db, id)!;
  assert.equal(op.status, 'done');
  assert.equal(op.llm_calls, 3);
  assert.equal(q.status().usedToday, 3);
  done();
});

test('drain：organize 抛错 → 记为 error，调用数照记，错误信息写入；不影响后面的任务', async () => {
  const { db, q, done } = setupOrganize({
    organize: async () => {
      throw new Error('模型不可用');
    },
  });
  const id = q.enqueueOrganize();
  await q.drain();
  const op = getOp(db, id)!;
  assert.equal(op.status, 'error');
  assert.match(String(op.error), /模型不可用/);
  assert.equal(op.llm_calls, 1, '失败前已发出的调用也计入');
  done();
});

test('retry：失败的 organize 重新入队；非失败的不能重试', async () => {
  const { db, q, done } = setupOrganize({
    organize: async () => {
      throw new Error('boom');
    },
  });
  const id = q.enqueueOrganize();
  assert.throws(() => q.retry(id), /只能重试失败的操作/);
  await q.drain();
  const again = q.retry(id);
  assert.notEqual(again, id);
  assert.equal(getOp(db, again)!.kind, 'organize');
  assert.equal(getOp(db, again)!.status, 'queued');
  done();
});

test('recover：重启时运行中的 organize 标为失败，之后可再入队', () => {
  const { db, q, done } = setupOrganize();
  const id = q.enqueueOrganize();
  db.prepare("UPDATE wiki_ops SET status = 'running' WHERE id = ?").run(id);
  assert.equal(q.recover(), 1);
  assert.equal(getOp(db, id)!.status, 'error');
  assert.notEqual(q.enqueueOrganize(), id);
  done();
});
