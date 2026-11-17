/** HTML 转纯文字：线性扫描、不执行任何内容；保留标题、列表、表格和段落结构。提取在 worker 中进行 */
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

export function htmlToText(s: string): string {
  const n = s.length;
  const o = new Out();
  const lists: { ordered: boolean; n: number }[] = [];
  let cells = 0;
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
  return o.result();
}
