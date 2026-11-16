import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type http from 'node:http';
import type { Readable } from 'node:stream';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/login': { file: 'login.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/kb.js': { file: 'kb.js', type: 'text/javascript; charset=utf-8' },
  '/proto-panel.js': { file: 'proto-panel.js', type: 'text/javascript; charset=utf-8' },
  '/proto-full.js': { file: 'proto-full.js', type: 'text/javascript; charset=utf-8' },
  '/proto-full.html': { file: 'proto-full.html', type: 'text/html; charset=utf-8' },
  '/login.js': { file: 'login.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/print.css': { file: 'print.css', type: 'text/css; charset=utf-8' },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
};

export function staticFor(pathname: string): { body: Buffer; type: string } | null {
  const s = STATIC[pathname];
  if (!s) return null;
  return { body: fs.readFileSync(path.join(PUBLIC, s.file)), type: s.type };
}

export function securityHeaders(res: http.ServerResponse, https: boolean): void {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

export function readJson(req: http.IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] || '');
    if (!ct.startsWith('application/json')) return reject(new HttpError(415, '需要 application/json'));
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(new HttpError(400, 'JSON 必须是对象'));
        resolve(v as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, 'JSON 格式错误'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 把请求体流式写入新文件（0600，已存在则失败）。超限 413、中断或出错 400，失败时删除已写的文件。
 * 超限时只暂停读取、不销毁请求：销毁会连带断开 socket，413 就发不出去。
 * 调用方应带 `connection: close` 回应，由 Node 在响应结束后关闭连接。
 */
export function readBodyToFile(req: Readable, file: string, maxBytes: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(file, { mode: 0o600, flags: 'wx' });
    let size = 0;
    let ended = false;
    let opened = false;
    let failure: Error | null = null;
    const fail = (e: Error, destroyReq = true) => {
      if (failure) return;
      failure = e;
      if (destroyReq) req.destroy();
      else req.pause();
      ws.destroy();
    };
    const aborted = () => fail(new HttpError(400, '上传中断'));
    ws.on('open', () => {
      opened = true;
    });
    ws.on('error', (e) => fail(e));
    ws.on('close', () => {
      if (!failure) return resolve(size);
      if (opened) fs.rmSync(file, { force: true });
      reject(failure);
    });
    req.on('data', (c: Buffer) => {
      if (failure) return;
      size += c.length;
      if (size > maxBytes) return fail(new HttpError(413, '单个文件最大 10MB'), false);
      if (!ws.write(c)) {
        req.pause();
        ws.once('drain', () => req.resume());
      }
    });
    req.on('end', () => {
      ended = true;
      if (!failure) ws.end();
    });
    req.on('error', aborted);
    req.on('aborted', aborted);
    req.on('close', () => {
      if (!ended) aborted();
    });
  });
}

/** 下载头：RFC 5987 的 filename*（encodeURIComponent 不编码 ' ( ) *，需补上），ASCII 兜底名固定为 file */
export function contentDisposition(name: string, inline: boolean): string {
  const enc = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="file"; filename*=UTF-8''${enc}`;
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': data.length });
  res.end(data);
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * 客户端 IP。只有开启 trustProxy 且连接来自本机反代时才读 X-Forwarded-For，
 * 并取最右一段（由本机代理写入，客户端无法伪造）；否则用 socket 地址。
 */
export function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  if (!trustProxy || !LOOPBACK.has(remote)) return remote;
  const raw = req.headers['x-forwarded-for'];
  const header = Array.isArray(raw) ? raw.join(',') : raw ?? '';
  const last = header.split(',').map((s) => s.trim()).filter(Boolean).pop() ?? '';
  return isIP(last) ? last : remote;
}

/** 写操作必须同源：Origin（或 Referer）与 Host 一致，或等于配置的公开地址 */
export function sameOrigin(req: http.IncomingMessage, publicOrigin: string): boolean {
  const origin = req.headers.origin || (req.headers.referer ? safeOrigin(String(req.headers.referer)) : '');
  if (!origin) return false;
  if (origin === publicOrigin) return true;
  const host = req.headers.host;
  if (!host) return false;
  const o = safeOrigin(origin);
  return o === `http://${host}` || o === `https://${host}`;
}

function safeOrigin(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return '';
  }
}
