// Wiki 导出：按范围选页，生成 .md / .docx，打成 zip。路径全部由程序拼接，文件名先清洗
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../../packages/core/db.ts';
import { UNFILED, folderPath } from '../kb/folders.ts';
import { escHtml, renderMdHtml, type MdCtx } from '../../packages/core/mdhtml.ts';
import { convertHtmlToDocx } from '../pm/convert.ts';
import { CITE_RE, LINK_RE, parseBody, slugify } from './parse.ts';
import { listOps } from './store.ts';
import type { OpRow, PageRow } from './store.ts';
import { KIND_LABEL, WIKI_LIMITS, WikiError, isPageKind } from './types.ts';
import type { OpKind, OpStatus, PageKind } from './types.ts';
import { ZipWriter } from './zip.ts';

export type ExportScope = { all: true } | { kind: PageKind } | { folder: number } | { page: string };

export interface ExportOpts {
  assetsDir: string;
  tmpDir: string;
  convert?: (html: string) => Promise<Buffer>;
  /** 测试用：覆盖 WIKI_LIMITS.exportMax */
  exportMax?: number;
}

const TOO_BIG = '导出内容超过 200MB，请按目录导出';
const KIND_ORDER: PageKind[] = ['overview', 'entity', 'concept', 'compare', 'answer', 'source'];
const COLS = 'id, slug, kind, title, summary, body, source_doc, edited_by_user, deleted, rev, created_at, updated_at';
const LOG_OPS = 200;

export function parseScope(raw: string): ExportScope {
  const s = String(raw ?? '');
  if (s === 'all') return { all: true };
  const k = /^kind:([a-z]+)$/.exec(s);
  if (k && isPageKind(k[1])) return { kind: k[1] };
  const f = /^folder:([1-9]\d{0,9})$/.exec(s);
  if (f && Number.isSafeInteger(Number(f[1]))) return { folder: Number(f[1]) };
  const p = /^page:(.+)$/.exec(s);
  if (p && slugify(p[1]) === p[1]) return { page: p[1] };
  throw new WikiError(400, '导出范围不合法');
}

const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** 文件名清洗：危险字符和控制字符换成空格，去掉开头的点，最长 80 个码点 */
export function safeName(title: string): string {
  let s = String(title ?? '')
    .normalize('NFC')
    .replace(/[/\\:*?"<>|\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '');
  if (WIN_RESERVED.test(s)) s = `_${s}`;
  const cps = [...s];
  if (cps.length > 80) s = cps.slice(0, 80).join('');
  s = s.replace(/[.\s]+$/, '');
  return s || '未命名';
}

const oneLine = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim();

function citeLabel(db: DB, doc: number, ord: number): string {
  const r = db.prepare('SELECT d.title AS title, c.heading AS heading FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id WHERE c.doc_id = ? AND c.ord = ?').get(doc, ord) as
    | { title: string; heading: string }
    | undefined;
  if (!r) return `资料已失效（${doc}:${ord}）`;
  const h = oneLine(r.heading);
  return h ? `${oneLine(r.title)} › ${h}` : oneLine(r.title);
}

/** 按出现顺序给引用编号 */
function citeNumbering(db: DB) {
  const nums = new Map<string, number>();
  const notes: string[] = [];
  return {
    notes,
    num(doc: number, ord: number): number {
      const key = `${doc}:${ord}`;
      let n = nums.get(key);
      if (!n) {
        n = nums.size + 1;
        nums.set(key, n);
        notes.push(citeLabel(db, doc, ord));
      }
      return n;
    },
  };
}

const IMG_RE = /!\[([^\]\n]*)\]\(asset:(\d{1,9})\)/g;

/** 导出用 Markdown：YAML 元数据；[[slug|x]] → [[标题]]；[^d:o] → [^n] 脚注；assets 给出时把图片改写为相对路径 */
export function pageToMarkdown(db: DB, page: PageRow, titles: Map<string, string>, assets?: Map<number, string>): string {
  const cites = citeNumbering(db);
  let body = String(page.body).replace(LINK_RE, (_all, target: string, label: string | undefined) => {
    const s = slugify(target);
    const t = (s && titles.get(s)) || oneLine(label ?? '') || oneLine(target);
    return `[[${t.replace(/[[\]|]/g, ' ').trim() || '未命名'}]]`;
  });
  body = body.replace(CITE_RE, (_all, d: string, o: string) => `[^${cites.num(Number(d), Number(o))}]`);
  if (assets) {
    body = body.replace(IMG_RE, (_all, alt: string, id: string) => {
      const rel = assets.get(Number(id));
      return rel ? `![${alt}](<${rel}>)` : `${alt || '图片'}（图片缺失）`;
    });
  }
  const head = ['---', `slug: ${page.slug}`, `kind: ${page.kind}`, `updated: ${new Date(page.updated_at).toISOString()}`, '---', '', `# ${oneLine(page.title)}`, '', ''].join('\n');
  const notes = cites.notes.length ? `\n${cites.notes.map((n, i) => `[^${i + 1}]: ${n}`).join('\n')}\n` : '';
  return `${head}${body.trimEnd()}\n${notes}`;
}

// ---------------- HTML（供 LibreOffice 转 docx） ----------------

const esc = escHtml;

const MIME_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const STORAGE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(\.[A-Za-z0-9]{1,8})?$/;

/** 读取图片：只认白名单类型；storage 必须是单个安全文件名，且是普通文件 */
function readAsset(db: DB, dir: string, id: number): { mime: string; ext: string; buf: Buffer } | null {
  const r = db.prepare('SELECT mime, storage FROM wiki_assets WHERE id = ?').get(id) as { mime: string; storage: string } | undefined;
  if (!r || !MIME_EXT[r.mime] || !STORAGE_RE.test(r.storage)) return null;
  const file = path.join(dir, r.storage);
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > WIKI_LIMITS.assetMax) return null;
    return { mime: r.mime, ext: MIME_EXT[r.mime], buf: fs.readFileSync(file) };
  } catch {
    return null;
  }
}

