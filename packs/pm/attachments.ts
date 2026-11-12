/** 产品顾问附件：落盘、后台提取文字 / 图片描述、关联前校验、清理 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../../packages/core/db.ts';
import type { Llm } from '../../packages/core/llm.ts';
import { ExtractError, OFFICE_TIMEOUT_MS, clampText, decodeText, detectType, realExec } from './extract.ts';
import type { ExecFn } from './extract.ts';
import { extractFileText } from './ingest.ts';

export const LIMITS = {
  fileMax: 10 * 1024 * 1024,
  perMessage: 8,
  imageBytes: 20 * 1024 * 1024,
  perReview: 20,
  pending: 40,
  totalBytes: 2 * 1024 * 1024 * 1024,
  orphanMs: 24 * 3600 * 1000,
};

const DOC_CHARS = 20000;
const DESC_CHARS = 1500;
const ERR_CHARS = 200;
export { DESCRIBE_PROMPT } from './ingest.ts';
export const RESTART_MSG = '服务重启，处理中断，请删除后重新上传';

export class AttachmentError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface AttachmentRow {
  id: number;
  created_at: number;
  review_id: number | null;
  message_id: number | null;
  name: string;
  mime: string;
  kind: 'image' | 'doc';
  size: number;
  storage: string;
  status: 'processing' | 'ready' | 'error';
  text: string;
  orig_chars: number | null;
  error: string | null;
}

export interface AttachmentView {
  id: number;
  name: string;
  kind: 'image' | 'doc';
  mime: string;
  size: number;
  status: AttachmentRow['status'];
  error: string | null;
  truncated: boolean;
  chars: number;
}

export function toView(r: AttachmentRow): AttachmentView {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    mime: r.mime,
    size: r.size,
    status: r.status,
    error: r.error,
    truncated: r.orig_chars != null,
    chars: [...r.text].length,
  };
}

/** 只用于显示：去控制字符与方向控制符，路径/保留符号替换为 _，最多 120 字 */
export function sanitizeName(raw: string): string {
  const s = raw
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .trim();
  const cut = [...s].slice(0, 120).join('').trim();
  return cut || '未命名';
}

const errText = (e: unknown) => [...(e instanceof Error ? e.message : String(e))].slice(0, ERR_CHARS).join('');

type Port = Pick<Llm, 'enabled' | 'chat'>;

export class AttachmentStore {
  private readonly db: DB;
  private readonly dir: string;
  private readonly llm: Port;
  private readonly log: (s: string) => void;
  private readonly exec: ExecFn;
  private readonly concurrency: number;
  private readonly officeTimeoutMs: number;
  private queue: number[] = [];
  private active = 0;
  private waiters: (() => void)[] = [];

  constructor(db: DB, dir: string, llm: Port, opts: { log?: (s: string) => void; exec?: ExecFn; concurrency?: number; officeTimeoutMs?: number } = {}) {
    this.db = db;
    this.dir = dir;
    this.llm = llm;
    this.log = opts.log ?? ((s) => console.error(s));
    this.exec = opts.exec ?? realExec;
    this.concurrency = opts.concurrency ?? 2;
    this.officeTimeoutMs = opts.officeTimeoutMs ?? OFFICE_TIMEOUT_MS;
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
  }

  private pathOf(storage: string): string {
    return path.join(this.dir, storage);
  }

  private row(id: number): AttachmentRow | undefined {
    return this.db.prepare('SELECT * FROM pm_attachments WHERE id = ?').get(id) as AttachmentRow | undefined;
  }

  tmpPath(): string {
    this.ensureDir();
    return path.join(this.dir, `tmp-${randomBytes(16).toString('hex')}`);
  }

