// 导出整个知识库：上传导出原文件，笔记 / 评审 / 资讯导出 Markdown，另附清单.csv。条目名全部由程序拼接并清洗
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../../packages/core/db.ts';
import { ZipWriter } from '../wiki/zip.ts';
import { sourceText } from './docs.ts';
import { KB_LIMITS, KbError } from './types.ts';
import type { DocKind, DocStatus } from './types.ts';
import type { KbFiles } from './uploads.ts';

export const EXPORT_MAX = 1.5 * 1024 * 1024 * 1024;
const TOO_BIG = '导出内容超过 1.5GB，请先删除不需要的大文件后再导出';
const MANIFEST = '清单.csv';
const NAME_MAX = 80;
const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const EXT_RE = /\.[A-Za-z0-9]{1,10}$/;
const KIND_LABEL: Record<DocKind, string> = { upload: '上传', note: '笔记', review: '评审', item: '资讯' };
const HEADER = ['路径', '标题', '类型', '状态', '创建时间', '更新时间', '原文件名', '大小'];

const oneLine = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim();
const extOf = (name: string) => EXT_RE.exec(name)?.[0] ?? '';

/** 文件名 / 目录段清洗：去掉 \/:*?"<>| 与控制字符，去首尾空白和点，Windows 保留名前加 _，最长 80 码点（保留扩展名） */
export function safeName(raw: string, fallback = '未命名'): string {
  let s = String(raw ?? '')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (!s) return fallback;
  if (WIN_RESERVED.test(s)) s = `_${s}`;
  const cps = [...s];
  if (cps.length > NAME_MAX) {
    const ext = extOf(s);
    s = `${cps.slice(0, NAME_MAX - ext.length).join('').replace(/[.\s]+$/, '')}${ext}`;
  }
  return s || fallback;
}