/** 导出用 HTML：只生成 h1-h4、p、ul/ol/li、blockquote、pre、strong、em、img；图片以 data: 内嵌，不含任何外部资源 */
export function pageToHtml(db: DB, page: PageRow, assetsDir: string): string {
  const cites = citeNumbering(db);
  const titleOf = (slug: string) => (db.prepare('SELECT title FROM wiki_pages WHERE slug = ? AND deleted = 0').get(slug) as { title: string } | undefined)?.title;
  const ctx: MdCtx = {
    link: (target, label) => oneLine(label ?? '') || (titleOf(slugify(target)) ?? '') || oneLine(target),
    cite: (d, o) => cites.num(d, o),
    img: (id, alt) => {
      const a = readAsset(db, assetsDir, id);
      return a ? `<img alt="${esc(alt)}" src="data:${a.mime};base64,${a.buf.toString('base64')}">` : esc(`${alt || '图片'}（图片缺失）`);
    },
  };
  const body = renderMdHtml(page.body, ctx);
  const notes = cites.notes.length ? `\n<h4>出处</h4>\n<ol>${cites.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ol>` : '';
  const title = esc(oneLine(page.title));
  return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${title}</title></head><body>\n<h1>${title}</h1>\n${body}${notes}\n</body></html>\n`;
}

// ---------------- 选页与打包 ----------------

function selectPages(db: DB, scope: ExportScope): PageRow[] {
  if ('all' in scope) return db.prepare(`SELECT ${COLS} FROM wiki_pages WHERE deleted = 0`).all() as unknown as PageRow[];
  if ('kind' in scope) return db.prepare(`SELECT ${COLS} FROM wiki_pages WHERE deleted = 0 AND kind = ?`).all(scope.kind) as unknown as PageRow[];
  if ('page' in scope) {
    const one = db.prepare(`SELECT ${COLS} FROM wiki_pages WHERE deleted = 0 AND slug = ?`).all(scope.page) as unknown as PageRow[];
    if (!one.length) throw new WikiError(404, '页面不存在');
    return one;
  }
  const rows = db.prepare('SELECT id, parent_id FROM kb_folders').all() as { id: number; parent_id: number | null }[];
  if (!rows.some((r) => r.id === scope.folder)) throw new WikiError(404, '目录不存在');
  const folders = new Set([scope.folder]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) {
      if (r.parent_id != null && folders.has(r.parent_id) && !folders.has(r.id)) {
        folders.add(r.id);
        grew = true;
      }
    }
  }
  const bySource = db.prepare(`SELECT ${COLS} FROM wiki_pages WHERE deleted = 0 AND kind = 'source' AND source_doc IN (SELECT id FROM kb_docs WHERE folder_id = ?)`);
  const linked = db.prepare(
    `SELECT ${COLS} FROM wiki_pages WHERE deleted = 0 AND kind IN ('entity', 'concept', 'compare') AND slug IN (SELECT to_slug FROM wiki_links WHERE from_page = ?)`,
  );
  const out = new Map<number, PageRow>();
  for (const f of folders) for (const p of bySource.all(f) as unknown as PageRow[]) out.set(p.id, p);
  for (const s of [...out.values()]) for (const p of linked.all(s.id) as unknown as PageRow[]) out.set(p.id, p);
  return [...out.values()];
}

function pageDir(db: DB, p: PageRow): string {
  if (p.kind !== 'source') return KIND_LABEL[p.kind];
  const doc = p.source_doc == null ? undefined : (db.prepare('SELECT folder_id FROM kb_docs WHERE id = ?').get(p.source_doc) as { folder_id: number | null } | undefined);
  const segs = (doc ? folderPath(db, doc.folder_id) : UNFILED).split('/').filter((x) => x.trim()).map(safeName);
  return [KIND_LABEL.source, ...(segs.length ? segs : [UNFILED])].join('/');
}

const OP_LABEL: Record<OpKind, string> = {
  ingest: '摄入',
  lint: '体检',
  fix: '自动修复',
  generate: '生成缺页',
  query_save: '存为问答',
  edit: '编辑',
  restore: '恢复版本',
  revert: '撤销',
  ask: '提问',
};
const STATUS_LABEL: Record<OpStatus, string> = { queued: '排队中', running: '进行中', done: '完成', error: '失败', reverted: '已撤销' };
const pad = (n: number) => String(n).padStart(2, '0');
const fmtTime = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function opLine(op: OpRow): string {
  const parts = [`${fmtTime(op.created_at)} #${op.id} ${OP_LABEL[op.kind] ?? op.kind}`, STATUS_LABEL[op.status] ?? op.status];
  if (op.doc_id != null) parts.push(`资料 ${op.doc_id}`);
  if (op.target_op != null) parts.push(`目标操作 #${op.target_op}`);
  if (op.pages.length) {
    const slugs = op.pages.slice(0, 20).map((c) => c.slug);
    parts.push(`页面：${slugs.join('、')}${op.pages.length > 20 ? ` 等 ${op.pages.length} 页` : ''}`);
  }
  if (op.error) parts.push(`错误：${oneLine(op.error).slice(0, 200)}`);
  return `- ${parts.join(' · ')}`;
}