  /** tmp 是已写完的上传临时文件；任何失败都删除 tmp */
  create(tmp: string, rawName: string, now: number = Date.now()): AttachmentView {
    let storage = '';
    try {
      const size = fs.statSync(tmp).size;
      if (size > LIMITS.fileMax) throw new AttachmentError(413, '单个文件最大 10MB');
      const name = sanitizeName(rawName);
      let det;
      try {
        const buf = fs.readFileSync(tmp);
        det = detectType(buf, name);
        // spec 4.2：文本须能严格按 UTF-8 解码，否则上传时就返回 415，而不是先收下再在后台失败
        if (det.format === 'text') decodeText(buf);
      } catch (e) {
        if (e instanceof ExtractError) throw new AttachmentError(e.status, e.message);
        throw e;
      }
      const pending = (this.db.prepare('SELECT count(*) AS n FROM pm_attachments WHERE review_id IS NULL').get() as { n: number }).n;
      if (pending >= LIMITS.pending) throw new AttachmentError(400, '待发送的附件过多');
      const total = (this.db.prepare('SELECT coalesce(sum(size), 0) AS n FROM pm_attachments').get() as { n: number }).n;
      if (total + size > LIMITS.totalBytes) throw new AttachmentError(413, '附件存储空间已满');
      storage = randomBytes(16).toString('hex');
      const dest = this.pathOf(storage);
      fs.renameSync(tmp, dest);
      fs.chmodSync(dest, 0o600);
      const id = Number(
        this.db
          .prepare("INSERT INTO pm_attachments(created_at, name, mime, kind, size, storage, status) VALUES (?, ?, ?, ?, ?, ?, 'processing')")
          .run(now, name, det.mime, det.kind, size, storage).lastInsertRowid,
      );
      const view = toView(this.row(id)!);
      this.queue.push(id);
      setImmediate(() => this.pump());
      return view;
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      if (storage) fs.rmSync(this.pathOf(storage), { force: true });
      throw e;
    }
  }

  view(id: number): AttachmentView | null {
    const r = this.row(id);
    return r ? toView(r) : null;
  }

  file(id: number): { path: string; mime: string; kind: 'image' | 'doc'; name: string } | null {
    const r = this.row(id);
    return r ? { path: this.pathOf(r.storage), mime: r.mime, kind: r.kind, name: r.name } : null;
  }

  remove(id: number): void {
    const r = this.row(id);
    if (!r) throw new AttachmentError(404, '附件不存在');
    if (r.review_id != null) throw new AttachmentError(409, '附件已发送，不能单独删除');
    this.db.prepare('DELETE FROM pm_attachments WHERE id = ? AND review_id IS NULL').run(id);
    this.unlink([r.storage]);
  }

  /** 只校验不写库；返回行按 ids 原顺序 */
  validate(ids: unknown, reviewId: number | null): AttachmentRow[] {
    if (!Array.isArray(ids) || ids.some((x) => !Number.isInteger(x) || (x as number) <= 0) || new Set(ids).size !== ids.length) {
      throw new AttachmentError(400, '附件参数不合法');
    }
    if (ids.length > LIMITS.perMessage) throw new AttachmentError(400, `一次最多 ${LIMITS.perMessage} 个附件`);
    if (!ids.length) return [];
    const rows = (ids as number[]).map((id) => this.row(id));
    let imageBytes = 0;
    for (const r of rows) {
      if (!r) throw new AttachmentError(400, '附件不存在');
      if (r.review_id != null) throw new AttachmentError(409, '附件已被使用');
      if (r.status === 'processing') throw new AttachmentError(409, '附件还在处理');
      if (r.status !== 'ready') throw new AttachmentError(400, '附件处理失败，请移除后重新上传');
      if (r.kind === 'image') imageBytes += r.size;
    }
    if (imageBytes > LIMITS.imageBytes) throw new AttachmentError(400, '图片合计不能超过 20MB');
    if (reviewId != null) {
      const n = (this.db.prepare('SELECT count(*) AS n FROM pm_attachments WHERE review_id = ?').get(reviewId) as { n: number }).n;
      if (n + rows.length > LIMITS.perReview) throw new AttachmentError(400, `每个评审最多 ${LIMITS.perReview} 个附件`);
    }
    return rows as AttachmentRow[];
  }

