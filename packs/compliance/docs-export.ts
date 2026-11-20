// 合规材料导出：Markdown、单文件 HTML（占位高亮）、Word（HTML 交给 LibreOffice 转换）
import type { DB } from '../../packages/core/db.ts';
import { escHtml, renderMdHtml } from '../../packages/core/mdhtml.ts';
import { convertHtmlToDocx } from '../pm/convert.ts';
import { safeName } from '../wiki/export.ts';
import { getDoc, loadCtx, type DocView } from './docs-store.ts';
import { CpError } from './store.ts';
import { PLACEHOLDER_RE, productName, v } from './templates.ts';

export type ExportFormat = 'md' | 'html' | 'docx';

export const DRAFT_NOTE = '草稿（未定稿），仅供参考，以属地主管部门口径为准';
export const AI_NOTE = '本材料由 AI 辅助起草，提交或公示前请由专业人士审核';

const TYPES: Record<ExportFormat, string> = {
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export function parseFormat(s: string | null): ExportFormat {
  if (s === 'md' || s === 'html' || s === 'docx') return s;
  throw new CpError(400, '导出格式不对');
}

const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
function cnNum(n: number): string {
  if (n < 10) return DIGITS[n];
  if (n < 20) return `十${n % 10 ? DIGITS[n % 10] : ''}`;
  if (n < 100) return `${DIGITS[Math.floor(n / 10)]}十${n % 10 ? DIGITS[n % 10] : ''}`;
  return String(n);
}

/** 东八区日期 */
function ymd(at: number): [string, string, string] {
  const d = new Date(at + 8 * 3600 * 1000);
  return [String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')];
}

export function exportFileName(product: string, docName: string, at: number, ext: string): string {
  return `${safeName(product)}-${docName}-${ymd(at).join('')}.${ext}`;
}

interface Parts { doc: DocView; title: string; meta: string; draft: boolean; sections: { heading: string; body: string }[]; productLabel: string }

function parts(db: DB, docId: number, now: number): Parts {
  const doc = getDoc(db, docId, now);
  const { ctx } = loadCtx(db, doc.product_id);
  const sections = doc.sections.filter((s) => !s.removed).map((s, i) => ({ heading: `${cnNum(i + 1)}、${s.title}`, body: s.body }));
  return {
    doc, title: doc.name, draft: doc.status !== 'final', sections, productLabel: ctx.product.name,
    meta: `产品：${productName(ctx)}　主体：${v(ctx, 'entity.company_name')}　日期：${ymd(now).join('-')}`,
  };
}

export function docMarkdown(db: DB, docId: number, now = Date.now()): string {
  const p = parts(db, docId, now);
  const out = [`# ${p.title}`, p.meta];
  if (p.draft) out.push(`> ${DRAFT_NOTE}`);
  for (const s of p.sections) out.push(`## ${s.heading}\n\n${s.body.trim()}`);
  out.push('---', AI_NOTE);
  return `${out.join('\n\n')}\n`;
}

const STYLE = [
  'body{font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif;font-size:15px;line-height:1.75;color:#222;max-width:820px;margin:32px auto;padding:0 20px}',
  'h1{font-size:24px;text-align:center;margin:0 0 8px}',
  'h2{font-size:19px;margin:28px 0 10px}',
  'h3{font-size:16px;margin:20px 0 8px}',
  '.meta{text-align:center;color:#666;font-size:13px}',
  '.draft{border:1px solid #f0c36d;background:#fff8e1;padding:8px 12px;color:#8a6d3b}',
  'table{border-collapse:collapse;width:100%;margin:10px 0}',
  'th,td{border:1px solid #bbb;padding:6px 8px;text-align:left;vertical-align:top}',
  'th{background:#f3f3f3}',
  'blockquote{border-left:3px solid #ccc;margin:10px 0;padding:2px 12px;color:#555}',
  '.ai{color:#888;font-size:13px;border-top:1px solid #ddd;margin-top:32px;padding-top:12px}',
].join('\n');

export function docHtml(db: DB, docId: number, now = Date.now()): string {
  const p = parts(db, docId, now);
  const body = [
    `<h1>${escHtml(p.title)}</h1>`,
    `<p class="meta">${renderInline(p.meta)}</p>`,
    p.draft ? `<p class="draft">${escHtml(DRAFT_NOTE)}</p>` : '',
    ...p.sections.map((s) => `<h2>${escHtml(s.heading)}</h2>\n${renderMdHtml(s.body, { mark: true })}`),
    `<p class="ai">${escHtml(AI_NOTE)}</p>`,
  ].filter(Boolean).join('\n');
  return `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<title>${escHtml(p.title)}</title>\n<style>\n${STYLE}\n</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

/** 抬头一行：先转义，再高亮占位 */
function renderInline(s: string): string {
  return escHtml(s).replace(PLACEHOLDER_RE, (m) => `<mark style="background:#ffeb3b">${m}</mark>`);
}

export async function exportDoc(
  db: DB, docId: number, format: ExportFormat, o: { convert?: (html: string) => Promise<Buffer>; now?: number } = {},
): Promise<{ body: Buffer; type: string; name: string }> {
  const now = o.now ?? Date.now();
  const p = parts(db, docId, now);
  const name = exportFileName(p.productLabel, p.doc.name, now, format);
  if (format === 'md') return { body: Buffer.from(docMarkdown(db, docId, now), 'utf8'), type: TYPES.md, name };
  const html = docHtml(db, docId, now);
  if (format === 'html') return { body: Buffer.from(html, 'utf8'), type: TYPES.html, name };
  const body = await (o.convert ?? ((h: string) => convertHtmlToDocx(h)))(html);
  return { body, type: TYPES.docx, name };
}