export async function exportWiki(db: DB, scope: ExportScope, o: ExportOpts): Promise<{ file: string; bytes: number }> {
  const pages = selectPages(db, scope).sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.title.localeCompare(b.title, 'zh-Hans-CN') || a.id - b.id,
  );
  const titles = new Map((db.prepare('SELECT slug, title FROM wiki_pages WHERE deleted = 0').all() as { slug: string; title: string }[]).map((r) => [r.slug, oneLine(r.title)]));
  const used = new Map<string, Set<string>>();
  const placed = pages.map((p) => {
    const dir = pageDir(db, p);
    const taken = used.get(dir) ?? new Set<string>();
    used.set(dir, taken);
    const base = safeName(p.title);
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n})`;
    taken.add(name.toLowerCase());
    titles.set(p.slug, name);
    return { page: p, dir, name };
  });

  const max = o.exportMax ?? WIKI_LIMITS.exportMax;
  const convert = o.convert ?? ((html: string) => convertHtmlToDocx(html));
  const file = path.join(o.tmpDir, `wiki-export-${crypto.randomBytes(8).toString('hex')}.zip`);
  const zip = new ZipWriter(file);
  const add = (name: string, data: Buffer) => {
    zip.add(name, data);
    if (zip.size > max) throw new WikiError(413, TOO_BIG);
  };
  const notes: string[] = [];
  try {
    for (const { page, dir, name } of placed) {
      const ids = parseBody(page.body).assets;
      if (ids.length) {
        let docx: Buffer | null = null;
        try {
          docx = await convert(pageToHtml(db, page, o.assetsDir));
        } catch (e) {
          notes.push(`- 「${oneLine(page.title)}」转换 Word 失败（${oneLine((e as Error)?.message ?? String(e)).slice(0, 200)}），已改为 Markdown`);
        }
        if (docx) {
          add(`${dir}/${name}.docx`, docx);
          continue;
        }
      }
      const rel = new Map<number, string>();
      for (const id of ids) {
        const a = readAsset(db, o.assetsDir, id);
        if (!a) continue;
        rel.set(id, `${name}.assets/${id}.${a.ext}`);
        add(`${dir}/${name}.assets/${id}.${a.ext}`, a.buf);
      }
      add(`${dir}/${name}.md`, Buffer.from(pageToMarkdown(db, page, titles, ids.length ? rel : undefined), 'utf8'));
    }

    const index = ['# Wiki 索引', '', `导出时间：${fmtTime(Date.now())}，共 ${placed.length} 页`, ''];
    for (const k of KIND_ORDER) {
      const group = placed.filter((x) => x.page.kind === k);
      if (!group.length) continue;
      index.push(`## ${KIND_LABEL[k]}`, '');
      for (const g of group) index.push(`- [[${g.name}]]${oneLine(g.page.summary) ? `：${oneLine(g.page.summary)}` : ''}`);
      index.push('');
    }
    add('index.md', Buffer.from(index.join('\n'), 'utf8'));

    const log = ['# 操作日志', ''];
    if (notes.length) log.push('## 本次导出', '', ...notes, '');
    log.push(`## 最近 ${LOG_OPS} 条操作`, '', ...listOps(db, { limit: LOG_OPS }).map(opLine), '');
    add('log.md', Buffer.from(log.join('\n'), 'utf8'));

    const bytes = zip.close();
    if (bytes > max) throw new WikiError(413, TOO_BIG);
    return { file, bytes };
  } catch (e) {
    zip.abort();
    fs.rmSync(file, { force: true });
    throw e;
  }
}
