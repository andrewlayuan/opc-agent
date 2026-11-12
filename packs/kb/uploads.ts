// 知识库上传：落盘到 data/kb/、后台提取正文（复用附件的提取能力）、重启恢复
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../../packages/core/db.ts';
import type { Llm } from '../../packages/core/llm.ts';
import { RESTART_MSG, sanitizeName } from '../pm/attachments.ts';
import { ExtractError } from '../pm/extract.ts';
import type { ExecFn } from '../pm/extract.ts';
import { extractFileText, inspectUpload } from '../pm/ingest.ts';
import type { LlmPort } from '../pm/ingest.ts';
import { docFile, getDoc, insertUpload, setBody } from './docs.ts';
import type { DocView } from './docs.ts';
import { KB_LIMITS, KbError, clipCp, len } from './types.ts';

const ERR_CHARS = 200;
const errText = (e: unknown) => clipCp(e instanceof Error ? e.message : String(e), ERR_CHARS);
const STORAGE = /^[0-9a-f]{32}$/;

export class KbFiles {
  private readonly db: DB;
  private readonly dir: string;
  private readonly llm: LlmPort;
  private readonly log: (s: string) => void;
  private readonly exec?: ExecFn;
  private readonly officeTimeoutMs?: number;
  private readonly concurrency: number;
  private queue: number[] = [];
  private active = 0;
  private waiters: (() => void)[] = [];

  constructor(db: DB, dir: string, llm: Llm | LlmPort, opts: { exec?: ExecFn; concurrency?: number; officeTimeoutMs?: number; log?: (s: string) => void } = {}) {
    this.db = db;
    this.dir = dir;
    this.llm = llm;
    this.log = opts.log ?? ((s) => console.error(s));
    this.exec = opts.exec;
    this.officeTimeoutMs = opts.officeTimeoutMs;
    this.concurrency = opts.concurrency ?? 2;
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
  }

  private pathOf(storage: string): string {
    if (!STORAGE.test(storage)) throw new Error('非法存储名');
    return path.join(this.dir, storage);
  }

  tmpPath(): string {
    this.ensureDir();
    return path.join(this.dir, `tmp-${randomBytes(16).toString('hex')}`);
  }

  /** tmp 是已写完的上传临时文件；任何失败都删除 tmp 和已落盘的文件 */
  create(tmp: string, rawName: string, folderId: number | null, now: number = Date.now()): DocView {
    let dest = '';
    try {
      const size = fs.statSync(tmp).size;
      if (size > KB_LIMITS.fileMax) throw new KbError(413, '单个文件最大 10MB');
      const name = sanitizeName(rawName);
      let det;
      try {
        det = inspectUpload(tmp, name);
      } catch (e) {
        if (e instanceof ExtractError) throw new KbError(e.status, e.message);
        throw e;
      }
      const used = Number((this.db.prepare('SELECT coalesce(sum(file_size), 0) AS n FROM kb_docs WHERE storage IS NOT NULL').get() as { n: number }).n);
      if (used + size > KB_LIMITS.totalBytes) throw new KbError(413, '知识库存储空间已满');
      const storage = randomBytes(16).toString('hex');
      dest = this.pathOf(storage);
      fs.renameSync(tmp, dest);
      fs.chmodSync(dest, 0o600);
      const title = clipCp(name.replace(/\.[^.]{1,10}$/, '').trim() || name, KB_LIMITS.title);
      const id = insertUpload(this.db, { title, folderId, fileName: name, mime: det.mime, size, storage }, now);
      this.queue.push(id);
      setImmediate(() => this.pump());
      return getDoc(this.db, id)!.doc;
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      if (dest) fs.rmSync(dest, { force: true });
      throw e;
    }
  }

  file(id: number): { path: string; mime: string; name: string } | null {
    const f = docFile(this.db, id);
    return f ? { path: this.pathOf(f.storage), mime: f.mime, name: f.name } : null;
  }

  unlink(storage: string | null): void {
    if (!storage) return;
    try {
      fs.rmSync(this.pathOf(storage), { force: true });
    } catch (e) {
      this.log(`[kb] 删除文件失败 ${storage}：${errText(e)}`);
    }
  }

  recover(): number {
    const n = Number(this.db.prepare("UPDATE kb_docs SET status = 'error', error = ? WHERE status = 'processing'").run(RESTART_MSG).changes);
    if (fs.existsSync(this.dir)) for (const f of fs.readdirSync(this.dir)) if (f.startsWith('tmp-')) fs.rmSync(path.join(this.dir, f), { force: true });
    return n;
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
        .catch((e) => this.log(`[kb] 文件处理异常 ${id}：${errText(e)}`))
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

  private stillProcessing(id: number): boolean {
    const r = this.db.prepare('SELECT status FROM kb_docs WHERE id = ?').get(id) as { status: string } | undefined;
    return r?.status === 'processing';
  }

  private async process(id: number): Promise<void> {
    if (!this.stillProcessing(id)) return;
    const f = this.file(id);
    if (!f) return;
    let text: string;
    try {
      const kind = f.mime.startsWith('image/') ? 'image' : 'doc';
      text = await extractFileText(f.path, f.mime, kind, { llm: this.llm, exec: this.exec, officeTimeoutMs: this.officeTimeoutMs });
      if (len(text) > KB_LIMITS.bodyChars) throw new Error('正文超过 20 万字，请拆分后上传');
    } catch (e) {
      this.db.prepare("UPDATE kb_docs SET status = 'error', error = ? WHERE id = ? AND status = 'processing'").run(errText(e), id);
      return;
    }
    // 提取期间条目可能被删除或修改；同步检查后立即写入，中间不会被打断
    if (this.stillProcessing(id)) setBody(this.db, id, text.trim());
  }
}
