/** HTML 转纯文字：线性扫描、不执行任何内容；保留标题、列表、表格和段落结构，并读出脚本里内嵌的 JSON 数据。提取在 worker 中进行 */
import { ExtractError, NOT_UTF8, decodeText } from './extract.ts';

const CHARSETS = new Map([
  ['utf-8', 'utf-8'],
  ['utf8', 'utf-8'],
  ['gbk', 'gb18030'],
  ['gb2312', 'gb18030'],
  ['gb18030', 'gb18030'],
  ['x-gbk', 'gb18030'],
  ['big5', 'big5'],
]);

/** 有 BOM 按 BOM；否则按 <meta charset> 或 XML 声明；未声明或声明为 UTF-8 时先试 UTF-8 再试 GB18030 */
export function decodeHtml(buf: Buffer): string {
  const bom = (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) || (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);
  if (!bom) {
    const head = buf.subarray(0, 4096).toString('latin1');
    const m = /<meta\b[^>]*?charset\s*=\s*["']?\s*([\w-]+)/i.exec(head) ?? /^\s*<\?xml\b[^>]*?encoding\s*=\s*["']([\w-]+)/i.exec(head);
    const enc = m ? CHARSETS.get(m[1].toLowerCase()) : undefined;
    if (enc && enc !== 'utf-8') {
      if (buf.includes(0)) throw new ExtractError(415, NOT_UTF8);
      return new TextDecoder(enc).decode(buf);
    }
  }
  return decodeText(buf);
}

const ENT = new Map(
  Object.entries({
    nbsp: ' ', lt: '<', gt: '>', amp: '&', quot: '"', apos: "'",
    copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
    middot: '·', bull: '•', times: '×', divide: '÷', deg: '°', plusmn: '±',
    yen: '¥', euro: '€', pound: '£', cent: '¢', sect: '§', para: '¶',
    ensp: ' ', emsp: ' ', thinsp: ' ', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
    le: '≤', ge: '≥', ne: '≠', zwj: '', zwnj: '', shy: '', lrm: '', rlm: '',
  }),
);
const ENT_RE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));?/g;

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(ENT_RE, (m: string, d?: string, h?: string, n?: string) => {
    if (n) return ENT.get(n) ?? m;
    const cp = d ? Number(d) : parseInt(h!, 16);
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : '\uFFFD';
  });
}

/** 内容整体跳过的元素（脚本、样式、表单控件、内嵌图形等）；它们的结束标签是必需的 */
const SKIP = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'xmp', 'template', 'svg', 'math', 'iframe', 'select', 'canvas', 'object']);
const CLOSE = new Map([...SKIP].map((t) => [t, new RegExp(`</${t}[\\s>/]`, 'gi')]));
const BLOCK = new Set([
  'html', 'body', 'div', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'main', 'figcaption', 'form', 'address',
  'details', 'summary', 'dl', 'dt', 'dd', 'fieldset', 'legend', 'center', 'caption', 'option',
]);
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/y;
const QUOTE_WINDOW = 1024;
const MAX_INDENT = 8;

/** 标签结尾的 >：引号内的 > 不算；引号在窗口内没闭合时退回到第一个 > */
function tagEnd(s: string, from: number): number {
  const lim = Math.min(s.length, from + QUOTE_WINDOW);
  let q = '';
  for (let j = from; j < lim; j++) {
    const c = s[j];
    if (q) {
      if (c === q) q = '';
    } else if (c === '"' || c === "'") q = c;
    else if (c === '>') return j;
  }
  const k = s.indexOf('>', from);
  return k < 0 ? s.length : k;
}

class Out {
  private parts: string[] = [];
  private tail = '\n\n';
  pre = 0;
  cell = false;

  push(s: string): void {
    if (!s) return;
    this.parts.push(s);
    this.tail = (this.tail + s).slice(-2);
  }

  get spaced(): boolean {
    return this.tail.endsWith(' ');
  }

  private get lineStart(): boolean {
    return this.tail.endsWith('\n');
  }

  text(raw: string): void {
    let t = decodeEntities(this.pre ? raw : raw.replace(/[ \t\n\r\f]+/g, ' ')).replace(/\u00a0/g, ' ');
    if (!this.pre && (this.lineStart || this.tail.endsWith(' '))) t = t.replace(/^ +/, '');
    this.push(t);
  }

  /** 换行；在表格单元格里改成空格，避免把一行拆散 */
  br(blank = false): void {
    if (this.cell) {
      if (!this.lineStart && !this.tail.endsWith(' ')) this.push(' ');
      return;
    }
    if (!this.lineStart) this.push('\n');
    if (blank && this.tail !== '\n\n') this.push('\n');
  }

