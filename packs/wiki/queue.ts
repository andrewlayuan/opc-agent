// Wiki 后台队列：扫描知识库入队摄入、每日调用额度、给评审让路、重启恢复、每周体检
import type { DB } from '../../packages/core/db.ts';
import type { ChatMessage, ChatOptions, Llm } from '../../packages/core/llm.ts';
import { refreshStale } from '../kb/docs.ts';
import { realClock } from '../memory/consolidate.ts';
import type { Clock } from '../memory/consolidate.ts';
import { docHash, generatePage, ingestDoc } from './ingest.ts';
import type { IngestResult } from './ingest.ts';
import { runLint } from './lint.ts';
import { createOp, finishOp, getOp, startOp } from './store.ts';
import { WIKI_LIMITS, WikiError } from './types.ts';

type Runner = {
  ingest: (llm: Llm, opId: number, docId: number) => Promise<IngestResult>;
  lint: (llm: Llm, opId: number) => Promise<{ llmCalls: number }>;
  generate: (llm: Llm, opId: number, slug: string) => Promise<IngestResult>;
};

export type DocState = 'none' | 'queued' | 'running' | 'done' | 'error' | 'reverted';

const START_DELAY = 30_000;
const EVERY = 2 * 60_000;
const MAX_FAILS = 3;
const DAY = 86_400_000;

export function defaultBusy(db: DB): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM pm_reviews WHERE status = 'running' UNION ALL SELECT 1 FROM pm_messages WHERE status = 'running' UNION ALL SELECT 1 FROM pm_prototypes WHERE status = 'running' LIMIT 1",
      )
      .get() != null
  );
}

/** 统计调用次数的模型代理：失败的任务也能记下用掉的调用 */
function counting(llm: Llm, box: { n: number }): Llm {
  const p = Object.create(llm) as Llm;
  p.chat = (m: ChatMessage[], o?: ChatOptions) => {
    box.n++;
    return llm.chat(m, o);
  };
  p.chatLong = (m: ChatMessage[], o?: ChatOptions) => {
    box.n++;
    return llm.chatLong(m, o);
  };
  return p;
}

export class WikiQueue {
  private readonly db: DB;
  private readonly llm: Llm;
  private readonly clock: Clock;
  private readonly log: (s: string) => void;
  private readonly busy: () => boolean;
  readonly limit: number;
  private readonly run: Runner;
  private ticking = false;
  private startTimer: unknown = null;
  private timer: unknown = null;
  private started = false;

  constructor(
    db: DB,
    llm: Llm,
    o: { clock?: Clock; log?: (s: string) => void; dailyCalls?: number; busy?: () => boolean; run?: Runner } = {},
  ) {
    this.db = db;
    this.llm = llm;
    this.clock = o.clock ?? realClock;
    this.log = o.log ?? ((s) => console.log(s));
    this.busy = o.busy ?? (() => defaultBusy(db));
    const n = o.dailyCalls;
    this.limit = Number.isSafeInteger(n) && (n as number) > 0 ? (n as number) : WIKI_LIMITS.dailyCalls;
    this.run = o.run ?? {
      ingest: (l, op, doc) => ingestDoc(db, l, op, doc),
      lint: (l, op) => runLint(db, l, op),
      generate: (l, op, slug) => generatePage(db, l, op, slug),
    };
  }

  start(): void {
    const n = this.recover();
    if (n) this.log(`[wiki] ${n} 个任务因重启中断，已标记为失败`);
    this.started = true;
    this.startTimer = this.clock.setTimeout(() => {
      this.startTimer = null;
      void this.tick();
    }, START_DELAY);
    this.timer = this.clock.setInterval(() => void this.tick(), EVERY);
  }

  stop(): void {
    this.started = false;
    if (this.startTimer) this.clock.clearTimeout(this.startTimer);
    if (this.timer) this.clock.clearInterval(this.timer);
    this.startTimer = this.timer = null;
  }

