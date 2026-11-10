import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import type { LookupFunction } from 'node:net';

export const USER_AGENT = 'opc-radar/0.1 (+personal AI news reader; polite; respects robots.txt)';

// ---------- 地址校验：拒绝内网/保留地址，以及额外禁止的 9/10/11/21/30 段 ----------
const BLOCKED_V4_FIRST_OCTET = new Set([0, 9, 10, 11, 21, 30, 127]);

export function isBlockedIp(ip: string): boolean {
  let addr = ip;
  if (net.isIPv6(addr)) {
    const lower = addr.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) addr = mapped[1];
    else {
      if (lower === '::' || lower === '::1') return true;
      if (/^f[cd]/.test(lower)) return true; // fc00::/7
      if (/^fe[89ab]/.test(lower)) return true; // fe80::/10
      if (/^ff/.test(lower)) return true; // multicast
      if (lower.startsWith('64:ff9b:') || lower.startsWith('2001:db8:') || lower.startsWith('100::')) return true;
      if (lower.startsWith('::ffff:') || lower.startsWith('::')) return true; // 其他 IPv4 兼容形式一律拒绝
      return false;
    }
  }
  if (!net.isIPv4(addr)) return true;
  const [a, b] = addr.split('.').map(Number);
  if (BLOCKED_V4_FIRST_OCTET.has(a)) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // 组播与保留
  return false;
}

export class EgressError extends Error {}

const safeLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (callback as (e: Error) => void)(err);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => isBlockedIp(a.address));
    if (bad || list.length === 0) {
      return (callback as (e: Error) => void)(new EgressError(`拒绝访问内网或保留地址：${hostname}`));
    }
    if ((options as dns.LookupOptions).all) return (callback as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    return (callback as (e: null, a: string, f: number) => void)(null, list[0].address, list[0].family);
  });
};

// ---------- 外发白名单 ----------
const allowHosts = new Set<string>();

export function allowHost(host: string): void {
  allowHosts.add(host.toLowerCase());
}

export function isHostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  if (allowHosts.has(h)) return true;
  for (const rule of allowHosts) {
    if (rule.startsWith('*.') && h.endsWith(rule.slice(1))) return true;
  }
  return false;
}

