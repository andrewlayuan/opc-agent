// Wiki 测试工具：临时库、种子资料、按顺序回复的模型桩
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';
import { Llm } from '../../packages/core/llm.ts';
import type { ChatMessage, ChatOptions } from '../../packages/core/llm.ts';
import { createDoc } from '../kb/docs.ts';

export function tmpWikiDb(): { db: DB; dir: string; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-wiki-'));
  const db = openDb(path.join(dir, 't.db'));
  return { db, dir, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}

export const seedDoc = (db: DB, title: string, md: string): number => createDoc(db, { kind: 'note', title, body: md });

export type Reply = string | Error | ((msgs: ChatMessage[]) => string);

/** 按顺序返回预设回复；chat、chatLong、json 共用一个队列。回复为 Error 时抛出 */
export function stubLlm(replies: Reply[]): Llm & { calls: ChatMessage[][] } {
  const queue = [...replies];
  const calls: ChatMessage[][] = [];
  const llm = new Llm({ apiKey: 'test', baseUrl: 'https://llm.test', model: 'm', concurrency: 1 }, async () => {
    throw new Error('stubLlm 不应发起网络请求');
  }) as Llm & { calls: ChatMessage[][] };
  const next = (msgs: ChatMessage[]): string => {
    calls.push(msgs);
    const r = queue.shift();
    if (r === undefined) throw new Error('stubLlm：回复已用完');
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(msgs) : r;
  };
  llm.calls = calls;
  llm.chat = async (msgs: ChatMessage[], _o?: ChatOptions) => next(msgs);
  llm.chatLong = async (msgs: ChatMessage[], _o?: ChatOptions) => ({ content: next(msgs), truncated: false });
  // json() 内部调用 this.chat，自动走上面的队列
  return llm;
}
