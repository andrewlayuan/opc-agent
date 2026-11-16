/** 原型生成任务：同步建版本、后台执行、全站排队与有限重试（spec 4） */
import type { DB } from '../../packages/core/db.ts';
import type { EventInput } from '../memory/events.ts';
import type { LlmPort } from '../pm/ingest.ts';
import { assemble } from './assemble.ts';
import { extractPage, parseOutline } from './parse.ts';
import { outlinePrompt, pagePrompt } from './prompts.ts';
import { sanitizeHtml } from './sanitize.ts';
import { createVersion, finish, getVersion, saveOutline, savePages, setProgress, toMeta } from './store.ts';
import {
  PROTO_LIMITS, ProtoError,
  type Outline, type OutlinePage, type ProtoMeta, type ProtoPage, type ProtoRow, type Progress,
} from './types.ts';

interface PrdDoc { title: string; content: string; status: string }
interface Deps {
  prd: (reviewId: number, n: number) => PrdDoc | null;
  onEvent?: (e: EventInput) => void;
  log?: (s: string) => void;
  limits?: Partial<typeof PROTO_LIMITS>;
}
interface PageTarget { page: OutlinePage; current?: string; change?: string }
interface QueuedTask { row: ProtoRow; run: () => Promise<void>; promise: Promise<void>; resolve: () => void }

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { /* 试取对象片段 */ }
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) return JSON.parse(m[0]);
  throw new Error('模型未返回合法 JSON');
}

const cps = (s: string) => [...s];
const clip = (s: string, n: number) => cps(s).slice(0, n).join('');

export class ProtoRunner {
  private readonly db: DB;
  private readonly llm: LlmPort;
  private readonly deps: Deps;
  private readonly limits: typeof PROTO_LIMITS;
  private readonly queue: QueuedTask[] = [];
  private readonly tasks = new Set<Promise<void>>();
  private active = 0;

  constructor(db: DB, llm: LlmPort, deps: Deps) {
    this.db = db;
    this.llm = llm;
    this.deps = deps;
    this.limits = { ...PROTO_LIMITS, ...deps.limits };
  }

  async idle(): Promise<void> {
    while (this.tasks.size) await Promise.all([...this.tasks]);
  }

  private enqueue(row: ProtoRow, run: () => Promise<void>): void {
    const task = {} as QueuedTask;
    task.row = row;
    task.run = run;
    task.promise = new Promise<void>((resolve) => { task.resolve = resolve; });
    if (this.active >= this.limits.globalTasks) {
      const p: Progress = { stage: 'queued', done: 0, total: 0 };
      row.progress = p;
      setProgress(this.db, row.id, p);
    }
    this.tasks.add(task.promise);
    this.queue.push(task);
    this.pump();
  }

  private pump(): void {
    while (this.active < this.limits.globalTasks && this.queue.length) {
      const t = this.queue.shift()!;
      this.active++;
      void t.run()
        .catch((e: unknown) => this.deps.log?.(`原型任务异常：${e instanceof Error ? e.message : String(e)}`))
        .finally(() => {
          this.active--;
          t.resolve();
          this.tasks.delete(t.promise);
          this.pump();
        });
    }
  }

  private alive(row: ProtoRow): boolean {
    return getVersion(this.db, row.review_id, row.n) != null;
  }

  private end(row: ProtoRow, r: { status: 'done' | 'error'; error?: string | null }, event?: EventInput): void {
    if (!finish(this.db, row.id, r)) return;
    if (r.status === 'done' && event) this.deps.onEvent?.(event);
  }

  generate(reviewId: number, versionN: number): ProtoMeta {
    if (!this.llm.enabled) throw new ProtoError(503, '未配置模型，无法生成原型');
    const doc = this.deps.prd(reviewId, versionN);
    if (!doc) throw new ProtoError(400, '文档版本不存在');
    if (doc.status !== 'done') throw new ProtoError(409, '评审还没完成');
    const row = createVersion(this.db, reviewId, { baseVersionN: versionN, fromN: null, request: '' });
    this.enqueue(row, () => this.runFirst(row, reviewId, versionN));
    return toMeta(row);
  }

