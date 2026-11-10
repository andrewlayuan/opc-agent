/** 评审文档的导出：Markdown 下载与打印页 HTML（只输出转义后的文本，不含脚本、内联样式和链接） */
import type { ReviewRef, ReviewView, VersionMeta, VersionView } from './advisor.ts';

export const SOURCE_LABEL: Record<VersionMeta['source'], string> = {
  ai_initial: 'AI 首版',
  ai_revise: 'AI 改写',
  manual: '手动修改',
};

const fmt = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' });
const when = (ms: number) => fmt.format(ms);

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function exportMarkdown(r: ReviewView, v: VersionView, refs: ReviewRef[]): string {
  const quote = r.input
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  const out = [
    `# 产品顾问评审 · v${v.n}`,
    '',
    `- 方案：${r.mode_label}`,
    `- 版本：v${v.n}（${SOURCE_LABEL[v.source]}）· ${when(v.created_at)}`,
    '- 原始需求：',
    '',
    quote,
    '',
    '---',
    '',
    v.content.trim(),
    '',
  ];
  if (refs.length) out.push('## 引用来源', ...refs.map((x) => `[${x.n}] ${x.title}（${x.source}） ${x.url}  `), '');
  return out.join('\n');
}

/** 行内：先整体转义，再识别行内代码和粗体 */
function inline(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

const cells = (line: string) =>
  line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

/** 极简 Markdown → HTML：标题、列表、引用、分隔线、表格、代码块、段落 */
function blocks(md: string): string {
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let para: string[] = [];
  let quote: string[] = [];
  let table: string[] | null = null;
  let code: string[] | null = null;

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.join('<br>')}</p>`);
    para = [];
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.join('<br>')}</blockquote>`);
    quote = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const closeTable = () => {
    if (table) out.push(`<table>\n${table.join('\n')}\n</tbody></table>`);
    table = null;
  };
  const flushAll = () => {
    flushPara();
    flushQuote();
    closeList();
    closeTable();
  };

  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    if (code) {
      if (/^\s*```/.test(raw)) {
        out.push(`<pre><code>${code.map(escapeHtml).join('\n')}</code></pre>`);
        code = null;
      } else code.push(raw);
      continue;
    }
    const line = raw.trim();
    if (/^```/.test(line)) {
      flushAll();
      code = [];
      continue;
    }
    if (!line) {
      flushAll();
      continue;
    }
    if (line.startsWith('|')) {
      flushPara();
      flushQuote();
      closeList();
      if (/^\|?[\s:|-]+\|?$/.test(line)) continue;
      if (!table) table = [`<thead><tr>${cells(line).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`, '<tbody>'];
      else table.push(`<tr>${cells(line).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
      continue;
    }
    closeTable();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flushAll();
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flushAll();
      out.push('<hr>');
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara();
      closeList();
      quote.push(inline(m[1]));
    } else if ((m = line.match(/^[-*+]\s+(.*)$/)) || (m = line.match(/^\d+[.)、]\s*(.*)$/))) {
      const kind = /^[-*+]/.test(line) ? 'ul' : 'ol';
      flushPara();
      flushQuote();
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline(m[1])}</li>`);
    } else {
      flushQuote();
      closeList();
      para.push(inline(line));
    }
  }
  if (code) out.push(`<pre><code>${code.map(escapeHtml).join('\n')}</code></pre>`);
  flushAll();
  return out.join('\n');
}

export function renderPrintHtml(r: ReviewView, v: VersionView, refs: ReviewRef[]): string {
  const title = `产品顾问评审 · v${v.n}`;
  const req = r.input.split('\n').map(escapeHtml).join('<br>');
  const refList = refs.length
    ? `<section class="refs"><h2>引用来源</h2><ol class="ref-list">${refs.map((x) => `<li>[${x.n}] ${escapeHtml(x.title)}（${escapeHtml(x.source)}）</li>`).join('')}</ol></section>`
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/print.css">
</head>
<body>
<p class="hint">在浏览器中选择「打印」（Ctrl/⌘ + P）→「另存为 PDF」即可导出。</p>
<header class="doc-head">
<div class="doc-title">${escapeHtml(title)}</div>
<p class="doc-meta">${escapeHtml(r.mode_label)} · ${escapeHtml(SOURCE_LABEL[v.source])} · ${escapeHtml(when(v.created_at))}</p>
<blockquote class="doc-req">${req}</blockquote>
</header>
<article class="doc-body">
${blocks(v.content)}
</article>
${refList}
</body>
</html>
`;
}
