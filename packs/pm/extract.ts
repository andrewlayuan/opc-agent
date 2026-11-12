/** 附件类型判断与文字提取（txt / docx / xlsx / pptx / pdf）；不信任浏览器声明的类型 */
import { openZip } from './zip.ts';

export class ExtractError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Format = 'png' | 'jpeg' | 'gif' | 'webp' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text';

export interface Detected {
  format: Format;
  mime: string;
  kind: 'image' | 'doc';
}

export const MIME: Record<Format, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  text: 'text/plain',
};

export const UNSUPPORTED = '不支持的文件类型';
export const NOT_UTF8 = '请另存为 UTF-8 文本';
export const LEGACY_OFFICE = '旧版 Office 文件请另存为 docx / xlsx / pptx';
export const BROKEN = '文件损坏或结构不支持';
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'json']);

const det = (format: Format): Detected => ({ format, mime: MIME[format], kind: ['png', 'jpeg', 'gif', 'webp'].includes(format) ? 'image' : 'doc' });
const startsWith = (b: Buffer, bytes: number[]) => bytes.every((x, i) => b[i] === x);

export function detectType(buf: Buffer, name: string): Detected {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return det('png');
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return det('jpeg');
  const head = buf.subarray(0, 12).toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return det('gif');
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return det('webp');
  if (head.startsWith('%PDF-')) return det('pdf');
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0])) throw new ExtractError(415, LEGACY_OFFICE);
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    let names: Set<string>;
    try {
      names = new Set(openZip(buf).names);
    } catch {
      throw new ExtractError(415, UNSUPPORTED);
    }
    if (names.has('word/document.xml')) return det('docx');
    if (names.has('xl/workbook.xml')) return det('xlsx');
    if (names.has('ppt/presentation.xml')) return det('pptx');
    throw new ExtractError(415, UNSUPPORTED);
  }
  const ext = /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  if (TEXT_EXT.has(ext)) {
    if (buf.subarray(0, 8192).includes(0)) throw new ExtractError(415, NOT_UTF8);
    return det('text');
  }
  throw new ExtractError(415, UNSUPPORTED);
}

export function decodeText(buf: Buffer): string {
  if (buf.includes(0)) throw new ExtractError(415, NOT_UTF8);
  const body = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new ExtractError(415, NOT_UTF8);
  }
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) => {
    if (e[0] !== '#') return NAMED[e];
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : '\uFFFD';
  });
}

export function clampText(s: string, max = 20000): { text: string; origChars: number | null } {
  const t = s.trim();
  const cps = [...t];
  return cps.length > max ? { text: cps.slice(0, max).join(''), origChars: cps.length } : { text: t, origChars: null };
}

/** 包装 Office 解析：结构问题统一报 422「文件损坏或结构不支持」 */
function office(fn: () => string): string {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ExtractError) throw e;
    throw new ExtractError(422, BROKEN);
  }
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)="([^"]*)"/g)) out[m[1]] = decodeXml(m[2]);
  return out;
}

const texts = (xml: string, tag: string): string =>
  [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => decodeXml(m[1])).join('');

// ---------------- docx ----------------
function wpText(p: string): string {
  return texts(p, 'w:t');
}

export function extractDocx(buf: Buffer): string {
  return office(() => {
    const zip = openZip(buf);
    if (!zip.has('word/document.xml')) throw new ExtractError(422, BROKEN);
    const xml = zip
      .read('word/document.xml')
      .toString('utf8')
      .replace(/<w:tab\/>/g, '<w:t>\t</w:t>')
      .replace(/<w:(?:br|cr)\b[^>]*\/>/g, '<w:t>\n</w:t>');
    const out: string[] = [];
    for (const m of xml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
      const block = m[0];
      if (block.startsWith('<w:tbl')) {
        for (const row of block.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)) {
          const cells = [...row[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)].map((c) =>
            [...c[1].matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map((p) => wpText(p[1]).trim()).filter(Boolean).join(' '),
          );
          if (cells.some(Boolean)) out.push(cells.join(' | '));
        }
      } else {
        const t = wpText(block);
        if (t.trim()) out.push(t);
      }
    }
    return out.join('\n');
  });
}

// ---------------- xlsx ----------------
const XLSX_ROWS = 500;
const XLSX_COLS = 50;

function colIndex(ref: string | undefined): number | null {
  const letters = /^([A-Z]+)/.exec(ref ?? '')?.[1];
  if (!letters) return null;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function extractXlsx(buf: Buffer): string {
  return office(() => {
    const zip = openZip(buf);
    if (!zip.has('xl/workbook.xml')) throw new ExtractError(422, BROKEN);
    const wb = zip.read('xl/workbook.xml').toString('utf8');
    const rels = new Map<string, string>();
    if (zip.has('xl/_rels/workbook.xml.rels')) {
      for (const m of zip.read('xl/_rels/workbook.xml.rels').toString('utf8').matchAll(/<Relationship\b[^>]*>/g)) {
        const a = attrs(m[0]);
        if (a.Id && a.Target) rels.set(a.Id, a.Target.startsWith('/') ? a.Target.slice(1) : `xl/${a.Target.replace(/^\.\//, '')}`);
      }
    }
    const shared = zip.has('xl/sharedStrings.xml')
      ? [...zip.read('xl/sharedStrings.xml').toString('utf8').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1], 't'))
      : [];
    const out: string[] = [];
    for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
      const a = attrs(m[0]);
      const rid = Object.entries(a).find(([k]) => /^\w+:id$/.test(k))?.[1];
      const file = rid ? rels.get(rid) : undefined;
      if (!file || !zip.has(file)) continue;
      const xml = zip.read(file).toString('utf8');
      const lines: string[] = [];
      let truncated = false;
      for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        if (lines.length >= XLSX_ROWS) {
          truncated = true;
          break;
        }
        const cells: string[] = [];
        for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const ca = attrs(c[1]);
          const idx = colIndex(ca.r) ?? cells.length;
          if (idx >= XLSX_COLS) {
            truncated = true;
            continue;
          }
          const inner = c[2] ?? '';
          const v = texts(inner, 'v');
          const val = ca.t === 's' ? (shared[Number(v)] ?? '') : ca.t === 'inlineStr' ? texts(inner, 't') : v;
          while (cells.length < idx) cells.push('');
          cells[idx] = val.replace(/\s*\n\s*/g, ' ');
        }
        while (cells.length && !cells[cells.length - 1]) cells.pop();
        if (cells.length) lines.push(cells.join(' | '));
      }
      out.push(`## ${a.name ?? '工作表'}\n${lines.join('\n')}${truncated ? '\n（已截断）' : ''}`);
    }
    return out.join('\n\n');
  });
}

// ---------------- pptx ----------------
export function extractPptx(buf: Buffer): string {
  return office(() => {
    const zip = openZip(buf);
    const slides = zip.names
      .map((n) => ({ n, no: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(n)?.[1] ?? NaN) }))
      .filter((s) => Number.isFinite(s.no))
      .sort((a, b) => a.no - b.no);
    if (!slides.length && !zip.has('ppt/presentation.xml')) throw new ExtractError(422, BROKEN);
    return slides
      .map(({ n, no }) => {
        const xml = zip.read(n).toString('utf8');
        const lines = [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)].map((p) => texts(p[1], 'a:t')).filter((t) => t.trim());
        return [`## 第 ${no} 页`, ...lines].join('\n');
      })
      .join('\n\n');
  });
}
