/** 附件与知识库共用的类型判断与文字提取（文本 / HTML / Office / PDF；旧版 Office、RTF、ODF 经 LibreOffice 转换，见 convert.ts）；不信任浏览器声明的类型 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { oleRootNames } from './ole.ts';
import { openZip } from './zip.ts';

export class ExtractError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Format = 'png' | 'jpeg' | 'gif' | 'webp' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text' | 'html' | LegacyFormat;
/** 需要先经 LibreOffice 转成 docx / xlsx / pptx 的格式 */
export type LegacyFormat = 'doc' | 'xls' | 'ppt' | 'rtf' | 'odt' | 'ods' | 'odp';
export type OfficeFormat = 'docx' | 'xlsx' | 'pptx' | 'html';

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
  html: 'text/html',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  rtf: 'application/rtf',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
};

export const UNSUPPORTED = '不支持的文件类型';
export const NOT_UTF8 = '请另存为 UTF-8 文本';
export const ENCRYPTED = '文件有密码保护，请去掉密码后再上传';
export const BROKEN = '文件损坏或结构不支持';
export const NO_TEXT = '未提取到文字内容';
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'yaml', 'yml', 'xml']);
const HTML_EXT = new Set(['html', 'htm', 'xhtml']);
const ODF = /^application\/vnd\.oasis\.opendocument\.(text|spreadsheet|presentation)(?:-template)?$/;
const ODF_FORMAT = { text: 'odt', spreadsheet: 'ods', presentation: 'odp' } as const;
const utf16Bom = (b: Buffer) => (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff);

const det = (format: Format): Detected => ({ format, mime: MIME[format], kind: ['png', 'jpeg', 'gif', 'webp'].includes(format) ? 'image' : 'doc' });
const startsWith = (b: Buffer, bytes: number[]) => bytes.every((x, i) => b[i] === x);

export function detectType(buf: Buffer, name: string): Detected {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return det('png');
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return det('jpeg');
  const head = buf.subarray(0, 12).toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return det('gif');
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return det('webp');
  if (head.startsWith('%PDF-')) return det('pdf');
  if (head.startsWith('{\\rtf')) return det('rtf');
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    // OLE 复合文档：按根目录的流名区分；加密的 docx/xlsx/pptx 也是这种容器
    const names = oleRootNames(buf);
    if (!names) throw new ExtractError(415, BROKEN);
    if (names.includes('EncryptedPackage')) throw new ExtractError(415, ENCRYPTED);
    if (names.includes('WordDocument')) return det('doc');
    if (names.includes('Workbook') || names.includes('Book')) return det('xls');
    if (names.includes('PowerPoint Document')) return det('ppt');
    throw new ExtractError(415, UNSUPPORTED);
  }
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    let zip: ReturnType<typeof openZip>;
    try {
      zip = openZip(buf);
    } catch {
      throw new ExtractError(415, UNSUPPORTED);
    }
    if (zip.has('word/document.xml')) return det('docx');
    if (zip.has('xl/workbook.xml')) return det('xlsx');
    if (zip.has('ppt/presentation.xml')) return det('pptx');
    if (zip.has('mimetype')) {
      let m: RegExpExecArray | null = null;
      try {
        m = ODF.exec(zip.read('mimetype').toString('latin1').trim());
        if (m && zip.has('META-INF/manifest.xml') && zip.read('META-INF/manifest.xml').includes('encryption-data')) throw new ExtractError(415, ENCRYPTED);
      } catch (e) {
        if (e instanceof ExtractError) throw e;
        throw new ExtractError(415, BROKEN);
      }
      if (m) return det(ODF_FORMAT[m[1] as keyof typeof ODF_FORMAT]);
    }
    throw new ExtractError(415, UNSUPPORTED);
  }
  const ext = /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  // 扩展名不是文本类时也按内容识别 HTML（例如另存为 .doc 的网页）
  const html = HTML_EXT.has(ext) || (!TEXT_EXT.has(ext) && looksHtml(buf));
  if (html || TEXT_EXT.has(ext)) {
    if (!utf16Bom(buf) && buf.subarray(0, 8192).includes(0)) throw new ExtractError(415, NOT_UTF8);
    return det(html ? 'html' : 'text');
  }
  throw new ExtractError(415, UNSUPPORTED);
}

/** 开头（跳过 BOM、空白、XML 声明和注释）是 <!doctype html> 或 <html> */
function looksHtml(buf: Buffer): boolean {
  const s = buf.subarray(0, 1024).toString('latin1').replace(/^\xef\xbb\xbf/, '').trimStart().toLowerCase();
  return /^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype html|<html[\s>])/.test(s);
}

function strict(enc: string, b: Uint8Array): string {
  try {
    return new TextDecoder(enc, { fatal: true }).decode(b);
  } catch {
    throw new ExtractError(415, NOT_UTF8);
  }
}

