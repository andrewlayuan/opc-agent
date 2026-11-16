/**
 * 原型页面 HTML 白名单清理（spec 第 5 节）。先分词，再按白名单重新输出：
 * 只保留白名单标签与属性，文本与属性值一律转义，保留的标签按栈自动闭合。
 * 分词器与浏览器解析不必完全一致：输出里不会残留任何未转义的 `<`、注释或原始文本元素。
 */

export type Token =
  | { t: 'open'; tag: string; attrs: [string, string][]; self: boolean }
  | { t: 'close'; tag: string }
  | { t: 'text'; v: string };

/** 内容按原始文本扫描到对应闭合标签（不解析其中的标签） */
const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'template', 'plaintext']);
/** 内容不解析标签，但解码实体 */
const RCDATA = new Set(['textarea', 'title']);

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '\ufffd';
  return String.fromCodePoint(n);
}

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(?:#(\d{1,8});?|#[xX]([0-9a-fA-F]{1,7});?|(amp|lt|gt|quot|apos|nbsp);)/g, (_, dec, hex, name) =>
    dec != null ? codePoint(Number(dec)) : hex != null ? codePoint(parseInt(hex, 16)) : NAMED[name],
  );
}

const isSpace = (c: string) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';
const isAlpha = (c: string | undefined) => c != null && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));

/** 字符状态机分词。注释、CDATA、doctype、处理指令丢弃；没写完的标签丢弃 */
export function tokenize(html: string): Token[] {
  const out: Token[] = [];
  const n = html.length;
  let i = 0;
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: decodeEntities(text) });
    text = '';
  };
  const skipTo = (end: string, from: number) => {
    const k = html.indexOf(end, from);
    return k < 0 ? n : k + end.length;
  };
  while (i < n) {
    const c = html[i];
    if (c !== '<') {
      text += c;
      i++;
      continue;
    }
    const next = html[i + 1];
    if (html.startsWith('<!--', i)) {
      flush();
      // 与浏览器一致：<!--> 与 <!---> 是空注释，--!> 也能结束注释
      if (html.startsWith('<!-->', i)) i += 5;
      else if (html.startsWith('<!--->', i)) i += 6;
      else {
        const a = html.indexOf('-->', i + 4);
        const b = html.indexOf('--!>', i + 4);
        i = a < 0 && b < 0 ? n : b < 0 || (a >= 0 && a < b) ? a + 3 : b + 4;
      }
      continue;
    }
    if (html.startsWith('<![CDATA[', i)) {
      flush();
      i = skipTo(']]>', i + 9);
      continue;
    }
    if (next === '!' || next === '?') {
      flush();
      i = skipTo('>', i + 2);
      continue;
    }
    if (next === '/' && isAlpha(html[i + 2])) {
      let j = i + 2;
      while (j < n && !isSpace(html[j]) && html[j] !== '/' && html[j] !== '>') j++;
      const tag = html.slice(i + 2, j).toLowerCase();
      const end = html.indexOf('>', j);
      flush();
      if (end < 0) {
        i = n;
        break;
      }
      out.push({ t: 'close', tag });
      i = end + 1;
      continue;
    }
    if (!isAlpha(next)) {
      text += c;
      i++;
      continue;
    }
    // 开标签
    let j = i + 1;
    while (j < n && !isSpace(html[j]) && html[j] !== '/' && html[j] !== '>') j++;
    const tag = html.slice(i + 1, j).toLowerCase();
    const attrs: [string, string][] = [];
    const seen = new Set<string>();
    let self = false;
    let closed = false;
    while (j < n) {
      while (j < n && (isSpace(html[j]) || (html[j] === '/' && html[j + 1] !== '>'))) j++;
      if (j >= n) break;
      if (html[j] === '>') {
        closed = true;
        j++;
        break;
      }
      if (html[j] === '/' && html[j + 1] === '>') {
        self = true;
        closed = true;
        j += 2;
        break;
      }
      let k = j + 1;
      while (k < n && !isSpace(html[k]) && html[k] !== '/' && html[k] !== '>' && html[k] !== '=') k++;
      const name = html.slice(j, k).toLowerCase();
      j = k;
      while (j < n && isSpace(html[j])) j++;
      let value = '';
      if (html[j] === '=') {
        j++;
        while (j < n && isSpace(html[j])) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const e = html.indexOf(q, j + 1);
          if (e < 0) {
            j = n;
            break;
          }
          value = html.slice(j + 1, e);
          j = e + 1;
        } else {
          let e = j;
          while (e < n && !isSpace(html[e]) && html[e] !== '>') e++;
          value = html.slice(j, e);
          j = e;
        }
      }
      if (!seen.has(name)) {
        seen.add(name);
        attrs.push([name, decodeEntities(value)]);
      }
    }
    flush();
    if (!closed) {
      i = n;
      break;
    }
    // 浏览器忽略 HTML 元素上的自闭合斜杠：<script/> 之后仍按原始文本扫描
    const rawText = RAW_TEXT.has(tag) || RCDATA.has(tag);
    out.push({ t: 'open', tag, attrs, self: rawText ? false : self });
    i = j;
    if (rawText) {
      let end = -1;
      if (tag !== 'plaintext') {
        const re = new RegExp(`</${tag}(?=[\\s/>])`, 'gi');
        re.lastIndex = i;
        const m = re.exec(html);
        end = m ? m.index : -1;
      }
      const body = html.slice(i, end < 0 ? n : end);
      if (body) out.push({ t: 'text', v: RCDATA.has(tag) ? decodeEntities(body) : body });
      if (end < 0) {
        i = n;
        break;
      }
      out.push({ t: 'close', tag });
      i = skipTo('>', end);
    }
  }
  flush();
  return out;
}

