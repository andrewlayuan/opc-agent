// 体检（Task 8 实现）
import type { DB } from '../../packages/core/db.ts';
import type { Llm } from '../../packages/core/llm.ts';
import type { PageChange } from './store.ts';

export async function runLint(_db: DB, _llm: Llm, _opId: number, _o: { maxCalls?: number } = {}): Promise<{ llmCalls: number; note: string; changes: PageChange[] }> {
  return { llmCalls: 0, note: JSON.stringify({ issues: [], fixOp: null }), changes: [] };
}
