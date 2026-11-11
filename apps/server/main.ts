import http from 'node:http';
import { LoginLimiter, createSession, deleteSession, getSession, safeEqualStr, verifyPassword } from '../../packages/core/auth.ts';
import { loadConfig } from '../../packages/core/config.ts';
import { openDb } from '../../packages/core/db.ts';
import { allowHost } from '../../packages/core/net.ts';
import { analyzeItem, generateBrief, latestBrief, translateItem } from '../../packs/radar/analyze.ts';
import { GROUPS, collectOnce } from '../../packs/radar/collect.ts';
import { enrichItem } from '../../packs/radar/enrich.ts';
import { MAX_SELECTED, PmAdvisor, PmError } from '../../packs/pm/advisor.ts';
import { exportMarkdown, renderPrintHtml } from '../../packs/pm/render.ts';
import { defaultSkillsDir, loadPmSkills } from '../../packs/pm/skills.ts';
import { getInterests, setInterests } from '../../packs/radar/prefs.ts';
import { getItem, listItems, stats } from '../../packs/radar/query.ts';
import { Radar } from '../../packs/radar/service.ts';
import { HttpError, clientIp, parseCookies, readJson, sameOrigin, securityHeaders, sendJson, staticFor } from './http.ts';

const cfg = loadConfig({ requireAuth: true });
const db = openDb(cfg.dbPath);
const radar = new Radar(db, cfg);
const pmSkillsDir = defaultSkillsDir();
const pm = new PmAdvisor(db, radar.llm, loadPmSkills(pmSkillsDir));
const limiter = new LoginLimiter();
const isHttps = cfg.publicOrigin.startsWith('https://');
const COOKIE = 'opc_sid';