// ---- 白名单 ----

const HTML_TAGS = new Set(
  'main section header footer nav article aside div span p h1 h2 h3 h4 h5 h6 ul ol li dl dt dd strong em b i u s small mark code pre blockquote br hr figure figcaption table thead tbody tfoot tr th td caption form label input textarea select option button progress'.split(
    ' ',
  ),
);
const SVG_TAGS = new Set(['svg', 'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
const VOID = new Set(['br', 'hr', 'input']);
/** 连同内容整段删除 */
const DROP = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base', 'template', 'noscript', 'title', 'head',
  'xmp', 'plaintext', 'math', 'noembed', 'noframes', 'foreignobject', 'set', 'use', 'image',
]);
/** 没有内容的删除元素：只删标签本身（head 的子元素各自会被删，省略 </head> 时不能吞掉正文） */
const DROP_VOID = new Set(['link', 'meta', 'base', 'embed', 'image', 'frame', 'head']);
const dropTag = (t: string) => DROP.has(t) || t.startsWith('animate');
/** 被删元素内部不入局部栈的空元素 */
const INNER_VOID = new Set(['br', 'hr', 'input', 'img', 'meta', 'link', 'base', 'embed', 'image', 'wbr', 'area', 'col', 'source', 'track', 'param', 'frame']);

const BLOCK = new Set([...HTML_TAGS].filter((t) => !['span', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'mark', 'code', 'label'].includes(t)));

const INPUT_TYPES = new Set(['text', 'search', 'email', 'tel', 'number', 'password', 'date', 'time', 'checkbox', 'radio', 'range', 'submit', 'button']);
const ID_RE = /^[A-Za-z0-9_:-]{1,64}$/;
/** 跳转目标：slug 或页面标题（允许中文），不含空格和冒号 */
const GOTO_RE = /^[\p{L}\p{N}_-]{1,64}$/u;
/** Tab 的「组:项」 */
const TAB_RE = /^[\p{L}\p{N}_:-]{1,64}$/u;
const CLASS_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ARIA_RE = /^aria-[a-z]+$/;
const SHORT_TEXT = new Set(['data-toast', 'data-label', 'data-note', 'data-back', 'data-close', 'data-toggle']);
const PLAIN = new Set(['role', 'title', 'name', 'value', 'placeholder', 'checked', 'selected', 'disabled', 'readonly', 'for', 'min', 'max', 'step', 'rows', 'maxlength', 'colspan', 'rowspan']);
const SVG_ATTRS = new Set([
  'viewbox', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points', 'transform',
]);
const SHORT_MAX = 60;
const CLASS_MAX = 12;