/** 有 UTF-16 BOM 按 UTF-16；否则先按 UTF-8，失败再按 GB18030（兼容 GBK / GB2312） */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return strict('utf-16le', buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return strict('utf-16be', buf.subarray(2));
  if (buf.includes(0)) throw new ExtractError(415, NOT_UTF8);
  const body = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return strict('gb18030', body);
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
const XLSX_ROWS = 5000;
const XLSX_COLS = 50;
/** 全部工作表合计的字数预算：超出后截断，避免大表格超过知识库单篇正文上限而整篇失败 */
const XLSX_CHARS = 150000;

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
    let chars = 0;
    for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
      const a = attrs(m[0]);
      const rid = Object.entries(a).find(([k]) => /^\w+:id$/.test(k))?.[1];
      const file = rid ? rels.get(rid) : undefined;
      if (!file || !zip.has(file)) continue;
      if (chars >= XLSX_CHARS) {
        out.push('（篇幅已达上限，其余工作表未读取）');
        break;
      }
      const xml = smlXml(zip.read(file));
      const lines: string[] = [];
      let truncated = false;
      for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        if (lines.length >= XLSX_ROWS || chars >= XLSX_CHARS) {
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
        if (cells.length) {
          const line = cells.join(' | ');
          lines.push(line);
          chars += line.length + 1;
        }
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
 * 在 worker 中运行 docx / xlsx / pptx / html 提取：超时或内存超限就终止 worker，报 422「文件损坏或结构不支持」。
 * 正则对构造的未闭合标签是平方级，放在主线程会卡住整个服务。
 */
export function extractOffice(format: OfficeFormat, buf: Buffer, timeoutMs: number = OFFICE_TIMEOUT_MS): Promise<string> {
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
export const PDF_SCANNED = '未识别到文字，可能是扫描件不清晰或页面没有文字';
export const OCR_MISSING = '未提取到文字，可能是扫描件；服务器未安装 OCR 工具（tesseract）';
export const OCR_NOTE = '（以下内容由 OCR 从扫描页识别，可能有错字）';
export const OCR_PAGES = 20;
const OCR_BUDGET_MS = 120_000;
const MIN_CHARS = 20;

type ExecErr = { code?: unknown; killed?: boolean; signal?: string; stderr?: unknown; stdout?: unknown; message?: string };
const killed = (e: ExecErr) => e.killed === true || e.signal === 'SIGKILL';
const cpLen = (s: string) => [...s.replace(/\s+/g, '')].length;
const CJK = '\\u2e80-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
/** tesseract 中文结果常在汉字之间插空格，只去掉两侧都是中日韩字符或全角标点的空格 */
const joinCjk = (s: string) => s.replace(new RegExp(`(?<=[${CJK}])[ \\t]+(?=[${CJK}])`, 'g'), '');

export interface PdfOpts {
  /** 测试用：时钟与 OCR 总预算 */
  now?: () => number;
  ocrBudgetMs?: number;
}

/** 调用 pdftotext（不经 shell、限时、限输出），最多读 200 页；文字层为空时退回 OCR */
export async function extractPdf(file: string, exec: ExecFn = realExec, opts: PdfOpts = {}): Promise<string> {
  let stdout: string;
  try {
    stdout = (await exec('pdftotext', ['-enc', 'UTF-8', '-l', '200', file, '-'], { timeout: 20000, maxBuffer: 2 * 1024 * 1024, killSignal: 'SIGKILL' })).stdout;
  } catch (e) {
    const err = e as ExecErr;
    if (err.code === 'ENOENT') throw new ExtractError(422, PDF_MISSING);
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') stdout = String(err.stdout ?? '');
    else if (killed(err)) throw new ExtractError(422, PDF_TIMEOUT);
    else if (/Incorrect password/i.test(`${String(err.stderr ?? '')}\n${err.message ?? ''}`)) throw new ExtractError(422, PDF_PASSWORD);
    else throw new ExtractError(422, BROKEN);
  }
  if (cpLen(stdout) >= MIN_CHARS) return stdout.replace(/\f/g, '\n\n').trim();
  const ocr = await ocrPdf(file, exec, opts);
  if (cpLen(ocr) < MIN_CHARS) throw new ExtractError(422, PDF_SCANNED);
  return `${OCR_NOTE}\n\n${ocr}`;
}

/**
 * 扫描件：pdftoppm 把前 20 页渲染成 200dpi 灰度 PNG（放在临时目录），再逐页交给 tesseract（简体中文 + 英文）。
 * 单页失败或超时跳过该页；总时长超出预算时停止并在末尾注明；临时目录总会删除
 */
async function ocrPdf(file: string, exec: ExecFn, opts: PdfOpts): Promise<string> {
  const now = opts.now ?? Date.now;
  const budget = opts.ocrBudgetMs ?? OCR_BUDGET_MS;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-ocr-'));
  try {
    try {
      await exec('pdftoppm', ['-r', '200', '-gray', '-png', '-l', String(OCR_PAGES), file, path.join(dir, 'p')], { timeout: 60000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL' });
    } catch (e) {
      const err = e as ExecErr;
      if (err.code === 'ENOENT') throw new ExtractError(422, PDF_MISSING);
      if (killed(err)) throw new ExtractError(422, PDF_TIMEOUT);
      throw new ExtractError(422, BROKEN);
    }
    const pages = fs
      .readdirSync(dir)
      .map((n) => ({ n, page: Number(/^p-(\d+)\.png$/.exec(n)?.[1]) }))
      .filter((p) => Number.isInteger(p.page))
      .sort((a, b) => a.page - b.page);
    const start = now();
    const texts: string[] = [];
    let done = 0;
    for (const p of pages) {
      if (now() - start >= budget) break;
      const img = path.join(dir, p.n);
      try {
        const out = (await exec('tesseract', [img, '-', '-l', 'chi_sim+eng', '--psm', '4'], { timeout: 30000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' })).stdout;
        const t = joinCjk(out).replace(/\f/g, '').trim();
        if (t) texts.push(t);
      } catch (e) {
        if ((e as ExecErr).code === 'ENOENT') throw new ExtractError(422, OCR_MISSING);
      } finally {
        fs.rmSync(img, { force: true });
      }
      done++;
    }
    if (done < pages.length && texts.length) texts.push(`（OCR 超时，只识别了前 ${done} 页）`);
    return texts.join('\n\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
