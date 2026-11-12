/** 附件类型判断与文字提取（txt / docx / xlsx / pptx / pdf）；不信任浏览器声明的类型 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
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
export const NO_TEXT = '未提取到文字内容';
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

const SML_NS = /xmlns:([A-Za-z_][\w.-]*)="(?:http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main|http:\/\/purl\.oclc\.org\/ooxml\/spreadsheetml\/main)"/;

/** 主命名空间可能带前缀（如 OpenXML SDK 写成 <x:row>），去掉该前缀后再按元素名匹配 */
function smlXml(buf: Buffer): string {
  const xml = buf.toString('utf8');
  const p = SML_NS.exec(xml)?.[1];
  return p ? xml.replace(new RegExp(`<(/?)${p.replace(/\./g, '\\.')}:`, 'g'), '<$1') : xml;
}

// 内置日期/时间格式（46 为 [h]:mm:ss 时长，不算日期）
const DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateCode(code: string): boolean {
  if (/\[[hms]+\]/i.test(code)) return false;
  return /[ymdhs]/i.test(code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, ''));
}

/** 读 styles.xml，返回数字格式为日期/时间的单元格样式下标 */
function dateStyles(zip: ReturnType<typeof openZip>): Set<number> {
  const out = new Set<number>();
  if (!zip.has('xl/styles.xml')) return out;
  const xml = smlXml(zip.read('xl/styles.xml'));
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt\b[^>]*>/g)) {
    const a = attrs(m[0]);
    custom.set(Number(a.numFmtId), a.formatCode ?? '');
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
  [...xfs.matchAll(/<xf\b[^>]*>/g)].forEach((m, i) => {
    const id = Number(attrs(m[0]).numFmtId ?? 0);
    const code = custom.get(id);
    if (code !== undefined ? isDateCode(code) : DATE_FMT_IDS.has(id)) out.add(i);
  });
  return out;
}

/** Excel 序列号转日期：1900 纪年以 1899-12-30 为 0；1904 纪年再加 1462 天 */
function serialDate(v: string, base1904: boolean): string {
  const n = Number(v);
  if (!v.trim() || !Number.isFinite(n) || n < 0 || n > 2958465) return v;
  const iso = new Date(Date.UTC(1899, 11, 30) + Math.round((n + (base1904 ? 1462 : 0)) * 86400000)).toISOString();
  if (n < 1 && !base1904) return iso.slice(11, 16);
  return n % 1 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

export function extractXlsx(buf: Buffer): string {
  return office(() => {
    const zip = openZip(buf);
    if (!zip.has('xl/workbook.xml')) throw new ExtractError(422, BROKEN);
    const wb = smlXml(zip.read('xl/workbook.xml'));
    const rels = new Map<string, string>();
    if (zip.has('xl/_rels/workbook.xml.rels')) {
      for (const m of zip.read('xl/_rels/workbook.xml.rels').toString('utf8').matchAll(/<Relationship\b[^>]*>/g)) {
        const a = attrs(m[0]);
        if (a.Id && a.Target) rels.set(a.Id, a.Target.startsWith('/') ? a.Target.slice(1) : `xl/${a.Target.replace(/^\.\//, '')}`);
      }
    }
    const shared = zip.has('xl/sharedStrings.xml')
      ? [...smlXml(zip.read('xl/sharedStrings.xml')).replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1], 't'))
      : [];
    const dates = dateStyles(zip);
    const base1904 = /<workbookPr\b[^>]*\bdate1904="(?:1|true)"/.test(wb);
    const out: string[] = [];
    let total = 0;
    for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
      const a = attrs(m[0]);
      const rid = Object.entries(a).find(([k]) => /^\w+:id$/.test(k))?.[1];
      const file = rid ? rels.get(rid) : undefined;
      if (!file || !zip.has(file)) continue;
      const xml = smlXml(zip.read(file));
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
          const val =
            ca.t === 's' ? (shared[Number(v)] ?? '') : ca.t === 'inlineStr' ? texts(inner, 't') : (!ca.t || ca.t === 'n') && ca.s && dates.has(Number(ca.s)) ? serialDate(v, base1904) : v;
          while (cells.length < idx) cells.push('');
          cells[idx] = val.replace(/\s*\n\s*/g, ' ');
        }
        while (cells.length && !cells[cells.length - 1]) cells.pop();
        if (cells.length) lines.push(cells.join(' | '));
      }
      total += lines.length;
      out.push(`## ${a.name ?? '工作表'}\n${lines.join('\n')}${truncated ? '\n（已截断）' : ''}`);
    }
    return total ? out.join('\n\n') : '';
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

