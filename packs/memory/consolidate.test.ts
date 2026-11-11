import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateOps } from './consolidate.ts';
import type { OpsState } from './consolidate.ts';

function st(over: Partial<OpsState> = {}): OpsState {
  return {
    memories: new Map([
      [1, { kind: 'fact', content: '在做律所合同审查工具', manual: false }],
      [2, { kind: 'preference', content: '喜欢短句', manual: true }],
    ]),
    profile: '旧画像',
    rejected: [],
    batchIds: [10, 11],
    ...over,
  };
}

test('validateOps：结构错误按空结果处理', () => {
  for (const out of [null, 'x', 3, [], { ops: 'x', profile: 5 }, { ops: [null, 3, 'a', { op: 'merge' }] }]) {
    assert.deepEqual(validateOps(out, st()), { ops: [], profile: null });
  }
});

test('validateOps：非法 kind、不存在的 id、超长内容、手动条目删除都被丢弃', () => {
  const r = validateOps(
    {
      ops: [
        { op: 'add', kind: 'mood', content: '心情好' },
        { op: 'add', kind: 'fact', content: '' },
        { op: 'add', kind: 'fact', content: 'x'.repeat(201) },
        { op: 'update', id: 99, content: '不存在' },
        { op: 'update', id: '1', content: '字符串 id' },
        { op: 'update', id: 1, kind: 'bad', content: '错误类型' },
        { op: 'delete', id: 2, reason: '手动条目' },
        { op: 'delete', id: 99 },
        { op: 'add', kind: 'interest', content: '  关注  端侧模型 ', reason: '多次收藏' },
      ],
    },
    st(),
  );
  assert.deepEqual(r.ops, [{ op: 'add', kind: 'interest', content: '关注 端侧模型', reason: '多次收藏', events: [10, 11] }]);
});

test('validateOps：update 不带 kind 沿用原值；内容不变的 update 丢弃', () => {
  const r = validateOps(
    {
      ops: [
        { op: 'update', id: 2, content: '喜欢短句' },
        { op: 'update', id: 1, content: '在做中小律所合同审查 SaaS', reason: '补充' },
      ],
    },
    st(),
  );
  assert.deepEqual(r.ops, [{ op: 'update', id: 1, kind: 'fact', content: '在做中小律所合同审查 SaaS', reason: '补充' }]);
});

test('validateOps：同一 id 只取第一个；重复 add（含与已有条目相同）丢弃；与 rejected 相同的 add/update 丢弃', () => {
  const r = validateOps(
    {
      ops: [
        { op: 'update', id: 1, content: '第一次改' },
        { op: 'delete', id: 1 },
        { op: 'add', kind: 'fact', content: '喜欢短句' },
        { op: 'add', kind: 'decision', content: '先做小程序' },
        { op: 'add', kind: 'decision', content: '先做小程序' },
        { op: 'add', kind: 'decision', content: '要做 App' },
        { op: 'update', id: 2, content: '要做 App' },
      ],
    },
    st({ rejected: ['要做 App'] }),
  );
  assert.deepEqual(
    r.ops.map((o) => [o.op, 'content' in o ? o.content : o.id]),
    [
      ['update', '第一次改'],
      ['add', '先做小程序'],
    ],
  );
});

test('validateOps：敏感内容丢弃该条；画像含敏感信息则整份不改', () => {
  const r = validateOps({ ops: [{ op: 'add', kind: 'fact', content: '手机 13812345678' }], profile: '联系邮箱 a@b.com' }, st());
  assert.deepEqual(r, { ops: [], profile: null });
});

test('validateOps：最多 8 条；reason 截到 120 字；add.events 只保留本批 id，为空时取本批全部', () => {
  const ops = Array.from({ length: 12 }, (_, i) => ({ op: 'add', kind: 'fact', content: `事实${i}`, reason: '因'.repeat(200), events: i === 0 ? [10, 99] : [] }));
  const r = validateOps({ ops }, st());
  assert.equal(r.ops.length, 8);
  const first = r.ops[0] as { reason: string; events: number[] };
  assert.equal([...first.reason].length, 120);
  assert.deepEqual(first.events, [10]);
  assert.deepEqual((r.ops[1] as { events: number[] }).events, [10, 11]);
});

test('validateOps：画像超 1500 字截断；空串或与当前相同为 null', () => {
  assert.equal([...(validateOps({ ops: [], profile: '画'.repeat(1600) }, st()).profile ?? '')].length, 1500);
  assert.equal(validateOps({ ops: [], profile: '  ' }, st()).profile, null);
  assert.equal(validateOps({ ops: [], profile: ' 旧画像 ' }, st()).profile, null);
  assert.equal(validateOps({ ops: [], profile: null }, st()).profile, null);
  assert.equal(validateOps({ ops: [], profile: '## 身份\n独立开发者' }, st()).profile, '## 身份\n独立开发者');
});