function cookieHeader(value: string, maxAge: number): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps ? '; Secure' : ''}`;
}

function intParam(v: string | null, min: number, max: number): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function idFrom(m: RegExpMatchArray): number {
  const id = Number(m[1]);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, '非法 id');
  return id;
}

/** 把产品顾问的业务错误映射为 HTTP 状态码 */
function pmCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PmError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

function versionNo(s: string): number {
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(404, '版本不存在');
  return n;
}

let briefRunning = false;

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, user: { username: string } | null): Promise<void> {
  const method = req.method ?? 'GET';
  const p = url.pathname;

  if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req, cfg.publicOrigin)) throw new HttpError(403, '跨站请求被拒绝');

  if (p === '/api/login' && method === 'POST') {
    const ip = clientIp(req, cfg.trustProxy);
    if (!limiter.allowed(ip)) throw new HttpError(429, '尝试次数过多，请 15 分钟后再试');
    const body = await readJson(req, 4096);
    const username = typeof body.username === 'string' ? body.username.slice(0, 100) : '';
    const password = typeof body.password === 'string' ? body.password.slice(0, 1024) : '';
    const userOk = safeEqualStr(username, cfg.adminUser);
    const passOk = verifyPassword(password, cfg.adminHash);
    if (!userOk || !passOk) {
      limiter.fail(ip);
      throw new HttpError(401, '用户名或密码错误');
    }
    limiter.reset(ip);
    const s = createSession(db, cfg.adminUser);
    res.setHeader('Set-Cookie', cookieHeader(s.token, s.maxAgeSec));
    return sendJson(res, 200, { ok: true });
  }

  if (!user) throw new HttpError(401, '未登录');

  if (p === '/api/logout' && method === 'POST') {
    deleteSession(db, parseCookies(req.headers.cookie)[COOKIE]);
    res.setHeader('Set-Cookie', cookieHeader('', 0));
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/me' && method === 'GET') return sendJson(res, 200, { username: user.username });

  if (p === '/api/meta' && method === 'GET') {
    return sendJson(res, 200, {
      topics: radar.topics.map((t) => ({ id: t.id, label: t.label })),
      groups: GROUPS,
      llm: { enabled: radar.llm.enabled, model: cfg.llm.model },
      reach: { enabled: radar.reach.enabled },
      intervalMin: cfg.fetchIntervalMin,
    });
  }

  if (p === '/api/status' && method === 'GET') {
    const last = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get();
    return sendJson(res, 200, { state: radar.state, lastRun: last ?? null, stats: stats(db) });
  }

  if (p === '/api/items' && method === 'GET') {
    const s = url.searchParams;
    const q = (s.get('q') ?? '').slice(0, 200);
    const known = new Set(radar.topics.map((t) => t.id));
    const items = listItems(db, {
      topic: s.get('topic')?.slice(0, 40) || undefined,
      topics: (s.get('topics') ?? '').split(',').filter((t) => known.has(t)),
      grp: s.get('grp')?.slice(0, 40) || undefined,
      source: s.get('source')?.slice(0, 80) || undefined,
      q: q.trim() || undefined,
      days: intParam(s.get('days'), 1, 365),
      minImportance: intParam(s.get('min'), 1, 5),
      starred: s.get('starred') === '1',
      before: intParam(s.get('before'), 0, Number.MAX_SAFE_INTEGER),
      limit: intParam(s.get('limit'), 1, 100) ?? 30,
    });
    return sendJson(res, 200, { items });
  }

  let m = p.match(/^\/api\/items\/(\d+)$/);
  if (m && method === 'GET') {
    const item = getItem(db, idFrom(m));
    if (!item) throw new HttpError(404, '条目不存在');
    return sendJson(res, 200, { item });
  }
  m = p.match(/^\/api\/items\/(\d+)\/analyze$/);
  if (m && method === 'POST') {
    const id = idFrom(m);
    if (!getItem(db, id)) throw new HttpError(404, '条目不存在');
    await enrichItem(db, radar.reach, id);
    await analyzeItem(db, radar.llm, radar.topics, id);
    return sendJson(res, 200, { item: getItem(db, id) });
  }
  m = p.match(/^\/api\/items\/(\d+)\/translate$/);
  if (m && method === 'POST') {
    const id = idFrom(m);
    if (!getItem(db, id)) throw new HttpError(404, '条目不存在');
    await enrichItem(db, radar.reach, id);
    const translation = await translateItem(db, radar.llm, id);
    return sendJson(res, 200, { translation });
  }
  m = p.match(/^\/api\/items\/(\d+)\/star$/);
  if (m && method === 'POST') {
    const id = idFrom(m);
    const body = await readJson(req, 1024);
    const r = db.prepare('UPDATE items SET starred=? WHERE id=?').run(body.starred ? 1 : 0, id);
    if (!r.changes) throw new HttpError(404, '条目不存在');
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/run' && method === 'POST') {
    if (radar.state.running) return sendJson(res, 202, { message: '已有任务在运行' });
    void radar.runCycle();
    return sendJson(res, 202, { message: '已开始' });
  }

  if (p === '/api/brief' && method === 'GET') return sendJson(res, 200, { brief: latestBrief(db) });
  if (p === '/api/brief' && method === 'POST') {
    if (briefRunning) throw new HttpError(409, '简报正在生成');
    briefRunning = true;
    try {
      const body = await readJson(req, 1024);
      const focus = body.focus ? getInterests(db, radar.topics).topics : [];
      if (body.focus && !focus.length) throw new HttpError(400, '还没有设置「我的关注」');
      const b = await generateBrief(db, radar.llm, radar.topics, 24, focus);
      return sendJson(res, 200, { brief: b });
    } finally {
      briefRunning = false;
    }
  }

  if (p === '/api/prefs/interests' && method === 'GET') return sendJson(res, 200, { interests: getInterests(db, radar.topics) });
  if (p === '/api/prefs/interests' && method === 'PUT') {
    const body = await readJson(req, 4096);
    return sendJson(res, 200, { interests: setInterests(db, radar.topics, body) });
  }

  // ---------- 产品顾问（pm-skills） ----------
  if (p === '/api/pm/meta' && method === 'GET') {
    return sendJson(res, 200, {
      enabled: pm.enabled,
      skillsFound: pm.skills.length,
      llm: radar.llm.enabled,
      presets: pm.presets(),
      skills: pm.catalog(),
      maxSelected: MAX_SELECTED,
    });
  }
  if (p === '/api/pm/reviews' && method === 'GET') return sendJson(res, 200, { reviews: pm.list(30) });
  if (p === '/api/pm/reviews' && method === 'POST') {
    const body = await readJson(req, 32 * 1024);
    let id: number;
    try {
      id = pm.start({
        input: typeof body.input === 'string' ? body.input : '',
        presets: body.presets,
        skills: body.skills,
        useRadar: body.useRadar !== false,
      });
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : '提交失败');
    }
    return sendJson(res, 202, { id });
  }
  m = p.match(/^\/api\/pm\/reviews\/(\d+)$/);
  if (m && method === 'GET') {
    const r = pm.get(idFrom(m));
    if (!r) throw new HttpError(404, '评审不存在');
    return sendJson(res, 200, { review: r });
  }
  if (m && method === 'DELETE') {
    const id = idFrom(m);
    if (!pmCall(() => pm.delete(id))) throw new HttpError(404, '评审不存在或仍在进行中');
    return sendJson(res, 200, { ok: true });
  }
  m = p.match(/^\/api\/pm\/reviews\/(\d+)\/messages$/);
  if (m && method === 'POST') {
    const id = idFrom(m);
    // 4000 字上限按 UTF-8 最坏 4 字节/字计
    const body = await readJson(req, 32 * 1024);
    const messageId = pmCall(() => pm.ask(id, typeof body.text === 'string' ? body.text : '', body.mode));
    return sendJson(res, 202, { messageId });
  }
  m = p.match(/^\/api\/pm\/reviews\/(\d+)\/versions$/);
  if (m && method === 'POST') {
    const id = idFrom(m);
    // 40000 字上限：中文 3 字节/字，另留 JSON 转义余量
    const body = await readJson(req, 192 * 1024);
    const n = pmCall(() => pm.saveManual(id, typeof body.content === 'string' ? body.content : '', body.baseN));
    return sendJson(res, 201, { n });
  }
  m = p.match(/^\/api\/pm\/reviews\/(\d+)\/versions\/(\d+)(\/download)?$/);
  if (m && method === 'GET') {
    const id = idFrom(m);
    const v = pm.version(id, versionNo(m[2]));
    const r = v ? pm.get(id) : null;
    if (!v || !r) throw new HttpError(404, '版本不存在');
    if (!m[3]) return sendJson(res, 200, { version: v });
    const data = Buffer.from(exportMarkdown(r, v, pm.refs(id)));
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="opc-review-${id}-v${v.n}.md"`,
      'cache-control': 'no-store',
      'content-length': data.length,
    });
    res.end(data);
    return;
  }

  if (p === '/api/sources' && method === 'GET') {
    const rows = db
      .prepare('SELECT id, name, url, kind, grp, lang, filter, enabled, custom, last_fetch_at, last_ok_at, last_error, item_count FROM sources ORDER BY grp, name')
      .all();
    return sendJson(res, 200, { sources: rows });
  }
  m = p.match(/^\/api\/sources\/([\w.-]{1,80})\/toggle$/);
  if (m && method === 'POST') {
    const body = await readJson(req, 1024);
    const r = db.prepare('UPDATE sources SET enabled=? WHERE id=?').run(body.enabled ? 1 : 0, m[1]);
    if (!r.changes) throw new HttpError(404, '信息源不存在');
    return sendJson(res, 200, { ok: true });
  }
  m = p.match(/^\/api\/sources\/([\w.-]{1,80})$/);
  if (m && method === 'DELETE') {
    const src = db.prepare('SELECT custom FROM sources WHERE id=?').get(m[1]) as { custom: number } | undefined;
    if (!src) throw new HttpError(404, '信息源不存在');
    if (!src.custom) throw new HttpError(400, '内置信息源只能停用，不能删除');
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM items WHERE source_id=?').run(m[1]);
      db.prepare('DELETE FROM sources WHERE id=?').run(m[1]);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/sources' && method === 'POST') {
    const body = await readJson(req, 4096);
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    const raw = typeof body.url === 'string' ? body.url.trim() : '';
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new HttpError(400, 'URL 不合法');
    }
    if (u.protocol !== 'https:') throw new HttpError(400, '只支持 https 订阅地址');
    if (u.username || u.password || (u.port && u.port !== '443')) throw new HttpError(400, 'URL 不能带凭据或非标准端口');
    if (!name) throw new HttpError(400, '请填写名称');
    const lang = body.lang === 'zh' ? 'zh' : 'en';
    const id = `custom-${Date.now().toString(36)}`;
    db.prepare("INSERT INTO sources(id, name, url, kind, grp, lang, filter, max_items, custom) VALUES (?, ?, ?, 'feed', 'custom', ?, ?, 20, 1)").run(
      id,
      name,
      u.href,
      lang,
      body.filter ? 1 : 0,
    );
    allowHost(u.hostname);
    const r = await collectOnce(db, radar.matcher, { maxAgeDays: cfg.maxAgeDays, onlySource: id, reach: radar.reach });
    const row = db.prepare('SELECT last_error FROM sources WHERE id=?').get(id) as { last_error: string | null };
    return sendJson(res, 200, { id, newItems: r.newItems, error: row.last_error });
  }

  throw new HttpError(404, '接口不存在');
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res, isHttps);
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    res.writeHead(400).end();
    return;
  }
  const token = parseCookies(req.headers.cookie)[COOKIE];
  const user = getSession(db, token);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url, user);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '方法不允许');
    if (url.pathname === '/' && !user) {
      res.writeHead(302, { location: '/login' }).end();
      return;
    }
    if (url.pathname === '/login' && user) {
      res.writeHead(302, { location: '/' }).end();
      return;
    }
    const pr = url.pathname.match(/^\/print\/pm\/(\d+)\/(\d+)$/);
    if (pr) {
      if (!user) {
        res.writeHead(302, { location: '/login' }).end();
        return;
      }
      const id = idFrom(pr);
      const v = pm.version(id, versionNo(pr[2]));
      const r = v ? pm.get(id) : null;
      if (!v || !r) throw new HttpError(404, 'Not found');
      const html = Buffer.from(renderPrintHtml(r, v, pm.refs(id)));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': html.length });
      res.end(req.method === 'HEAD' ? undefined : html);
      return;
    }
    const s = staticFor(url.pathname);
    if (!s) throw new HttpError(404, 'Not found');
    res.writeHead(200, { 'content-type': s.type, 'cache-control': 'no-cache', 'content-length': s.body.length });
    res.end(req.method === 'HEAD' ? undefined : s.body);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    const msg = e instanceof HttpError ? e.message : e instanceof Error && /模型|DEEPSEEK|条目|简报/.test(e.message) ? e.message : '服务器内部错误';
    if (status === 500) console.error('[http]', e);
    if (res.headersSent) {
      res.end();
      return;
    }
    if (url.pathname.startsWith('/api/')) sendJson(res, status, { error: msg });
    else {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(msg);
    }
  }
});

server.headersTimeout = 20000;
server.requestTimeout = 180000;
server.listen(cfg.port, cfg.host, () => {
  console.log(`[opc] OPC Radar 已启动：${cfg.publicOrigin}（监听 ${cfg.host}:${cfg.port}，数据 ${cfg.dbPath}）`);
  console.log(`[opc] Agent-Reach：${radar.reach.enabled ? `已启用（${radar.reach.bin}）` : '未启用'}`);
  console.log(`[opc] 产品顾问：${pm.skills.length ? `已加载 ${pm.skills.length} 个 pm-skills（${pmSkillsDir}）` : `未找到 pm-skills（${pmSkillsDir}），运行 scripts/setup-pm-skills.sh`}`);
  console.log(`[opc] 模型：${radar.llm.enabled ? `DeepSeek ${cfg.llm.model}` : '未配置 DEEPSEEK_API_KEY，分析/翻译不可用'}；每 ${cfg.fetchIntervalMin} 分钟采集一次`);
  radar.startSchedule();
});

function shutdown(): void {
  radar.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