// ---------------- worker 隔离 ----------------
export const OFFICE_TIMEOUT_MS = 20000;

/**
 * 在 worker 中运行 docx / xlsx / pptx 提取：超时或内存超限就终止 worker，报 422「文件损坏或结构不支持」。
 * 正则对构造的未闭合标签是平方级，放在主线程会卡住整个服务。
 */
export function extractOffice(format: 'docx' | 'xlsx' | 'pptx', buf: Buffer, timeoutMs: number = OFFICE_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./office-worker.ts', import.meta.url), {
      workerData: { format, buf },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
      stdout: true,
      stderr: true,
    });
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
      void w.terminate();
    };
    const timer = setTimeout(() => finish(() => reject(new ExtractError(422, BROKEN))), timeoutMs);
    w.on('message', (m: { ok: true; text: string } | { ok: false; status: number; message: string }) =>
      finish(() => (m.ok ? resolve(m.text) : reject(new ExtractError(m.status, m.message || BROKEN)))),
    );
    w.on('error', () => finish(() => reject(new ExtractError(422, BROKEN))));
    w.on('exit', () => finish(() => reject(new ExtractError(422, BROKEN))));
  });
}

// ---------------- pdf ----------------
export type ExecFn = (file: string, args: string[], opts: { timeout: number; maxBuffer: number; killSignal: 'SIGKILL' }) => Promise<{ stdout: string; stderr: string }>;

const execFileP = promisify(execFile);
export const realExec: ExecFn = async (file, args, opts) => {
  const r = await execFileP(file, args, { ...opts, encoding: 'utf8', windowsHide: true });
  return { stdout: String(r.stdout), stderr: String(r.stderr) };
};

export const PDF_MISSING = '服务器未安装 PDF 解析工具（poppler-utils）';
export const PDF_TIMEOUT = 'PDF 解析超时';
export const PDF_PASSWORD = 'PDF 有密码保护';
export const PDF_SCANNED = '未提取到文字，可能是扫描件，请截图上传';

/** 调用 pdftotext（不经 shell、限时、限输出），最多读 200 页 */
export async function extractPdf(file: string, exec: ExecFn = realExec): Promise<string> {
  let stdout: string;
  try {
    stdout = (await exec('pdftotext', ['-enc', 'UTF-8', '-l', '200', file, '-'], { timeout: 20000, maxBuffer: 2 * 1024 * 1024, killSignal: 'SIGKILL' })).stdout;
  } catch (e) {
    const err = e as { code?: unknown; killed?: boolean; signal?: string; stderr?: unknown; stdout?: unknown; message?: string };
    if (err.code === 'ENOENT') throw new ExtractError(422, PDF_MISSING);
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') stdout = String(err.stdout ?? '');
    else if (err.killed || err.signal === 'SIGKILL') throw new ExtractError(422, PDF_TIMEOUT);
    else if (/Incorrect password/i.test(`${String(err.stderr ?? '')}\n${err.message ?? ''}`)) throw new ExtractError(422, PDF_PASSWORD);
    else throw new ExtractError(422, BROKEN);
  }
  if ([...stdout.replace(/\s+/g, '')].length < 20) throw new ExtractError(422, PDF_SCANNED);
  return stdout.replace(/\f/g, '\n\n').trim();
}
