// LLM Wiki 公共类型、错误与上限

export class WikiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type PageKind = 'source' | 'entity' | 'concept' | 'compare' | 'overview' | 'answer' | 'trend';
export const PAGE_KINDS: readonly PageKind[] = ['source', 'entity', 'concept', 'compare', 'overview', 'answer', 'trend'];
export const KIND_LABEL: Record<PageKind, string> = {
  source: '资料摘要',
  entity: '实体',
  concept: '概念',
  compare: '对比',
  overview: '总览',
  answer: '问答',
  trend: '趋势',
};

/** ask 只用来计入每日额度，不能撤销 */
export type OpKind = 'ingest' | 'lint' | 'fix' | 'generate' | 'query_save' | 'edit' | 'restore' | 'revert' | 'ask' | 'organize' | 'trend';
export type OpStatus = 'queued' | 'running' | 'done' | 'error' | 'reverted';

const MB = 1024 * 1024;

export const WIKI_LIMITS = {
  pages: 3000,
  bodyChars: 20_000,
  titleChars: 120,
  summaryChars: 200,
  revisionsKept: 50,
  assetMax: 5 * MB,
  ingestPages: 15,
  writeBatch: 3,
  dailyCalls: 200,
  lintCalls: 20,
  recallWikiBudget: 1500,
  recallSrcBudget: 1500,
  askSrcBudget: 4000,
  exportMax: 200 * MB,
  mcpPage: 8000,
  slugMax: 80,
  candidates: 40,
  askIndex: 60,
  chunkLimit: 100_000,
  chunkPart: 30_000,
  questionChars: 500,
  nodes: 200,
  nodeDepth: 3,
  nodeTitle: 40,
  ingestNewNodes: 5,
  organizeBatch: 100,
  organizeCalls: 10,
  trendCalls: 12,
  trendMinPages: 3,
  trendMinItems: 5,
  trendDays: 30,
  trendItems: 40,
  trendPages: 25,
};

export const isPageKind = (v: unknown): v is PageKind => typeof v === 'string' && (PAGE_KINDS as readonly string[]).includes(v);
