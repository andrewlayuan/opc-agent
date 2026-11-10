import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type http from 'node:http';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/login': { file: 'login.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/login.js': { file: 'login.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
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

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': data.length });
  res.end(data);
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
