// 知识库公共类型、错误与上限

export class KbError extends Error {
  status: number;
  docId?: number;
  constructor(status: number, message: string, docId?: number) {
    super(message);
    this.status = status;
    if (docId !== undefined) this.docId = docId;
  }
}

export const KB_LIMITS = {
  docs: 2000,
  bodyChars: 200_000,
  totalBytes: 1024 * 1024 * 1024,
  fileMax: 10 * 1024 * 1024,
  folders: 200,
  depth: 5,
  folderName: 40,
  title: 120,
  chunkTarget: 800,
  chunkMax: 1200,
  chunksPerDoc: 400,
  refreshBatch: 20,
  recallLimit: 5,
  recallPerDoc: 2,
  recallBudget: 2500,
  suggestChars: 1500,
  suggestPaths: 200,
  suggestTimeoutMs: 15_000,
  mcpPage: 8000,
};

export type DocKind = 'upload' | 'review' | 'item' | 'note';
export type DocStatus = 'processing' | 'ready' | 'error' | 'orphan';

/** 评审引用的知识库段落；title / heading 为召回时的快照 */
export interface KbRef {
  doc: number;
  ord: number;
  title: string;
  heading: string;
  /** Wiki 页面的 slug；有值时 doc / ord 为 0 */
  wiki?: string;
}

export const len = (s: string): number => [...s].length;
export const clipCp = (s: string, n: number): string => {
  const cps = [...s];
  return cps.length > n ? cps.slice(0, n).join('') : s;
};
