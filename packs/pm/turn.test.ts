import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTurnMessages, normMode, parseTurn, pickHistory } from './turn.ts';
import type { TurnMsg } from './turn.ts';

const doc = '# 新版\n' + '内容'.repeat(150);

test('parseTurn：改写与回答两种标记，全角与半角方括号都识别', () => {
  assert.deepEqual(parseTurn(`[改写]\n${doc}\n---变更说明---\n重写了定价`, 'auto'), { kind: 'revise', doc, note: '重写了定价' });
  assert.deepEqual(parseTurn('【回答】\n因为滩头市场更小', 'auto'), { kind: 'ask', answer: '因为滩头市场更小' });
});

test('parseTurn：缺少标记时 auto 当回答、revise 当改写；缺少说明时用默认说明', () => {
  assert.equal(parseTurn('直接回答', 'auto').kind, 'ask');
  assert.deepEqual(parseTurn(doc, 'revise'), { kind: 'revise', doc, note: '根据你的要求修订' });
  assert.equal(parseTurn('[回答]\n只是解释', 'revise').kind, 'ask');
});

test('parseTurn：剥掉外层代码围栏、剔除 URL、过短内容视为失败', () => {
  const r = parseTurn('[改写]\n```markdown\n' + doc + ' https://x.com/a\n```\n---变更说明---\n改了', 'auto');
  assert.equal(r.kind, 'revise');
  assert.ok(r.kind === 'revise' && !r.doc.includes('```') && !r.doc.includes('https://'));
  assert.throws(() => parseTurn('[改写]\n太短', 'auto'), /模型没有返回完整文档/);
  const long = parseTurn('[回答]\n' + '长'.repeat(3000), 'auto');
  assert.ok(long.kind === 'ask' && long.answer.length === 1500);
  const note = parseTurn(`[改写]\n${doc}\n---变更说明---\n${'说'.repeat(200)}`, 'auto');
  assert.ok(note.kind === 'revise' && note.note.length === 80);
});

test('pickHistory：跳过失败和进行中的轮次，超出预算时丢弃最早的', () => {
  const m = (content: string, status: TurnMsg['status'] = 'done'): TurnMsg => ({ role: 'user', kind: 'ask', content, status });
  const out = pickHistory([m('a'.repeat(50)), m('err', 'error'), m('b'.repeat(50)), m('c'.repeat(50)), m('run', 'running')], 120);
  assert.deepEqual(out.map((x) => x.content[0]), ['b', 'c']);
});

test('buildTurnMessages：顺序正确，包含最新版全文，revise 时追加本轮要求', () => {
  const history: TurnMsg[] = [
    { role: 'user', kind: 'ask', content: '为什么', status: 'done' },
    { role: 'assistant', kind: 'ask', content: '因为', status: 'done' },
  ];
  const msgs = buildTurnMessages({ system: 'SYS', input: '原始需求', refsText: '[1] 标题', latestN: 3, latestDoc: 'DOC3', history, text: '改定价', mode: 'revise' });
  assert.deepEqual(msgs.map((x) => x.role), ['system', 'user', 'assistant', 'user', 'assistant', 'user']);
  assert.match(msgs[1].content, /原始需求[\s\S]*\[1\] 标题/);
  assert.match(msgs[2].content, /当前文档（v3）[\s\S]*DOC3/);
  assert.match(msgs[5].content, /改定价[\s\S]*本轮要求：输出改写后的完整文档/);
  const auto = buildTurnMessages({ system: 'S', input: 'i', refsText: '', latestN: 1, latestDoc: 'D', history: [], text: 't', mode: 'auto' });
  assert.ok(!auto.at(-1)!.content.includes('本轮要求'));
  assert.equal(normMode('revise'), 'revise');
  assert.equal(normMode('rm -rf'), 'auto');
  assert.equal(normMode(undefined), 'auto');
});

test('pickHistory：丢弃回答失败或仍在进行的那一轮提问', () => {
  const u = (content: string): TurnMsg => ({ role: 'user', kind: 'ask', content, status: 'done' });
  const a = (content: string, status: TurnMsg['status'] = 'done'): TurnMsg => ({ role: 'assistant', kind: 'ask', content, status });
  const out = pickHistory([u('问1'), a('答1'), u('问2'), a('', 'error'), u('问3'), a('答3'), u('问4'), a('', 'running')]);
  assert.deepEqual(out.map((x) => x.content), ['问1', '答1', '问3', '答3']);
});

test('buildTurnMessages：合并相邻的同角色消息，保证 user/assistant 交替', () => {
  const msgs = buildTurnMessages({
    system: 'S', input: 'i', refsText: '', latestN: 1, latestDoc: 'D', text: '本轮', mode: 'auto',
    history: [
      { role: 'assistant', kind: 'ask', content: '被截断后剩下的回答', status: 'done' },
      { role: 'user', kind: 'ask', content: '上一问', status: 'done' },
    ],
  });
  const roles = msgs.map((x) => x.role);
  for (let i = 1; i < roles.length; i++) assert.notEqual(roles[i], roles[i - 1], `第 ${i} 条与前一条同为 ${roles[i]}`);
  assert.match(msgs[2].content, /当前文档（v1）[\s\S]*被截断后剩下的回答/);
  assert.match(msgs.at(-1)!.content, /上一问[\s\S]*本轮/);
});
