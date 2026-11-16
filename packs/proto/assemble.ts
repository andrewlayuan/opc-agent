/** 文档拼装：自包含 HTML、CSP、下载文件名（spec 7） */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES, type Device, type ProtoRow, type Theme } from './types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(HERE, 'shell', 'proto.css'), 'utf8');
const js = readFileSync(path.join(HERE, 'shell', 'proto.js'), 'utf8');

export const SHELL = { css, js, hash: createHash('sha256').update(js).digest('base64') };

const CSP = "default-src 'none'; script-src 'sha256-" + SHELL.hash + "'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none';";

export function protoCsp(forMeta: boolean): string {
  return forMeta ? CSP : CSP + " frame-ancestors 'self'";
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function wrap(tag: string, attrs: Record<string, string>): string {
  const a = Object.entries(attrs).filter(([, v]) => v !== '').map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  return `<${tag}${a}>`;
}

export function assemble(row: ProtoRow, opts?: { device?: Device }): string {
  const outline = row.outline;
  const device: Device = opts?.device === 'phone' || opts?.device === 'desktop' ? opts.device : outline?.device === 'phone' ? 'phone' : 'desktop';
  const theme: Theme = outline && (THEMES as readonly string[]).includes(outline.theme) ? outline.theme : 'blue';
  const product = outline?.product || '原型';
  const data = JSON.stringify({ outline, pages: row.pages.map((p) => ({ slug: p.slug, title: p.title })) })
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const body = row.pages.map((p) => {
    const html = p.error || !p.html ? '<div class="empty">此页生成失败</div>' : p.html;
    return `<section class="pg" data-slug="${esc(p.slug)}" data-title="${esc(p.title)}"><div class="note-slot" id="proto-note-${esc(p.slug)}"></div><main>${html}</main></section>`;
  }).join('');
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${esc(protoCsp(true))}">`,
    `<title>${esc(product)} · 原型 v${esc(row.n)}</title><style>${css}</style></head>`,
    `<body id="proto-body" class="${device} theme-${theme}">`,
    `<script type="application/json" id="proto-data">${data}</script>`,
    '<header id="proto-header" class="topbar"></header><nav id="proto-nav" class="nav"></nav>',
    body,
    '<div id="proto-toast" class="toast"></div>',
    `<button id="proto-notes-toggle" class="notes-toggle" data-toggle>${wrap('i', { class: 'ic ic-info' })}标注</button>`,
    `<script>${js}</script></body></html>`,
  ].join('');
}

export function protoFileName(row: ProtoRow): string {
  const name = (row.outline?.product || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim() || '原型';
  return `${name}-原型-v${row.n}.html`;
}
