import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';
import type { Llm } from '../../packages/core/llm.ts';
import { MemoryKeeper } from './consolidate.ts';
import { SkillKeeper } from './crystallize.ts';
import type { CrystalRun } from './crystallize.ts';
import { MemoryError } from './store.ts';
import type { Clock, ConsolidateResult } from './consolidate.ts';
import { recordEvent } from './events.ts';

const T = 1_800_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;

interface Timer {
  at: number;
  every: number;
  fn: () => void;
}
function fakeClock() {
  let now = T;
  const timers = new Set<Timer>();
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  const clock: Clock & { advance(ms: number): Promise<void>; count(): number } = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const t = { at: now + ms, every: 0, fn };
      timers.add(t);
      return t;
    },
    clearTimeout: (h) => void timers.delete(h as Timer),
    setInterval: (fn, ms) => {
      const t = { at: now + ms, every: ms, fn };
      timers.add(t);
      return t;
    },
    clearInterval: (h) => void timers.delete(h as Timer),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        if (next.every) next.at += next.every;
        else timers.delete(next);
        next.fn();
        await flush();
      }
      now = end;
      await flush();
    },
    count: () => timers.size,
  };
  return clock;
}

function setup(enabled = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-keep-'));
  const db = openDb(path.join(dir, 't.db'));
  const clock = fakeClock();
  let calls = 0;
  const run = async (): Promise<ConsolidateResult> => {
    calls++;
    const n = Number(db.prepare('UPDATE events SET consumed_at = 1 WHERE consumed_at IS NULL').run().changes);
    return { events: n, applied: 0, profile: false, skipped: 0 };
  };
  const keeper = new MemoryKeeper(db, { enabled } as unknown as Llm, { clock, run, log: () => {} });
  return { db, clock, keeper, calls: () => calls, done: () => (keeper.stop(), db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}
const ev = (db: DB, clock: { now(): number }, kind: 'item_star' | 'review_create' | 'turn_ask', refId: number) =>
  recordEvent(db, { kind, refType: kind === 'item_star' ? 'item' : 'review', refId, summary: 's' }, clock.now());

test('PM 事件 60 秒后整理一次，期间的事件并入同一次', async () => {
  const { db, clock, keeper, calls, done } = setup();
  ev(db, clock, 'review_create', 1);
  keeper.notify('review_create');
  await clock.advance(30 * SEC);
  ev(db, clock, 'turn_ask', 1);
  keeper.notify('turn_ask');
  assert.equal(calls(), 0);
  await clock.advance(30 * SEC);
  assert.equal(calls(), 1);
  await clock.advance(5 * MIN);
  assert.equal(calls(), 1);
  done();
});

test('雷达事件满 10 条立即整理；不足时最早一条满 30 分钟由 5 分钟检查触发', async () => {
  const { db, clock, keeper, calls, done } = setup();
  keeper.start();
  await clock.advance(31 * SEC);
  for (let i = 1; i <= 9; i++) {
    ev(db, clock, 'item_star', i);
    keeper.notify('item_star');
  }
  await clock.advance(1);
  assert.equal(calls(), 0);
  ev(db, clock, 'item_star', 10);
  keeper.notify('item_star');
  await clock.advance(1);
  assert.equal(calls(), 1);

  ev(db, clock, 'item_star', 11);
  keeper.notify('item_star');
  await clock.advance(25 * MIN);
  assert.equal(calls(), 1);
  await clock.advance(10 * MIN);
  assert.equal(calls(), 2);
  done();
});

test('运行中再次触发只补跑一次', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-keep-'));
  const db = openDb(path.join(dir, 't.db'));
  let calls = 0;
  let release: () => void = () => {};
  const run = async (): Promise<ConsolidateResult> => {
    calls++;
    if (calls === 1) await new Promise<void>((r) => (release = r));
    return { events: 1, applied: 0, profile: false, skipped: 0 };
  };
  const keeper = new MemoryKeeper(db, { enabled: true } as unknown as Llm, { clock: fakeClock(), run, log: () => {} });
  const p1 = keeper.runNow();
  await new Promise((r) => setImmediate(r));
  assert.equal(keeper.running, true);
  const p2 = keeper.runNow();
  const p3 = keeper.runNow();
  release();
  await Promise.all([p1, p2, p3]);
  assert.equal(calls, 2);
  assert.equal(keeper.running, false);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('start：有未整理事件 30 秒后整理；stop 清掉所有定时器', async () => {
  const { db, clock, keeper, calls, done } = setup();
  ev(db, clock, 'item_star', 1);
  keeper.start();
  await clock.advance(29 * SEC);
  assert.equal(calls(), 0);
  await clock.advance(1 * SEC);
  assert.equal(calls(), 1);
  ev(db, clock, 'review_create', 2);
  keeper.notify('review_create');
  keeper.stop();
  assert.equal(clock.count(), 0);
  done();
});

test('模型未启用：notify 与 start 不安排任何定时器', async () => {
  const { db, clock, keeper, calls, done } = setup(false);
  for (let i = 1; i <= 12; i++) ev(db, clock, 'item_star', i);
  keeper.start();
  keeper.notify('item_star');
  keeper.notify('review_create');
  assert.equal(clock.count(), 0);
  await clock.advance(60 * MIN);
  assert.equal(calls(), 0);
  done();
});

test('stop 之后 notify 不再安排定时器', async () => {
  const { db, clock, keeper, done } = setup();
  keeper.start();
  keeper.stop();
  ev(db, clock, 'review_create', 1);
  keeper.notify('review_create');
  for (let i = 1; i <= 10; i++) ev(db, clock, 'item_star', i);
  keeper.notify('item_star');
  assert.equal(clock.count(), 0);
  assert.equal(keeper.running, false);
  done();
});

test('定时器回调里数据库出错只记日志，不抛出', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-keep-'));
  const db = openDb(path.join(dir, 't.db'));
  const clock = fakeClock();
  const logs: string[] = [];
  const keeper = new MemoryKeeper(db, { enabled: true } as unknown as Llm, { clock, run: async () => ({ events: 0, applied: 0, profile: false, skipped: 0 }), log: (s) => logs.push(s) });
  keeper.start();
  db.close();
  await clock.advance(6 * MIN);
  assert.ok(logs.length >= 2, logs.join('\n'));
  keeper.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('巡检：任何类型的未整理事件最早一条满 30 分钟都会触发（覆盖整理失败的产品顾问事件）', async () => {
  const { db, clock, keeper, calls, done } = setup();
  keeper.start();
  await clock.advance(31 * SEC);
  ev(db, clock, 'review_create', 1);
  await clock.advance(25 * MIN);
  assert.equal(calls(), 0);
  await clock.advance(10 * MIN);
  assert.equal(calls(), 1);
  done();
});

test('MemoryKeeper：每次整理跑完调用 after，传入最后一次结果；出错只记日志', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-keep-'));
  const db = openDb(path.join(dir, 't.db'));
  const seen: ConsolidateResult[] = [];
  const logs: string[] = [];
  let boom = false;
  const run = async (): Promise<ConsolidateResult> => ({ events: 1, applied: 1, profile: false, skipped: 0 });
  const after = (r: ConsolidateResult) => {
    seen.push(r);
    if (boom) throw new Error('炸了');
  };
  const keeper = new MemoryKeeper(db, { enabled: true } as unknown as Llm, { clock: fakeClock(), run, after, log: (s) => logs.push(s) });
  await keeper.runNow();
  assert.deepEqual(seen, [{ events: 1, applied: 1, profile: false, skipped: 0 }]);
  boom = true;
  await keeper.runNow();
  assert.equal(seen.length, 2);
  assert.ok(logs.some((s) => s.includes('炸了')));
  keeper.stop();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function skillSetup(o: { enabled?: boolean; llm?: boolean; dailyCalls?: number; events?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-skeep-'));
  const db = openDb(path.join(dir, 't.db'));
  if (o.events !== 0) recordEvent(db, { kind: 'item_star', refType: 'item', refId: 1, summary: 's' }, Date.now());
  const forces: boolean[] = [];
  let release: () => void = () => {};
  let hold = false;
  let fail = false;
  const run = async (force: boolean): Promise<CrystalRun> => {
    forces.push(force);
    if (hold) await new Promise<void>((r) => (release = r));
    if (fail) throw new Error('数据库坏了');
    return { ran: true, added: 1, updated: 0, blocked: 0, dropped: 0 };
  };
  const logs: string[] = [];
  const keeper = new SkillKeeper(db, { enabled: o.llm ?? true } as unknown as Llm, { enabled: o.enabled ?? true, dailyCalls: o.dailyCalls ?? 12, run, log: (s) => logs.push(s) });
  return {
    keeper,
    forces,
    logs,
    hold: (v: boolean) => (hold = v),
    fail: (v: boolean) => (fail = v),
    release: () => release(),
    done: () => (keeper.stop(), db.close(), fs.rmSync(dir, { recursive: true, force: true })),
  };
}
const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

test('SkillKeeper：开关关、模型未配置、每日次数为 0 时 notify 不跑，runNow 返回 409', async () => {
  for (const o of [{ enabled: false }, { llm: false }, { dailyCalls: 0 }]) {
    const k = skillSetup(o);
    assert.equal(k.keeper.enabled, false);
    k.keeper.notify();
    await tick();
    assert.deepEqual(k.forces, []);
    await assert.rejects(k.keeper.runNow(), (e: unknown) => e instanceof MemoryError && e.status === 409);
    k.done();
  }
});

test('SkillKeeper：notify 按条件跑（不强制）；运行中再 notify 不重复；runNow 强制并复用进行中的那次', async () => {
  const k = skillSetup();
  k.hold(true);
  k.keeper.notify();
  await tick();
  assert.equal(k.keeper.running, true);
  k.keeper.notify();
  const p = k.keeper.runNow();
  await tick();
  assert.deepEqual(k.forces, [false]);
  k.release();
  assert.equal((await p).added, 1);
  assert.equal(k.keeper.running, false);
  k.hold(false);
  assert.equal((await k.keeper.runNow()).ran, true);
  assert.deepEqual(k.forces, [false, true]);
  k.done();
});

test('SkillKeeper：notify 里出错只记日志；stop 之后 notify 不再跑', async () => {
  const k = skillSetup();
  k.fail(true);
  k.keeper.notify();
  await tick();
  assert.ok(k.logs.some((s) => s.includes('数据库坏了')));
  assert.equal(k.keeper.running, false);
  k.fail(false);
  k.keeper.stop();
  k.keeper.notify();
  await tick();
  assert.equal(k.forces.length, 1);
  k.done();
});

test('SkillKeeper：runNow 先查当日次数与新事件，不满足时 409 带原因；last 记录最近一次结果与出错', async () => {
  const k = skillSetup({ events: 0 });
  await assert.rejects(k.keeper.runNow(), (e: unknown) => e instanceof MemoryError && e.status === 409 && e.message === '没有新事件');
  assert.equal(k.keeper.last, null);
  k.done();
  const k2 = skillSetup();
  await k2.keeper.runNow();
  assert.equal(k2.keeper.last?.run?.added, 1);
  k2.fail(true);
  await assert.rejects(k2.keeper.runNow(), /数据库坏了/);
  assert.equal(k2.keeper.last?.error, '数据库坏了');
  k2.done();
});
