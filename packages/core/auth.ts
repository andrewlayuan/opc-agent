import crypto from 'node:crypto';
import type { DB } from './db.ts';

/** 哈希格式：scrypt$N$r$p$<saltHex>$<hashHex> */
export function hashPassword(password: string, N = 32768, r = 8, p = 1): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password.normalize('NFKC'), salt, 64, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nS, rS, pS, saltHex, hashHex] = parts;
  const N = Number(nS);
  const r = Number(rS);
  const p = Number(pS);
  if (!Number.isInteger(N) || N < 1024 || N > 1 << 20 || (N & (N - 1)) !== 0) return false;
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return false;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex) || hashHex.length % 2) return false;
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length < 16 || expected.length > 128) return false;
  const opts = { N, r, p, maxmem: 256 * 1024 * 1024 };
  // 兼容两种常见实现：盐按十六进制解码为字节，或直接把十六进制字符串当作盐
  const candidates = [Buffer.from(saltHex, 'hex'), Buffer.from(saltHex, 'utf8')];
  let ok = false;
  for (const pw of new Set([password.normalize('NFKC'), password])) {
    for (const salt of candidates) {
      const key = crypto.scryptSync(pw, salt, expected.length, opts);
      if (crypto.timingSafeEqual(key, expected)) ok = true;
    }
  }
  return ok;
}

export function safeEqualStr(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createSession(db: DB, username: string): { token: string; maxAgeSec: number } {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('INSERT INTO sessions(token_hash, username, created_at, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash(token), username, now, now + SESSION_TTL_MS);
  return { token, maxAgeSec: SESSION_TTL_MS / 1000 };
}

export function getSession(db: DB, token: string | undefined): { username: string } | null {
  if (!token || token.length > 100) return null;
  const row = db.prepare('SELECT username, expires_at FROM sessions WHERE token_hash = ?').get(tokenHash(token)) as { username: string; expires_at: number } | undefined;
  if (!row || row.expires_at < Date.now()) return null;
  return { username: row.username };
}

export function deleteSession(db: DB, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

/** 简单的登录限流：每个 IP 15 分钟内最多 10 次失败 */
export class LoginLimiter {
  private fails = new Map<string, number[]>();
  allowed(ip: string): boolean {
    const now = Date.now();
    const list = (this.fails.get(ip) ?? []).filter((t) => now - t < 15 * 60 * 1000);
    this.fails.set(ip, list);
    return list.length < 10;
  }
  fail(ip: string): void {
    const list = this.fails.get(ip) ?? [];
    list.push(Date.now());
    this.fails.set(ip, list);
  }
  reset(ip: string): void {
    this.fails.delete(ip);
  }
}
