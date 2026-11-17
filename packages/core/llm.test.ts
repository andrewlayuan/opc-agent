import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Llm, type ChatMessage } from './llm.ts';

type Reply = { content: string; finish: string };

function fake(replies: Reply[]) {
  const seen: { messages: ChatMessage[]; max_tokens: number }[] = [];
  const post = async (_url: string, _h: Record<string, string>, body: unknown) => {
    const b = body as { messages: ChatMessage[]; max_tokens: number };
    seen.push({ messages: b.messages, max_tokens: b.max_tokens });
    const r = replies.shift();
    if (!r) throw new Error('no more replies');
    return { status: 200, text: '', json: { choices: [{ message: { content: r.content }, finish_reason: r.finish }] } };
  };
  const llm = new Llm({ apiKey: 'k', baseUrl: 'https://api.example.com', model: 'm', concurrency: 1 }, post);
  return { llm, seen };
}

const ask: ChatMessage[] = [{ role: 'user', content: '写长文' }];

test('chatLong：输出被截断时从断点续写并拼接，最终完整则不标记截断', async () => {
  const { llm, seen } = fake([
    { content: '第一段', finish: 'length' },
    { content: '第二段', finish: 'length' },
    { content: '结尾', finish: 'stop' },
  ]);
  const r = await llm.chatLong(ask, { maxTokens: 100 });
  assert.deepEqual(r, { content: '第一段第二段结尾', truncated: false });
  assert.equal(seen.length, 3);
  const second = seen[1].messages;
  assert.deepEqual(second.slice(0, 1), ask);
  assert.deepEqual(second[1], { role: 'assistant', content: '第一段' });
  assert.equal(second[2].role, 'user');
  assert.match(String(second[2].content), /接着写/);
  assert.deepEqual(seen[2].messages[1], { role: 'assistant', content: '第一段第二段' });
  assert.ok(seen.every((s) => s.max_tokens === 100));
});

test('chatLong：续写次数用尽仍未写完时标记截断', async () => {
  const { llm, seen } = fake([
    { content: 'a', finish: 'length' },
    { content: 'b', finish: 'length' },
    { content: 'c', finish: 'length' },
  ]);
  const r = await llm.chatLong(ask, { maxTokens: 10 });
  assert.deepEqual(r, { content: 'abc', truncated: true });
  assert.equal(seen.length, 3, '默认最多续写 2 次');
});

test('chatLong：一次写完不续写；chat 仍只返回文本', async () => {
  const { llm, seen } = fake([{ content: '完整', finish: 'stop' }, { content: '单次', finish: 'length' }]);
  assert.deepEqual(await llm.chatLong(ask, {}), { content: '完整', truncated: false });
  assert.equal(await llm.chat(ask, {}), '单次');
  assert.equal(seen.length, 2);
});
