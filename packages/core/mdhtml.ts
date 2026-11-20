// Markdown → HTML（导出用）：先切出语法片段，其余文本一律转义；只生成白名单标签。wiki 导出与合规材料导出共用
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escHtml = (s: string): string => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const esc = escHtml;

/** 行内回调：未提供时 [[x|y]] 取 y||x，[^d:o] 原样，asset 图片只留替代文字；mark 为真时「【待填：…】」高亮 */
export interface MdCtx {
  link?(target: string, label: string | undefined): string;
  cite?(doc: number, ord: number): number;
  img?(id: number, alt: string): string;
  mark?: boolean;
}

const MARK_OPEN = '<mark style="background:#ffeb3b">';

const INLINE =
  /!\[([^\]\n]*)\]\(([^)\s]*)\)|\[\[([^[\]|\n]{1,120})(?:\|([^[\]\n]{0,120}))?\]\]|\[\^(\d{1,9}):(\d{1,6})\]|\[([^\]\n]+)\]\(([^)\s]+)\)|`([^`\n]+)`|\*\*([^*\n]+?)\*\*|(?<![\w*])\*([^*\n]+?)\*(?![\w*])|(?<![\p{L}\p{N}_])_([^_\n]+?)_(?![\p{L}\p{N}_])|【待填：([^】\n]{1,40})】/gu;

function inline(s: string, ctx: MdCtx): string {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    out += esc(s.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[1] !== undefined) {
      const a = /^asset:(\d{1,9})$/.exec(m[2]);
      out += a && ctx.img ? ctx.img(Number(a[1]), m[1]) : esc(m[1] || '图片');
    } else if (m[3] !== undefined) out += esc(ctx.link ? ctx.link(m[3], m[4]) : m[4] || m[3]);
    else if (m[5] !== undefined) out += ctx.cite ? `[${ctx.cite(Number(m[5]), Number(m[6]))}]` : esc(m[0]);
    else if (m[7] !== undefined) out += m[7] === m[8] ? esc(m[7]) : `${inline(m[7], ctx)}（${esc(m[8])}）`;
    else if (m[9] !== undefined) out += esc(m[9]);
    else if (m[10] !== undefined) out += `<strong>${inline(m[10], ctx)}</strong>`;
    else if (m[13] !== undefined) out += ctx.mark ? `${MARK_OPEN}${esc(m[0])}</mark>` : esc(m[0]);
    else out += `<em>${inline(m[11] ?? m[12], ctx)}</em>`;
  }
  return out + esc(s.slice(last));
}

/** 管道表格的单元格：按未转义的 | 切分，去掉首尾空格与行首行尾的 |，\| 还原为 | */
function cells(line: string): string[] {
  const parts = line.trim().split(/(?<!\\)\|/);
  if (parts[0].trim() === '') parts.shift();
  if (parts.length && parts[parts.length - 1].trim() === '') parts.pop();
  return parts.map((c) => c.trim().replace(/\\\|/g, '|'));
}
const isSeparator = (line: string) => {
  const c = cells(line);
  return c.length > 0 && c.every((x) => /^:?-{3,}:?$/.test(x.replace(/\s+/g, '')));
};

export function renderMdHtml(body: string, ctx: MdCtx = {}): string {
  const lines = String(body).replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  let table: string[][] | null = null;
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '), ctx)}</p>`);
    if (quote.length) out.push(`<blockquote><p>${inline(quote.join(' '), ctx)}</p></blockquote>`);
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i, ctx)}</li>`).join('')}</${list.tag}>`);
    if (table) {
      const rows = table.map((r, i) => `<tr>${r.map((c) => (i === 0 ? `<th>${inline(c, ctx)}</th>` : `<td>${inline(c, ctx)}</td>`)).join('')}</tr>`);
      out.push(`<table>${rows.join('')}</table>`);
    }
    para = [];
    quote = [];
    list = null;
    table = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if (/^\s*\|/.test(line)) {
      if (!table) flush();
      table ??= [];
      if (!isSeparator(line)) table.push(cells(line));
    } else if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre>${esc(code.join('\n'))}</pre>`);
    } else if (!line.trim() || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flush();
      const h = Math.min(4, Math.max(2, m[1].length));
      out.push(`<h${h}>${inline(m[2].replace(/\s+#+\s*$/, ''), ctx)}</h${h}>`);
    } else if ((m = /^\s*>\s?(.*)$/.exec(line))) {
      if (!quote.length) flush();
      quote.push(m[1]);
    } else if ((m = /^\s*(?:([-*+])|\d{1,9}[.)])\s+(.*)$/.exec(line))) {
      const tag = m[1] ? 'ul' : 'ol';
      if ((list as { tag: string } | null)?.tag !== tag) flush();
      list ??= { tag, items: [] };
      list.items.push(m[2]);
    } else {
      if (!para.length) flush();
      para.push(line.trim());
    }
  }
  flush();
  return out.join('\n');
}