  result(): string {
    return this.parts
      .join('')
      .split('\n')
      .map((l) => l.trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

// ---------------- 内嵌数据 ----------------
// 单文件交互页面（图谱、看板等）常把内容放在脚本里的数据中，由脚本渲染；这里只用 JSON.parse 读取纯数据，不执行任何代码
const DATA_SRC_MAX = 8 * 1024 * 1024;
const DATA_CHARS = 150000;
const DATA_DEPTH = 8;
const ASSIGN = /^(?:(?:window|globalThis|self)\.([A-Za-z_$][\w$]*)|(?:var|let|const)\s+([A-Za-z_$][\w$]*))\s*=\s*/;
const TYPE_ATTR = /\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module']);

export interface ScriptData {
  name: string;
  value: unknown;
}

/** 脚本里的纯数据：type 为 JSON 的 script，或整段只是 `window.X = {...}` / `const X = [...]` 一条赋值；其余返回 null */
export function scriptData(tag: string, src: string): ScriptData | null {
  if (src.length > DATA_SRC_MAX) return null;
  const tm = TYPE_ATTR.exec(tag);
  const type = (tm?.[1] ?? tm?.[2] ?? tm?.[3] ?? '').trim().toLowerCase();
  let name: string;
  let json: string;
  if (type === 'application/json' || type === 'application/ld+json') {
    name = type === 'application/json' ? '页面数据' : '结构化数据';
    json = src;
  } else if (JS_TYPES.has(type)) {
    const t = src.trim();
    const m = ASSIGN.exec(t);
    if (!m) return null;
    name = m[1] ?? m[2];
    json = t.slice(m[0].length).replace(/;\s*$/, '');
  } else return null;
  json = json.trim();
  if (json[0] !== '{' && json[0] !== '[') return null;
  try {
    return { name, value: JSON.parse(json) };
  } catch {
    return null;
  }
}

const TITLE_KEYS = ['title', 'name', 'label', 'heading', 'headline', 'question', 'term', '标题', '名称'];
const PHRASE = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]|\S\s+\S/;
/** 内部字段：标识、颜色、图标等，不输出 */
const NOISE_KEYS = new Set(['id', '_id', 'key', 'slug', 'uuid', 'color', 'icon', 'order']);
const URL_RE = /^https?:\/\/\S+$/;
const IDENT = /^[\w$.:#/@+-]+$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** 值得保留的字符串：含中日韩文字或词组、链接，或不像内部标识（如 m-transformer、#7048e8、2026-11-11、a.yaml） */
function keepStr(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (PHRASE.test(t) || URL_RE.test(t)) return true;
  return !(IDENT.test(t) && (/[-_.:#/@]/.test(t) || /^\d/.test(t)));
}

/** 至少有一个直接字段是“文字”（含中日韩文字或词组）；只有 id 和关系的对象（如图谱的边）不输出 */
function rich(o: Record<string, unknown>): boolean {
  return Object.values(o).some((v) => (typeof v === 'string' && PHRASE.test(v.trim()) && !URL_RE.test(v.trim())) || (Array.isArray(v) && v.some((x) => typeof x === 'string' && PHRASE.test(x))));
}

function titleKey(o: Record<string, unknown>): string | undefined {
  return TITLE_KEYS.find((k) => typeof o[k] === 'string' && keepStr(o[k] as string));
}

/** 一行内的紧凑写法：数组用顿号，对象用「键：值；」 */
function inline(v: unknown, depth = 0): string {
  if (typeof v === 'string') return keepStr(v) ? oneLine(v) : '';
  if (depth >= DATA_DEPTH) return '';
  if (Array.isArray(v)) return v.map((x) => inline(x, depth + 1)).filter(Boolean).join('、');
  if (!isObj(v)) return '';
  const tk = titleKey(v);
  const parts = Object.entries(v).map(([k, x]) => {
    if (NOISE_KEYS.has(k)) return '';
    const s = inline(x, depth + 1);
    return !s ? '' : k === tk ? s : `${k}：${s}`;
  });
  if (tk) parts.unshift(parts.splice(Object.keys(v).indexOf(tk), 1)[0]);
  return parts.filter(Boolean).join('；');
}

class DataOut {
  lines: string[] = [];
  private chars = 0;
  full = false;

  push(s: string): void {
    if (this.full) return;
    if (this.chars + s.length > DATA_CHARS) {
      this.full = true;
      this.lines.push('（内嵌数据过长，后面的部分已截断）');
      return;
    }
    this.lines.push(s);
    this.chars += s.length + 1;
  }
}

/** 一条记录：有标题字段时作为标题（三级以内），其余字段逐行输出；嵌套的对象数组按列表输出 */
function section(o: Record<string, unknown>, level: number, out: DataOut): void {
  const tk = titleKey(o);
  if (tk) {
    out.push('');
    out.push(level <= 3 ? `${'#'.repeat(level)} ${oneLine(o[tk] as string)}` : oneLine(o[tk] as string));
  }
  for (const [k, v] of Object.entries(o)) {
    if (k === tk || NOISE_KEYS.has(k)) continue;
    if (typeof v === 'string') {
      if (keepStr(v)) out.push(`${k}：${v.trim()}`);
    } else if (Array.isArray(v) && v.length && v.every(isObj)) {
      const items = v.filter((x) => rich(x) || titleKey(x)).map((x) => inline(x)).filter(Boolean);
      if (!items.length) continue;
      out.push(`${k}：`);
      for (const s of items) out.push(`- ${s}`);
    } else {
      const s = inline(v);
      if (s) out.push(`${k}：${s}`);
    }
  }
}

function records(list: unknown[], level: number, out: DataOut): void {
  const objs = list.filter(isObj).filter(rich);
  if (objs.length) for (const o of objs) section(o, level, out);
  else {
    const s = inline(list);
    if (s) out.push(s);
  }
}

export function renderData(items: ScriptData[]): string {
  const out = new DataOut();
  for (const { name, value } of items) {
    const start = out.lines.length;
    out.push('');
    out.push(`# 页面数据：${name}`);
    const body = out.lines.length;
    if (Array.isArray(value)) records(value, 2, out);
    else if (isObj(value) && rich(value)) section(value, 2, out);
    else if (isObj(value)) {
      // 顶层是若干集合（如 nodes / domains / links）：每个集合一节，记录作为三级标题
      for (const [k, v] of Object.entries(value)) {
        if (Array.isArray(v) && v.some(isObj)) {
          if (!v.some((x) => isObj(x) && rich(x))) continue;
          out.push('');
          out.push(`## ${k}`);
          records(v, 3, out);
        } else {
          const s = inline(v);
          if (s) out.push(`${k}：${s}`);
        }
      }
    }
    if (!out.lines.slice(body).some((l) => l.trim())) out.lines.length = start;
    if (out.full) break;
  }
  return out.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function htmlToText(s: string): string {
  const n = s.length;
  const o = new Out();
  const lists: { ordered: boolean; n: number }[] = [];
  let cells = 0;
  const data: ScriptData[] = [];
  let i = 0;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      o.text(s.slice(i));
      break;
    }
    if (lt > i) o.text(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) {
      const e = s.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (s[lt + 1] === '!' || s[lt + 1] === '?') {
      const e = s.indexOf('>', lt);
      i = e < 0 ? n : e + 1;
      continue;
    }
    TAG.lastIndex = lt;
    const m = TAG.exec(s);
    if (!m) {
      o.text('<');
      i = lt + 1;
      continue;
    }
    const end = tagEnd(s, lt + m[0].length);
    i = end + 1;
    const name = m[2].toLowerCase();
    const closing = m[1] === '/';
    if (!closing && SKIP.has(name)) {
      if (s[end - 1] === '/') continue;
      const re = CLOSE.get(name)!;
      re.lastIndex = i;
      const c = re.exec(s);
      if (name === 'script' && c) {
        const d = scriptData(s.slice(lt, end + 1), s.slice(i, c.index));
        if (d) data.push(d);
      }
      const e = c ? s.indexOf('>', c.index) : -1;
      i = e < 0 ? n : e + 1;
      continue;
    }
    const h = /^h([1-6])$/.exec(name);
    if (h) {
      o.br(true);
      if (!closing && !o.cell) o.push(`${'#'.repeat(Number(h[1]))} `);
      continue;
    }
    switch (name) {
      case 'br':
        o.br();
        break;
      case 'p':
      case 'blockquote':
      case 'figure':
      case 'hr':
        o.br(true);
        break;
      case 'pre':
        o.br(true);
        o.pre = Math.max(0, o.pre + (closing ? -1 : 1));
        break;
      case 'table':
        o.cell = false;
        o.br(true);
        break;
      case 'tr':
        o.cell = false;
        o.br();
        cells = 0;
        break;
      case 'td':
      case 'th':
        if (!closing && cells++ > 0) {
          o.cell = false;
          o.push(o.spaced ? '| ' : ' | ');
        }
        o.cell = !closing;
        break;
      case 'ul':
      case 'ol':
        if (closing) lists.pop();
        else lists.push({ ordered: name === 'ol', n: 0 });
        o.br();
        break;
      case 'li':
        o.br();
        if (!closing && !o.cell) {
          const l = lists[lists.length - 1];
          o.push('  '.repeat(Math.min(MAX_INDENT, Math.max(0, lists.length - 1))) + (l?.ordered ? `${++l.n}. ` : '- '));
        }
        break;
      default:
        if (BLOCK.has(name)) o.br();
    }
  }
  const text = o.result();
  const extra = data.length ? renderData(data) : '';
  return extra ? (text ? `${text}\n\n${extra}` : extra) : text;
}