  /** 有新任务入队后尽快执行（服务运行中才生效） */
  kick(): void {
    if (this.started) this.clock.setTimeout(() => void this.tick(), 0);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.scan();
      this.maybeWeeklyLint();
      await this.drain();
    } catch (e) {
      this.log(`[wiki] 后台任务异常：${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  recover(): number {
    return Number(
      this.db.prepare("UPDATE wiki_ops SET status = 'error', error = '服务重启中断', finished_at = ? WHERE status = 'running'").run(this.clock.now()).changes,
    );
  }

  private dayStart(): number {
    const d = new Date(this.clock.now());
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  usedToday(): number {
    return Number((this.db.prepare('SELECT coalesce(sum(llm_calls), 0) AS n FROM wiki_ops WHERE coalesce(finished_at, created_at) >= ?').get(this.dayStart()) as { n: number }).n);
  }

  private activeIngest(docId: number): number | null {
  const r = this.db.prepare("SELECT id FROM wiki_ops WHERE kind = 'ingest' AND doc_id = ? AND status IN ('queued', 'running') ORDER BY id LIMIT 1").get(docId) as { id: number } | undefined;
    return r ? Number(r.id) : null;
  }

  /** 扫描 ready 的知识库条目，按规则入队；返回新入队的数量 */
  scan(): number {
    try {
      refreshStale(this.db, this.clock.now());
    } catch (e) {
      this.log(`[wiki] 同步知识库来源失败：${(e as Error).message}`);
    }
    const rows = this.db
      .prepare(
        `SELECT d.id, d.updated_at, w.body_hash, w.state, w.fails, w.ingested_at
         FROM kb_docs d LEFT JOIN wiki_docs w ON w.doc_id = d.id WHERE d.status = 'ready' ORDER BY d.id`,
      )
      .all() as { id: number; updated_at: number; body_hash: string | null; state: string | null; fails: number | null; ingested_at: number | null }[];
    let n = 0;
    for (const r of rows) {
      const id = Number(r.id);
      if (r.state === 'reverted') continue;
      if (this.activeIngest(id) != null) continue;
      if (r.state == null) {
        this.enqueueIngest(id);
        n++;
        continue;
      }
      // 已编入且条目之后没有更新过，跳过哈希计算
      if (r.state === 'done' && Number(r.updated_at) <= Number(r.ingested_at)) continue;
      const changed = docHash(this.db, id) !== r.body_hash;
      if (changed) this.db.prepare('UPDATE wiki_docs SET fails = 0 WHERE doc_id = ?').run(id);
      if (changed || (r.state === 'error' && Number(r.fails) < MAX_FAILS)) {
        this.enqueueIngest(id);
        n++;
      }
    }
    return n;
  }

  enqueueIngest(docId: number, o: { manual?: boolean } = {}): number {
    const d = this.db.prepare('SELECT status FROM kb_docs WHERE id = ?').get(docId) as { status: string } | undefined;
    if (!d) throw new WikiError(404, '资料不存在');
    if (d.status !== 'ready') throw new WikiError(409, '资料尚未就绪');
    const active = this.activeIngest(docId);
    if (active != null) return active;
    if (o.manual) this.db.prepare('DELETE FROM wiki_docs WHERE doc_id = ?').run(docId);
    return createOp(this.db, 'ingest', { docId, now: this.clock.now() });
  }

  enqueueLint(): number {
    const r = this.db.prepare("SELECT id FROM wiki_ops WHERE kind = 'lint' AND status IN ('queued', 'running') LIMIT 1").get() as { id: number } | undefined;
    return r ? Number(r.id) : createOp(this.db, 'lint', { now: this.clock.now() });
  }

  /** 缺页生成：页面名暂存在 note 里，执行时读取 */
  enqueueGenerate(slug: string): number {
    const r = this.db.prepare("SELECT id FROM wiki_ops WHERE kind = 'generate' AND note = ? AND status IN ('queued', 'running') LIMIT 1").get(slug) as { id: number } | undefined;
    if (r) return Number(r.id);
    const id = createOp(this.db, 'generate', { now: this.clock.now() });
    this.db.prepare('UPDATE wiki_ops SET note = ? WHERE id = ?').run(slug, id);
    return id;
  }

  retry(opId: number): number {
    const op = getOp(this.db, opId);
    if (!op) throw new WikiError(404, '操作不存在');
    if (op.status !== 'error') throw new WikiError(400, '只能重试失败的操作');
    if (op.kind === 'ingest' && op.doc_id != null) return this.enqueueIngest(op.doc_id, { manual: true });
    if (op.kind === 'lint') return this.enqueueLint();
    if (op.kind === 'generate' && op.note) return this.enqueueGenerate(op.note);
    throw new WikiError(400, '该操作不能重试');
  }

  /** 依次执行排队任务，直到队列空、额度用完、模型不可用或有评审在进行 */
  async drain(): Promise<void> {
    for (;;) {
      if (!this.llm.enabled || this.busy() || this.usedToday() >= this.limit) return;
      const row = this.db.prepare("SELECT id FROM wiki_ops WHERE status = 'queued' ORDER BY id LIMIT 1").get() as { id: number } | undefined;
      if (!row) return;
      const op = getOp(this.db, Number(row.id))!;
      if (!startOp(this.db, op.id)) continue;
      const box = { n: 0 };
      const llm = counting(this.llm, box);
      try {
        if (op.kind === 'ingest' && op.doc_id != null) await this.run.ingest(llm, op.id, op.doc_id);
        else if (op.kind === 'lint') await this.run.lint(llm, op.id);
        else if (op.kind === 'generate') await this.run.generate(llm, op.id, op.note);
        else throw new WikiError(400, '未知的任务类型');
      } catch (e) {
        const msg = (e as Error).message || String(e);
        finishOp(this.db, op.id, { status: 'error', error: msg, llmCalls: box.n, note: op.kind === 'generate' ? op.note : '', now: this.clock.now() });
        if (op.kind === 'ingest' && op.doc_id != null) {
          const hash = this.db.prepare('SELECT 1 FROM kb_docs WHERE id = ?').get(op.doc_id) ? docHash(this.db, op.doc_id) : '';
          this.db
            .prepare(
              `INSERT INTO wiki_docs(doc_id, body_hash, state, fails, ingested_at) VALUES (?, ?, 'error', 1, ?)
               ON CONFLICT(doc_id) DO UPDATE SET body_hash = excluded.body_hash, state = 'error', fails = wiki_docs.fails + 1, ingested_at = excluded.ingested_at`,
            )
            .run(op.doc_id, hash, this.clock.now());
        }
        this.log(`[wiki] 任务 #${op.id}（${op.kind}）失败：${msg}`);
      }
    }
  }

  /** 本周一 03:00 之后还没有体检过，且 Wiki 非空时入队一次体检 */
  maybeWeeklyLint(): number | null {
    const now = this.clock.now();
    const d = new Date(now);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    d.setHours(3, 0, 0, 0);
    let mark = d.getTime();
    if (now < mark) mark -= 7 * DAY;
    const last = (this.db.prepare("SELECT max(created_at) AS t FROM wiki_ops WHERE kind = 'lint'").get() as { t: number | null }).t;
    if (last != null && Number(last) >= mark) return null;
    if (!this.db.prepare('SELECT 1 FROM wiki_pages WHERE deleted = 0 LIMIT 1').get()) return null;
    return this.enqueueLint();
  }

  status(): {
    queued: number;
    running: { opId: number; kind: string; docId: number | null; title: string } | null;
    usedToday: number;
    limit: number;
    enabled: boolean;
    lastLint: { opId: number; at: number; issues: number } | null;
  } {
    const queued = Number((this.db.prepare("SELECT count(*) AS n FROM wiki_ops WHERE status = 'queued'").get() as { n: number }).n);
    const r = this.db
      .prepare("SELECT o.id, o.kind, o.doc_id, o.note, d.title FROM wiki_ops o LEFT JOIN kb_docs d ON d.id = o.doc_id WHERE o.status = 'running' ORDER BY o.id LIMIT 1")
      .get() as { id: number; kind: string; doc_id: number | null; note: string; title: string | null } | undefined;
    const l = this.db.prepare("SELECT id, finished_at, note FROM wiki_ops WHERE kind = 'lint' AND status = 'done' ORDER BY id DESC LIMIT 1").get() as
      | { id: number; finished_at: number; note: string }
      | undefined;
    let issues = 0;
    if (l) {
      try {
        const v = JSON.parse(l.note) as { issues?: unknown[] };
        issues = Array.isArray(v.issues) ? v.issues.length : 0;
      } catch {
        issues = 0;
      }
    }
    return {
      queued,
      running: r ? { opId: Number(r.id), kind: r.kind, docId: r.doc_id == null ? null : Number(r.doc_id), title: r.title ?? (r.kind === 'generate' ? r.note : '') } : null,
      usedToday: this.usedToday(),
      limit: this.limit,
      enabled: this.llm.enabled,
      lastLint: l ? { opId: Number(l.id), at: Number(l.finished_at), issues } : null,
    };
  }

  docStates(): Map<number, DocState> {
    const m = new Map<number, DocState>();
    for (const r of this.db.prepare('SELECT doc_id, state FROM wiki_docs').all() as { doc_id: number; state: DocState }[]) m.set(Number(r.doc_id), r.state);
    for (const r of this.db.prepare("SELECT doc_id, status FROM wiki_ops WHERE kind = 'ingest' AND status IN ('queued', 'running') AND doc_id IS NOT NULL").all() as {
      doc_id: number;
      status: DocState;
    }[])
      m.set(Number(r.doc_id), r.status);
    return m;
  }
}