const STYLE_PROP =
  /^(color|background-color|margin(-(top|right|bottom|left))?|padding(-(top|right|bottom|left))?|(min-|max-)?(width|height)|text-align|vertical-align|align-(items|self|content)|justify-(content|items|self)|font-(size|weight)|display|flex(-[a-z]+)?|grid(-[a-z]+)*|gap|row-gap|column-gap|border(-[a-z]+)*|opacity)$/;
const STYLE_BAD = /url\(|expression|javascript|@|\\|<|\/\*|["']/i;
const STYLE_FN_OK = new Set(['var', 'rgb', 'rgba', 'hsl', 'hsla', 'calc']);
/** 单条声明的值上限：防止超长值让函数名提取变慢 */
const STYLE_VALUE_MAX = 200;
/** svg 呈现属性按 CSS 解析：只允许数字、字母、空白和少量标点，不允许反斜杠（防 ur\6c( 这类转义） */
const SVG_VALUE_RE = /^[A-Za-z0-9\s#.,%()+-]*$/;

const cut = (s: string, max: number) => [...s].slice(0, max).join('');

function cleanStyle(v: string): string | null {
  const keep: string[] = [];
  for (const decl of v.split(';')) {
    const k = decl.indexOf(':');
    if (k < 0) continue;
    const prop = decl.slice(0, k).trim().toLowerCase();
    const val = decl.slice(k + 1).trim();
    if (!STYLE_PROP.test(prop) || !val || val.length > STYLE_VALUE_MAX || STYLE_BAD.test(val)) continue;
    const fns = [...val.matchAll(/(?<![A-Za-z-])([A-Za-z-]*)\s*\(/g)].map((m) => m[1].toLowerCase());
    if (fns.some((f) => !STYLE_FN_OK.has(f))) continue;
    if (/var\(\s*(?!--)/i.test(val)) continue;
    keep.push(`${prop}:${val}`);
  }
  return keep.length ? keep.join(';') : null;
}

function cleanAttr(tag: string, name: string, v: string): string | null {
  const svg = SVG_TAGS.has(tag);
  if (name === 'class') {
    const cls = v.split(/\s+/).filter((c) => CLASS_RE.test(c)).slice(0, CLASS_MAX);
    return cls.length ? cls.join(' ') : null;
  }
  if (name === 'style') return cleanStyle(v);
  if (name === 'id') return ID_RE.test(v) && !v.startsWith('proto-') ? v : null;
  if (name === 'data-open') return ID_RE.test(v) ? v : null;
  if (name === 'data-goto') return GOTO_RE.test(v) ? v : null;
  if (name === 'data-tab' || name === 'data-tab-panel') return TAB_RE.test(v) ? v : null;
  if (SHORT_TEXT.has(name)) return cut(v, SHORT_MAX);
  if (ARIA_RE.test(name)) return v;
  if (name === 'type') {
    const t = v.trim().toLowerCase();
    return (tag === 'input' || tag === 'button') && INPUT_TYPES.has(t) ? t : null;
  }
  if (name === 'name' && tag === 'form') return null;
  if (PLAIN.has(name)) return v;
  if (svg && SVG_ATTRS.has(name)) return SVG_VALUE_RE.test(v) && !/url\(/i.test(v) ? v : null;
  return null;
}

/** `#/slug` 或 `#slug` 形式的站内链接，取出跳转目标 */
function hashGoto(href: string | undefined): string | null {
  const m = href == null ? null : /^#\/?(.+)$/.exec(href.trim());
  return m && GOTO_RE.test(m[1]) ? m[1] : null;
}

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;');

interface Open {
  src: string;
  out: string;
}

/** 清理后的 token 流（只含白名单标签、已过滤属性、已配对的闭合标签） */
function clean(html: string): Token[] {
  const toks = tokenize(html);
  const res: Token[] = [];
  const stack: Open[] = [];
  const counts = new Map<string, number>();
  const push = (o: Open) => {
    stack.push(o);
    counts.set(o.src, (counts.get(o.src) ?? 0) + 1);
  };
  const closeTo = (idx: number) => {
    while (stack.length > idx) {
      const o = stack.pop()!;
      counts.set(o.src, counts.get(o.src)! - 1);
      res.push({ t: 'close', tag: o.out });
    }
  };
  const inStack = (tag: string) => {
    if (!counts.get(tag)) return -1;
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k].src === tag) return k;
    return -1;
  };
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t === 'text') {
      res.push(tk);
      continue;
    }
    if (tk.t === 'close') {
      const k = inStack(tk.tag);
      if (k >= 0) closeTo(k);
      continue;
    }
    if (dropTag(tk.tag)) {
      if (tk.self || DROP_VOID.has(tk.tag)) continue;
      // 跳过直到配对的闭合标签。被删元素内部的开标签记在局部栈里，内部的闭合标签先与它配对；
      // 只有配不上、且属于外层已打开元素的闭合标签才让跳过提前停下（不消费，交回主循环处理）
      const inner: string[] = [];
      const innerCount = new Map<string, number>();
      for (i++; i < toks.length; i++) {
        const x = toks[i];
        if (x.t === 'open') {
          if (!x.self && !INNER_VOID.has(x.tag)) {
            inner.push(x.tag);
            innerCount.set(x.tag, (innerCount.get(x.tag) ?? 0) + 1);
          }
          continue;
        }
        if (x.t !== 'close') continue;
        if (innerCount.get(x.tag)) {
          while (inner.length) {
            const top = inner.pop()!;
            innerCount.set(top, innerCount.get(top)! - 1);
            if (top === x.tag) break;
          }
        } else if (x.tag === tk.tag) break;
        else if (inStack(x.tag) >= 0) {
          i--;
          break;
        }
      }
      continue;
    }
    let tag = tk.tag;
    let goto: string | null = null;
    if (tag === 'a') {
      goto = hashGoto(tk.attrs.find(([n]) => n === 'href')?.[1]);
      if (!goto) continue;
      tag = 'span';
    }
    if (!HTML_TAGS.has(tag) && !SVG_TAGS.has(tag)) continue;
    const attrs: [string, string][] = [];
    for (const [n, v] of tk.attrs) {
      const ok = cleanAttr(tag, n, v);
      if (ok != null) attrs.push([n, ok]);
    }
    if (goto && !attrs.some(([n]) => n === 'data-goto')) attrs.push(['data-goto', goto]);
    res.push({ t: 'open', tag, attrs, self: false });
    if (VOID.has(tag)) continue;
    if (tk.self) res.push({ t: 'close', tag });
    else push({ src: tk.tag, out: tag });
  }
  closeTo(0);
  return res;
}

export function sanitizeHtml(html: string): string {
  let out = '';
  for (const tk of clean(html)) {
    if (tk.t === 'text') out += escText(tk.v);
    else if (tk.t === 'close') out += `</${tk.tag}>`;
    else out += `<${tk.tag}${tk.attrs.map(([n, v]) => ` ${n}="${escAttr(v)}"`).join('')}>`;
  }
  return out;
}

/** 清理后的纯文本：块级元素之间留空格，合并空白，按码点截断 */
export function textOf(html: string, max: number): string {
  let s = '';
  for (const tk of clean(html)) {
    if (tk.t === 'text') s += tk.v;
    else if (BLOCK.has(tk.tag)) s += ' ';
  }
  return cut(s.replace(/\s+/g, ' ').trim(), max);
}
