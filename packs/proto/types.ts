/** 原型（PRD 转 HTML 原型）的公共类型与上限。上限集中在 PROTO_LIMITS，其他模块不另写数字 */

export type Device = 'phone' | 'desktop';
export const DEVICES: readonly Device[] = ['phone', 'desktop'];
export const THEMES = ['blue', 'green', 'violet', 'orange', 'slate', 'rose'] as const;
export type Theme = (typeof THEMES)[number];

export interface OutlinePage {
  slug: string;
  title: string;
  purpose: string;
  content: string;
  links: string[];
}

export interface Outline {
  product: string;
  device: Device;
  theme: Theme;
  nav: string[];
  data: Record<string, unknown>;
  pages: OutlinePage[];
}

export interface ProtoPage {
  slug: string;
  title: string;
  html: string;
  error: string | null;
}

export interface Progress {
  stage: 'queued' | 'outline' | 'plan' | 'pages';
  done: number;
  total: number;
}

export type ProtoStatus = 'running' | 'done' | 'error';

export interface ProtoRow {
  id: number;
  review_id: number;
  n: number;
  created_at: number;
  finished_at: number | null;
  status: ProtoStatus;
  base_version_n: number;
  from_n: number | null;
  request: string;
  note: string;
  progress: Progress;
  outline: Outline | null;
  pages: ProtoPage[];
  error: string | null;
}

export type ProtoMeta = Omit<ProtoRow, 'outline' | 'pages'> & {
  product: string | null;
  device: Device | null;
  pages: { slug: string; title: string; error: string | null }[];
};

export class ProtoError extends Error {
  status: 400 | 404 | 409 | 503;
  constructor(status: 400 | 404 | 409 | 503, message: string) {
    super(message);
    this.status = status;
  }
}

export const PROTO_LIMITS = {
  prdOutlineChars: 12000,
  prdPageChars: 6000,
  requestMax: 1000,
  pagesMax: 10,
  slugRe: /^[a-z0-9-]{1,32}$/,
  titleMax: 20,
  purposeMax: 400,
  productMax: 20,
  navMax: 5,
  dataBytes: 4096,
  pageBytes: 40960,
  docBytes: 409600,
  taskMs: 480000,
  pageConcurrency: 3,
  globalTasks: 2,
  versionsMax: 20,
  revisePagesMax: 10,
  outlineTokens: 3000,
  pageTokens: 6000,
  outlineTimeoutMs: 120000,
  pageTimeoutMs: 180000,
  summaryChars: 300,
};
export type ProtoLimits = typeof PROTO_LIMITS;

export const RESTART_MSG = '服务重启，生成中断，请重试';
