// Wiki 图片：按文件头识别类型（不信任扩展名和 Content-Type），随机文件名落盘
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../../packages/core/db.ts';
import { WIKI_LIMITS, WikiError } from './types.ts';

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
const EXT: Record<ImageMime, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const STORAGE = /^[0-9a-f]{32}\.(png|jpg|gif|webp)$/;

export function sniffImage(b: Buffer): ImageMime | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function head(file: string): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(16);
    const n = fs.readSync(fd, b, 0, 16, 0);
    return b.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

export class WikiAssets {
  readonly dir: string;
  private readonly db: DB;

  constructor(db: DB, dir: string) {
    this.db = db;
    this.dir = dir;
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
  }

  /** 上传临时文件路径（与正式文件同目录，便于原子改名） */
  tmpPath(): string {
    this.ensureDir();
    return path.join(this.dir, `tmp-${randomBytes(16).toString('hex')}`);
  }

  /** tmpFile 是已写完的上传文件；任何失败都删除它 */
  create(tmpFile: string, pageId: number, now: number = Date.now()): { id: number; mime: ImageMime } {
    let dest = '';
    try {
      if (!this.db.prepare('SELECT 1 FROM wiki_pages WHERE id = ? AND deleted = 0').get(pageId)) throw new WikiError(404, '页面不存在');
      const st = fs.lstatSync(tmpFile);
      if (!st.isFile()) throw new WikiError(400, '上传失败');
      if (st.size > WIKI_LIMITS.assetMax) throw new WikiError(413, '图片最大 5MB');
      const mime = sniffImage(head(tmpFile));
      if (!mime) throw new WikiError(415, '只支持 PNG、JPG、GIF、WebP 图片');
      this.ensureDir();
      const storage = `${randomBytes(16).toString('hex')}.${EXT[mime]}`;
      dest = path.join(this.dir, storage);
      fs.renameSync(tmpFile, dest);
      fs.chmodSync(dest, 0o600);
      const id = Number(
        this.db.prepare('INSERT INTO wiki_assets(page_id, mime, size, storage, created_at) VALUES (?, ?, ?, ?, ?)').run(pageId, mime, st.size, storage, now).lastInsertRowid,
      );
      return { id, mime };
    } catch (e) {
      fs.rmSync(tmpFile, { force: true });
      if (dest) fs.rmSync(dest, { force: true });
      throw e;
    }
  }

  read(id: number): { file: string; mime: ImageMime } | null {
    const r = this.db.prepare('SELECT mime, storage FROM wiki_assets WHERE id = ?').get(id) as { mime: string; storage: string } | undefined;
    if (!r || !STORAGE.test(r.storage) || !(r.mime in EXT)) return null;
    return { file: path.join(this.dir, r.storage), mime: r.mime as ImageMime };
  }
}