  /** 调用方负责放进事务；行数不符说明并发占用 */
  claim(rows: AttachmentRow[], reviewId: number, messageId: number | null): void {
    if (!rows.length) return;
    const r = this.db
      .prepare(`UPDATE pm_attachments SET review_id = ?, message_id = ? WHERE id IN (${rows.map(() => '?').join(',')}) AND review_id IS NULL`)
      .run(reviewId, messageId, ...rows.map((x) => x.id));
    if (Number(r.changes) !== rows.length) throw new AttachmentError(409, '附件已被使用');
  }

  forReview(reviewId: number): AttachmentRow[] {
    return this.db.prepare('SELECT * FROM pm_attachments WHERE review_id = ? ORDER BY id').all(reviewId) as unknown as AttachmentRow[];
  }

  storagesOf(reviewId: number): string[] {
    return (this.db.prepare('SELECT storage FROM pm_attachments WHERE review_id = ?').all(reviewId) as { storage: string }[]).map((r) => r.storage);
  }

  unlink(storages: string[]): void {
    for (const s of storages) {
      try {
        fs.rmSync(this.pathOf(s), { force: true });
      } catch (e) {
        this.log(`[pm] 删除附件文件失败 ${s}：${errText(e)}`);
      }
    }
  }

  dataUrl(r: AttachmentRow): string {
    return `data:${r.mime};base64,${fs.readFileSync(this.pathOf(r.storage)).toString('base64')}`;
  }

  recover(): number {
    return Number(this.db.prepare("UPDATE pm_attachments SET status = 'error', error = ? WHERE status = 'processing'").run(RESTART_MSG).changes);
  }

  cleanup(now: number = Date.now()): { rows: number; files: number } {
    const cutoff = now - LIMITS.orphanMs;
    const stale = this.db.prepare('SELECT id, storage FROM pm_attachments WHERE review_id IS NULL AND created_at < ?').all(cutoff) as { id: number; storage: string }[];
    for (const r of stale) this.db.prepare('DELETE FROM pm_attachments WHERE id = ? AND review_id IS NULL').run(r.id);
    this.unlink(stale.map((r) => r.storage));
    let files = 0;
    if (!fs.existsSync(this.dir)) return { rows: stale.length, files };
    const known = new Set((this.db.prepare('SELECT storage FROM pm_attachments').all() as { storage: string }[]).map((r) => r.storage));
    for (const name of fs.readdirSync(this.dir)) {
      if (known.has(name)) continue;
      const p = this.pathOf(name);
      try {
        const st = fs.statSync(p);
        if (!st.isFile() || st.mtimeMs >= cutoff) continue;
        fs.rmSync(p, { force: true });
        files++;
      } catch (e) {
        this.log(`[pm] 清理附件文件失败 ${name}：${errText(e)}`);
      }
    }
    return { rows: stale.length, files };
  }

  idle(): Promise<void> {
    if (!this.queue.length && !this.active) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const id = this.queue.shift()!;
      this.active++;
      this.process(id)
        .catch((e) => this.log(`[pm] 附件处理异常 ${id}：${errText(e)}`))
        .finally(() => {
          this.active--;
          this.pump();
          if (!this.active && !this.queue.length) {
            const w = this.waiters;
            this.waiters = [];
            for (const f of w) f();
          }
        });
    }
  }

  private async process(id: number): Promise<void> {
    const r = this.row(id);
    if (!r || r.status !== 'processing') return;
    let result: { text: string; origChars: number | null };
    try {
      result = await this.extract(r);
    } catch (e) {
      this.db.prepare("UPDATE pm_attachments SET status = 'error', error = ? WHERE id = ? AND status = 'processing'").run(errText(e), id);
      return;
    }
    this.db.prepare("UPDATE pm_attachments SET status = 'ready', text = ?, orig_chars = ? WHERE id = ? AND status = 'processing'").run(result.text, result.origChars, id);
  }

  private async extract(r: AttachmentRow): Promise<{ text: string; origChars: number | null }> {
    const text = await extractFileText(this.pathOf(r.storage), r.mime, r.kind, { llm: this.llm, exec: this.exec, officeTimeoutMs: this.officeTimeoutMs });
    return clampText(text, r.kind === 'image' ? DESC_CHARS : DOC_CHARS);
  }
}