/** CSV 字段：RFC 4180 转义；以 = + - @ 制表符 回车开头的文本前加 '，防公式注入 */
export function csvField(v: string | number | null): string {
  if (v == null) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const pad = (n: number) => String(n).padStart(2, '0');
const fmtTime = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 同一目录下的已用名（忽略大小写）；目录段与文件名共用一张表 */
class Names {
  private used = new Map<string, Set<string>>();

  take(dir: string, name: string, isDir = false): string {
    let set = this.used.get(dir);
    if (!set) this.used.set(dir, (set = new Set()));
    const ext = isDir ? '' : extOf(name);
    const base = ext ? name.slice(0, -ext.length) : name;
    let out = name;
    for (let n = 2; set.has(out.toLowerCase()); n++) out = `${base} (${n})${ext}`;
    set.add(out.toLowerCase());
    return out;
  }
}

/** 目录 id → zip 内路径；按 id 顺序分配，先建的保留原名 */
function folderDirs(db: DB, names: Names): Map<number, string> {
  const rows = db.prepare('SELECT id, parent_id, name FROM kb_folders ORDER BY id').all() as { id: number; parent_id: number | null; name: string }[];
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const out = new Map<number, string>();
  const resolve = (id: number, depth: number): string => {
    const hit = out.get(id);
    if (hit != null) return hit;
    const r = byId.get(id);
    if (!r) return '';
    const parent = r.parent_id == null || depth > KB_LIMITS.depth ? '' : resolve(Number(r.parent_id), depth + 1);
    const seg = names.take(parent, safeName(r.name), true);
    const p = parent ? `${parent}/${seg}` : seg;
    out.set(id, p);
    return p;
  };
  for (const r of rows) resolve(Number(r.id), 0);
  return out;
}

interface DocMeta {
  id: number;
  folder_id: number | null;
  kind: DocKind;
  title: string;
  status: DocStatus;
  error: string | null;
  review_id: number | null;
  item_id: number | null;
  file_name: string | null;
  created_at: number;
  updated_at: number;
}

const markdown = (title: string, body: string) => {
  const b = String(body ?? '').replace(/^\s*\n/, '').trimEnd();
  return Buffer.from(b ? `# ${oneLine(title)}\n\n${b}\n` : `# ${oneLine(title)}\n`, 'utf8');
};

/** 原文件：必须是普通文件；读不到返回 null。读之前先按大小检查上限 */
function readOriginal(files: Pick<KbFiles, 'file'>, id: number, room: number): Buffer | null {
  let file: string;
  try {
    const f = files.file(id);
    if (!f) return null;
    file = f.path;
    const st = fs.lstatSync(file);
    if (!st.isFile()) return null;
    if (st.size > room) throw new KbError(413, TOO_BIG);
  } catch (e) {
    if (e instanceof KbError) throw e;
    return null;
  }
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function statusLabel(d: DocMeta): string {
  if (d.status === 'orphan') return '来源已删除';
  if (d.status === 'error') return `失败：${oneLine(d.error ?? '') || '未知错误'}`;
  if (d.status === 'processing') return '处理中';
  return '正常';
}

export function exportKb(db: DB, files: Pick<KbFiles, 'file'>, o: { tmpDir: string; max?: number }): { file: string; bytes: number; count: number } {
  const max = o.max ?? EXPORT_MAX;
  const names = new Names();
  names.take('', MANIFEST);
  const dirs = folderDirs(db, names);
  const docs = db
    .prepare('SELECT id, folder_id, kind, title, status, error, review_id, item_id, file_name, created_at, updated_at FROM kb_docs ORDER BY id')
    .all() as unknown as DocMeta[];
  const bodyOf = db.prepare('SELECT body FROM kb_docs WHERE id = ?');

  const file = path.join(o.tmpDir, `kb-export-${randomBytes(8).toString('hex')}.zip`);
  const zip = new ZipWriter(file);
  const add = (name: string, data: Buffer) => {
    zip.add(name, data);
    if (zip.size > max) throw new KbError(413, TOO_BIG);
  };
  const lines = [HEADER.join(',')];
  try {
    for (const d of docs) {
      const id = Number(d.id);
      const dir = d.folder_id == null ? '' : (dirs.get(Number(d.folder_id)) ?? '');
      const title = safeName(d.title);
      let status = statusLabel(d);
      let name: string;
      let data: Buffer;
      const orig = d.kind === 'upload' ? readOriginal(files, id, Math.max(0, max - zip.size)) : null;
      if (orig) {
        name = safeName(`${title}${extOf(d.file_name ?? '')}`);
        data = orig;
      } else {
        let body: string;
        if (d.kind === 'review' || d.kind === 'item') {
          const src = d.status === 'orphan' ? null : sourceText(db, d.kind, Number(d.kind === 'review' ? d.review_id : d.item_id));
          if (!src) status = '来源已删除';
          body = src ? (d.kind === 'item' ? src.text.replace(/^# [^\n]*\n+/, '') : src.text) : '';
        } else {
          body = String((bodyOf.get(id) as { body: string } | undefined)?.body ?? '');
          if (d.kind === 'upload') status = '原文件缺失，已导出正文';
        }
        name = safeName(`${title}.md`);
        data = markdown(d.title, body);
      }
      const rel = dir ? `${dir}/${names.take(dir, name)}` : names.take('', name);
      add(rel, data);
      lines.push(
        [rel, d.title, KIND_LABEL[d.kind] ?? d.kind, status, fmtTime(Number(d.created_at)), fmtTime(Number(d.updated_at)), d.kind === 'upload' ? d.file_name : null, data.length]
          .map(csvField)
          .join(','),
      );
    }
    add(MANIFEST, Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8'));
    const bytes = zip.close();
    if (bytes > max) throw new KbError(413, TOO_BIG);
    return { file, bytes, count: docs.length };
  } catch (e) {
    zip.abort();
    fs.rmSync(file, { force: true });
    throw e;
  }
}