  private async runFirst(row: ProtoRow, reviewId: number, versionN: number): Promise<void> {
    if (!setProgress(this.db, row.id, { stage: 'outline', done: 0, total: 0 }) || !this.alive(row)) return;
    const doc = this.deps.prd(reviewId, versionN);
    if (!doc) { this.end(row, { status: 'error', error: '文档版本不存在' }); return; }
    const raw = cps(doc.content);
    const cut = raw.length > this.limits.prdOutlineChars;
    const prd = cut ? raw.slice(0, this.limits.prdOutlineChars).join('') : doc.content;
    const messages = outlinePrompt(doc.title, prd);
    if (cut) messages[1].content += '\n后文已截断';
    let outline: Outline | null = null;
    for (let i = 0; i < 2 && !outline; i++) {
      try {
        const text = await this.llm.chat(messages, {
          json: true, maxTokens: this.limits.outlineTokens, temperature: 0.4, timeoutMs: this.limits.outlineTimeoutMs,
        });
        outline = parseOutline(parseJson(text));
      } catch (e) {
        this.deps.log?.(`原型大纲失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!outline) { this.end(row, { status: 'error', error: '原型规划失败，请重试' }); return; }
    if (!saveOutline(this.db, row.id, outline) || !this.alive(row)) return;
    const pages: ProtoPage[] = outline.pages.map((p) => ({ slug: p.slug, title: p.title, html: '', error: null }));
    if (!savePages(this.db, row.id, pages) || !this.alive(row)) return;
    const pagePrd = clip(doc.content, this.limits.prdPageChars);
    const targets: PageTarget[] = outline.pages.map((page) => ({ page }));
    await this.runPages(row, reviewId, outline, pagePrd, targets, pages);
  }

  private async makePage(t: PageTarget, outline: Outline, prd: string): Promise<{ html: string; error: string | null }> {
    let truncated = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await this.llm.chat(
          pagePrompt(outline, t.page, prd, { current: t.current, change: t.change, retry: attempt > 0 && truncated }),
          { maxTokens: this.limits.pageTokens, temperature: 0.5, timeoutMs: this.limits.pageTimeoutMs },
        );
        const ex = extractPage(raw);
        if (ex.truncated) {
          truncated = true;
          if (attempt === 0) continue;
          return { html: '', error: '页面输出被截断' };
        }
        const html = sanitizeHtml(ex.html);
        if (Buffer.byteLength(html) > this.limits.pageBytes) return { html: '', error: '页面过大' };
        return { html, error: null };
      } catch (e) {
        truncated = false;
        if (attempt === 0) continue;
        return { html: '', error: e instanceof Error && e.message ? e.message : '页面生成失败' };
      }
    }
    return { html: '', error: '页面生成失败' };
  }

  private async runPages(
    row: ProtoRow,
    reviewId: number,
    outline: Outline,
    prd: string,
    targets: PageTarget[],
    pages: ProtoPage[],
  ): Promise<void> {
    if (!setProgress(this.db, row.id, { stage: 'pages', done: 0, total: targets.length }) || !this.alive(row)) return;
    let alive = true;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.limits.taskMs); });
    void deadline.then(() => { expired = true; });
    let activePages = 0;
    const waiters: Array<() => void> = [];
    const take = async () => {
      if (activePages >= this.limits.pageConcurrency) await new Promise<void>((r) => waiters.push(r));
      activePages++;
    };
    const free = () => { activePages--; waiters.shift()?.(); };
    const finished = new Set<number>();
    const mark = (idx: number, error: string | null, html: string) => {
      if (!alive || finished.has(idx)) return;
      const page = pages.find((p) => p.slug === targets[idx].page.slug);
      if (!page) return;
      page.html = html;
      page.error = error;
      finished.add(idx);
      const done = pages.filter((p) => p.html && !p.error).length;
      const ok = savePages(this.db, row.id, pages)
        && setProgress(this.db, row.id, { stage: 'pages', done, total: targets.length });
      if (!ok || !this.alive(row)) alive = false;
    };
    const workers = targets.map(async (t, idx) => {
      if (expired) { mark(idx, '超时', ''); return; }
      await take();
      try {
        if (expired) { mark(idx, '超时', ''); return; }
        const res = await this.makePage(t, outline, prd);
        if (expired) return;
        mark(idx, res.error, res.html);
      } finally {
        free();
      }
    });
    await Promise.race([Promise.all(workers), deadline]);
    if (timer) clearTimeout(timer);
    if (expired) targets.forEach((_, idx) => { if (!finished.has(idx)) mark(idx, '超时', ''); });
    if (!alive) return;
    const okCount = pages.filter((p) => p.html && !p.error).length;
    if (!okCount) { this.end(row, { status: 'error', error: '页面生成失败，请重试' }); return; }
    const device = outline.device;
    const doc = assemble({ ...row, outline, pages }, { device });
    if (Buffer.byteLength(doc) > this.limits.docBytes) { this.end(row, { status: 'error', error: '原型过大，请减少页面' }); return; }
    this.end(row, { status: 'done' }, {
      kind: 'proto_create',
      refType: 'review',
      refId: reviewId,
      summary: `生成原型：${outline.product}，${okCount} 页`,
      payload: {
        request: row.request,
        note: row.note,
        pages: pages.filter((p) => p.html && !p.error).map((p) => p.title),
      },
    });
  }
}