/** 校验公开 http(s) URL 的形态（协议、凭据、IP 字面量、端口、本地域名），不检查白名单 */
export function checkPublicUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new EgressError(`非法 URL：${raw}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new EgressError(`不支持的协议：${u.protocol}`);
  if (u.username || u.password) throw new EgressError('URL 中不允许携带凭据');
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) throw new EgressError('不允许直接访问 IP 地址');
  if (u.port && u.port !== '443' && u.port !== '80') throw new EgressError('只允许 80/443 端口');
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!h.includes('.') || /\.(local|localhost|internal|lan|home|corp|intranet)$/.test(h) || h === 'localhost') {
    throw new EgressError(`不允许访问本地域名：${u.hostname}`);
  }
  return u;
}

function checkUrl(raw: string): URL {
  const u = checkPublicUrl(raw);
  if (!isHostAllowed(u.hostname)) throw new EgressError(`域名不在外发白名单：${u.hostname}`);
  return u;
}

// ---------- 每个域名串行 + 最小间隔 ----------
const hostQueue = new Map<string, Promise<unknown>>();
const MIN_INTERVAL_MS = 1000;

function throttled<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const prev = hostQueue.get(host) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  hostQueue.set(
    host,
    run.then(
      () => new Promise((r) => setTimeout(r, MIN_INTERVAL_MS)),
      () => new Promise((r) => setTimeout(r, MIN_INTERVAL_MS)),
    ),
  );
  return run;
}

// ---------- 底层请求 ----------
export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  url: string;
}

interface RawOptions {
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

function rawRequest(u: URL, o: RawOptions): Promise<HttpResponse> {
  const mod = u.protocol === 'https:' ? https : http;
  const maxBytes = o.maxBytes ?? 8 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      u,
      {
        method: o.method ?? 'GET',
        lookup: safeLookup,
        headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'gzip, deflate, br', ...o.headers },
        timeout: o.timeoutMs ?? 30000,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const noBody = status === 304 || status === 204 || (status >= 100 && status < 200) || o.method === 'HEAD';
        const enc = noBody ? '' : String(res.headers['content-encoding'] || '').toLowerCase();
        let stream: NodeJS.ReadableStream = res;
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy(new EgressError(`响应超过 ${maxBytes} 字节`));
            return;
          }
          chunks.push(c);
        });
        stream.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), url: u.href }));
        stream.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new EgressError('请求超时')));
    req.on('error', reject);
    if (o.body) req.write(o.body);
    req.end();
  });
}

async function requestFollow(raw: string, o: RawOptions, throttle = true, anyPublicHost = false): Promise<HttpResponse> {
  const check = anyPublicHost ? checkPublicUrl : checkUrl;
  let u = check(raw);
  for (let hop = 0; hop <= 4; hop++) {
    const target = u;
    const res = throttle ? await throttled(target.host, () => rawRequest(target, o)) : await rawRequest(target, o);
    if (res.status >= 300 && res.status < 400 && res.headers.location && (o.method ?? 'GET') === 'GET') {
      u = check(new URL(String(res.headers.location), u).href);
      continue;
    }
    return res;
  }
  throw new EgressError('重定向次数过多');
}

// ---------- robots.txt ----------
interface RobotsRules {
  rules: { allow: boolean; path: string }[];
  at: number;
}
const robotsCache = new Map<string, RobotsRules>();
const ROBOTS_TTL = 24 * 3600 * 1000;

export function parseRobots(txt: string, agent = 'opc-radar'): { allow: boolean; path: string }[] {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const line of txt.split(/\r?\n/)) {
    const m = line.replace(/#.*/, '').trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (key === 'allow' || key === 'disallow') {
        if (key === 'disallow' && val === '') continue;
        cur.rules.push({ allow: key === 'allow', path: val });
      }
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.toLowerCase().includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

function ruleMatches(rulePath: string, target: string): boolean {
  const anchored = rulePath.endsWith('$');
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const re = new RegExp('^' + body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
  return re.test(target);
}

export function robotsAllows(rules: { allow: boolean; path: string }[], pathAndQuery: string): boolean {
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules) {
    if (!ruleMatches(r.path, pathAndQuery)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
  }
  return best ? best.allow : true;
}

async function checkRobots(u: URL, anyPublicHost = false): Promise<void> {
  const key = u.origin;
  let entry = robotsCache.get(key);
  if (!entry || Date.now() - entry.at > ROBOTS_TTL) {
    let rules: { allow: boolean; path: string }[] = [];
    try {
      const res = await requestFollow(`${u.origin}/robots.txt`, { timeoutMs: 10000, maxBytes: 512 * 1024 }, true, anyPublicHost);
      if (res.status >= 200 && res.status < 300) rules = parseRobots(res.body.toString('utf8'));
    } catch {
      rules = [];
    }
    entry = { rules, at: Date.now() };
    robotsCache.set(key, entry);
  }
  if (!robotsAllows(entry.rules, u.pathname + u.search)) throw new EgressError(`robots.txt 不允许抓取：${u.href}`);
}

// ---------- 对外接口 ----------

/**
 * 交给第三方读取器（Agent-Reach/Jina）之前的合规检查：URL 必须是公开地址、DNS 不指向内网，且目标站 robots.txt 允许。
 * 只会请求目标站固定的 /robots.txt，不受外发白名单限制。
 */
export async function assertPublicAndRobotsAllowed(url: string): Promise<URL> {
  const u = checkPublicUrl(url);
  await new Promise<void>((resolve, reject) =>
    dns.lookup(u.hostname, { all: true }, (err, list) => {
      if (err) return reject(new EgressError(`域名解析失败：${u.hostname}`));
      if (!list.length || list.some((a) => isBlockedIp(a.address))) return reject(new EgressError(`拒绝访问内网或保留地址：${u.hostname}`));
      resolve();
    }),
  );
  await checkRobots(u, true);
  return u;
}
export interface PoliteResult {
  status: number;
  notModified: boolean;
  text: string;
  etag?: string;
  lastModified?: string;
  contentType: string;
}

/** 采集用：白名单 + 禁内网 + robots.txt + 限速 + 条件请求缓存 + 大小上限 */
export async function politeFetch(url: string, cache: { etag?: string | null; lastModified?: string | null } = {}): Promise<PoliteResult> {
  const u = checkUrl(url);
  await checkRobots(u);
  const headers: Record<string, string> = { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.5' };
  if (cache.etag) headers['if-none-match'] = cache.etag;
  if (cache.lastModified) headers['if-modified-since'] = cache.lastModified;
  const res = await requestFollow(u.href, { headers });
  return {
    status: res.status,
    notModified: res.status === 304,
    text: res.body.toString('utf8'),
    etag: res.headers.etag ? String(res.headers.etag) : undefined,
    lastModified: res.headers['last-modified'] ? String(res.headers['last-modified']) : undefined,
    contentType: String(res.headers['content-type'] || ''),
  };
}

/** API 调用用（如 LLM）：白名单 + 禁内网，不做 robots 检查 */
export async function apiPost(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 90000): Promise<{ status: number; json: unknown; text: string }> {
  const res = await requestFollow(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    timeoutMs,
    maxBytes: 4 * 1024 * 1024,
  }, false);
  const text = res.body.toString('utf8');
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}
