import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { LoginLimiter, createSession, deleteSession, getSession, safeEqualStr, verifyPassword } from '../../packages/core/auth.ts';
import { loadConfig } from '../../packages/core/config.ts';
import { openDb } from '../../packages/core/db.ts';
import { allowHost } from '../../packages/core/net.ts';
import { KbFiles } from '../../packs/kb/uploads.ts';
import { WikiAssets } from '../../packs/wiki/assets.ts';
import { WikiQueue } from '../../packs/wiki/queue.ts';
import { recallWiki } from '../../packs/wiki/recall.ts';
import { MemoryKeeper } from '../../packs/memory/consolidate.ts';
import { resolveRefs, touchMemories, userContext } from '../../packs/memory/context.ts';
import { paragraphDiff, recordEvent } from '../../packs/memory/events.ts';
import type { EventInput } from '../../packs/memory/events.ts';
import { hasSensitive } from '../../packs/memory/sensitive.ts';
import { analyzeItem, generateBrief, latestBrief, translateItem } from '../../packs/radar/analyze.ts';
import { GROUPS, collectOnce } from '../../packs/radar/collect.ts';
import { enrichItem } from '../../packs/radar/enrich.ts';
import { MAX_ADD, MAX_REVIEW_SKILLS, MAX_SELECTED, PmAdvisor, PmError } from '../../packs/pm/advisor.ts';
import type { AdvisorEvent } from '../../packs/pm/advisor.ts';
import { AttachmentError, AttachmentStore, LIMITS } from '../../packs/pm/attachments.ts';
import { exportMarkdown, renderPrintHtml } from '../../packs/pm/render.ts';
import { defaultSkillsDir, loadPmSkills } from '../../packs/pm/skills.ts';
import { ProtoRunner } from '../../packs/proto/runner.ts';
import { getVersion as getProtoVersion, recover as recoverProtos } from '../../packs/proto/store.ts';
import { getInterests, setInterests } from '../../packs/radar/prefs.ts';
import { getItem, listItems, stats } from '../../packs/radar/query.ts';
import { Radar } from '../../packs/radar/service.ts';
import { HttpError, clientIp, contentDisposition, parseCookies, readBodyToFile, readJson, sameOrigin, securityHeaders, sendJson, staticFor } from './http.ts';
import { handleMemoryApi } from './memory-api.ts';
import { handleKbApi } from './kb-api.ts';
import { handleWikiApi } from './wiki-api.ts';
import { handleProtoApi } from './proto-api.ts';
import { handleComplianceApi } from './compliance-api.ts';

const cfg = loadConfig({ requireAuth: true });
const db = openDb(cfg.dbPath);
const radar = new Radar(db, cfg, undefined, { analyzeContext: () => userContext(db, 'analyze').text });
const keeper = new MemoryKeeper(db, radar.llm);
const pmSkillsDir = defaultSkillsDir();
const files = new AttachmentStore(db, path.join(cfg.dataDir, 'uploads'), radar.llm);
const kbFiles = new KbFiles(db, path.join(cfg.dataDir, 'kb'), radar.llm);
const wikiAssets = new WikiAssets(db, path.join(cfg.dataDir, 'wiki-assets'));
const wikiTmp = path.join(cfg.dataDir, 'wiki-export');
const wikiQueue = new WikiQueue(db, radar.llm, { dailyCalls: cfg.wikiDailyCalls });
const pm = new PmAdvisor(
  db,
  radar.llm,
  loadPmSkills(pmSkillsDir),
  undefined,
  {
    context: (_, o) => userContext(db, 'pm', o),
    onEvent: (e) => record({ ...scrubAttachments(e), refType: 'review' }),
    used: (ids) => touchMemories(db, ids),
    kb: (q) => recallWiki(db, q),
  },
  files,
);
const protoRunner = new ProtoRunner(db, radar.llm, {
  prd: (id, n) => {
    const v = pm.version(id, n);
    const r = v && pm.get(id);
    return v && r ? { title: r.input, content: v.content, status: r.status } : null;
  },
  onEvent: (e) => record(e),
});

/** 事件写入前过滤附件摘录中的敏感内容 */
function scrubAttachments(e: AdvisorEvent): AdvisorEvent {
  const list = e.payload.attachments;
  if (!Array.isArray(list)) return e;
  const attachments = list.map((a: { name: string; excerpt: string }) => (hasSensitive(a.excerpt) ? { ...a, excerpt: '' } : a));
  return { ...e, payload: { ...e.payload, attachments } };
}
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
    if (e instanceof PmError || e instanceof AttachmentError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

/** X-File-Name 为 encodeURIComponent 编码的原文件名 */
function uploadName(req: http.IncomingMessage): string {
  const raw = req.headers['x-file-name'];
  if (typeof raw !== 'string' || !raw) throw new HttpError(400, '缺少文件名');
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, '文件名编码错误');
  }
}

function sendAttachmentFile(req: http.IncomingMessage, res: http.ServerResponse, id: number): void {
  const f = files.file(id);
  let size: number;
  try {
    if (!f) throw new Error('missing');
    size = fs.statSync(f.path).size;
  } catch {
    throw new HttpError(404, '附件不存在');
  }
  const image = f.kind === 'image';
  res.writeHead(200, {
    'content-type': image ? f.mime : 'application/octet-stream',
    'content-disposition': contentDisposition(f.name, image),
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': 'private, max-age=3600',
    'content-length': size,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const rs = fs.createReadStream(f.path);
  rs.on('error', (e) => {
    console.error('[pm] 读取附件失败', e);
    res.destroy();
  });
  rs.pipe(res);
}

function versionNo(s: string): number {
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(404, '版本不存在');
  return n;
}

let briefRunning = false;

/** 操作成功后记录交互事件；传函数时在 try 内构造。失败只记日志，不影响原操作的响应 */
function record(input: EventInput | (() => EventInput | null)): void {
  try {
    const e = typeof input === 'function' ? input() : input;
    if (e && recordEvent(db, e) !== null) keeper.notify(e.kind);
  } catch (err) {
    console.error('[memory] 记录事件失败', err);
  }
}

/** 上下文计算出错时按无上下文继续 */
function safeContext(purpose: 'analyze' | 'brief'): { text: string; memoryIds: number[] } {
  try {
    return userContext(db, purpose);
  } catch (err) {
    console.error('[memory] 读取用户上下文失败', err);
    return { text: '', memoryIds: [] };
  }
}

/** 模型调用成功后再给用到的记忆计数；失败只记日志 */
function safeTouch(ids: number[]): void {
  try {
    touchMemories(db, ids);
  } catch (err) {
    console.error('[memory] 更新记忆使用次数失败', err);
  }
}

function topicLabels(ids: string[]): string[] {
  const label = Object.fromEntries(radar.topics.map((t) => [t.id, t.label]));
  return ids.map((t) => label[t] ?? t);
}

function itemTitle(it: { title: string; title_zh: string | null }): string {
  return it.title_zh || it.title;
}

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
      relevant: s.get('rel') === '1',
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
    await analyzeItem(db, radar.llm, radar.topics, id, safeContext('analyze').text);
    const item = getItem(db, id);
    if (item) record({ kind: 'item_analyze', refType: 'item', refId: id, summary: `手动分析：${itemTitle(item)}`, payload: { topics: item.topics } });
    return sendJson(res, 200, { item });
  }
  m = p.match(/^\/api\/items\/(\d+)\/translate$/);
  if (m && method === 'POST') {
    const id = idFrom(m);
    if (!getItem(db, id)) throw new HttpError(404, '条目不存在');
    await enrichItem(db, radar.reach, id);
    const translation = await translateItem(db, radar.llm, id);
    record(() => {
      const item = getItem(db, id);
      return item ? { kind: 'item_translate', refType: 'item', refId: id, summary: `翻译全文：${itemTitle(item)}`, payload: {} } : null;
    });
    return sendJson(res, 200, { translation });
  }
  m = p.match(/^\/api\/items\/(\d+)\/star$/);
  if (m && method === 'POST') {
    const id = idFrom(m);
    const body = await readJson(req, 1024);
    const r = db.prepare('UPDATE items SET starred=? WHERE id=?').run(body.starred ? 1 : 0, id);
    if (!r.changes) throw new HttpError(404, '条目不存在');
    record(() => {
      const item = getItem(db, id);
      if (!item) return null;
      const meta = [topicLabels(item.topics).join('/'), item.importance ? `重要度 ${item.importance}` : ''].filter(Boolean).join('，');
      return {
        kind: body.starred ? 'item_star' : 'item_unstar',
        refType: 'item',
        refId: id,
        summary: `${body.starred ? '收藏' : '取消收藏'}：${itemTitle(item)}${meta ? `（${meta}）` : ''}`,
        payload: { topics: item.topics, importance: item.importance },
      };
    });
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
      const ctx = safeContext('brief');
      const b = await generateBrief(db, radar.llm, radar.topics, 24, focus, ctx.text);
      safeTouch(ctx.memoryIds);
      record({ kind: 'brief_generate', refType: 'brief', refId: b.id, summary: `生成简报${focus.length ? `（聚焦：${topicLabels(focus).join('、')}）` : ''}`, payload: { focus } });
      return sendJson(res, 200, { brief: b });
    } finally {
      briefRunning = false;
    }
  }

  if (p === '/api/prefs/interests' && method === 'GET') return sendJson(res, 200, { interests: getInterests(db, radar.topics) });
  if (p === '/api/prefs/interests' && method === 'PUT') {
    const body = await readJson(req, 4096);
    const before = getInterests(db, radar.topics);
    const after = setInterests(db, radar.topics, body);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      const scope = after.topics.length ? topicLabels(after.topics).join('、') : '（无）';
      const level = after.minImportance ? `重要度 ≥${after.minImportance}` : '重要度不限';
      record({ kind: 'interests_update', refType: 'prefs', summary: `关注改为：${scope}；${level}`, payload: { before, after } });
    }
    return sendJson(res, 200, { interests: after });
  }

  if (await handleMemoryApi({ db, keeper, llmEnabled: radar.llm.enabled }, req, res, method, p)) return;
  if (await handleKbApi({ db, files: kbFiles, llm: radar.llm }, req, res, method, url)) return;
  if (await handleWikiApi({ db, llm: radar.llm, queue: wikiQueue, assets: wikiAssets, tmpDir: wikiTmp }, req, res, method, url)) return;
  if (await handleProtoApi({ db, runner: protoRunner }, req, res, method, url)) return;
  if (await handleComplianceApi({ db, llm: radar.llm, record }, req, res, method, url)) return;

  // ---------- 产品顾问（pm-skills） ----------
  if (p === '/api/pm/meta' && method === 'GET') {
    return sendJson(res, 200, {
      enabled: pm.enabled,
      skillsFound: pm.skills.length,
      llm: radar.llm.enabled,
      presets: pm.presets(),
      skills: pm.catalog(),
      maxSelected: MAX_SELECTED,
      maxAdd: MAX_ADD,
      maxReviewSkills: MAX_REVIEW_SKILLS,
    });
  }
  if (p === '/api/pm/uploads' && method === 'POST') {
    if (!String(req.headers['content-type'] || '').startsWith('application/octet-stream')) throw new HttpError(415, '需要 application/octet-stream');
    const name = uploadName(req);
    const tmp = files.tmpPath();
    try {
      await readBodyToFile(req, tmp, LIMITS.fileMax);
    } catch (e) {
      // 剩余请求体不再读取，回应后关闭连接
      if (e instanceof HttpError && e.status === 413) res.setHeader('connection', 'close');
      throw e;
    }
    const attachment = pmCall(() => files.create(tmp, name));
    return sendJson(res, 202, { attachment });
  }
  m = p.match(/^\/api\/pm\/uploads\/(\d+)$/);
  if (m && method === 'GET') {
    const attachment = files.view(idFrom(m));
    if (!attachment) throw new HttpError(404, '附件不存在');
    return sendJson(res, 200, { attachment });
  }
  if (m && method === 'DELETE') {
    const id = idFrom(m);
    pmCall(() => files.remove(id));
    return sendJson(res, 200, { ok: true });
  }
  m = p.match(/^\/api\/pm\/uploads\/(\d+)\/file$/);
  if (m && (method === 'GET' || method === 'HEAD')) return sendAttachmentFile(req, res, idFrom(m));
  if (p === '/api/pm/reviews' && method === 'GET') return sendJson(res, 200, { reviews: pm.list(30) });
  if (p === '/api/pm/reviews' && method === 'POST') {
    // 8000 字上限按 UTF-8 最坏 4 字节/字计，另留 JSON 转义余量
    const body = await readJson(req, 64 * 1024);
    let id: number;
    try {
      id = pm.start({
        input: typeof body.input === 'string' ? body.input : '',
        presets: body.presets,
        skills: body.skills,
        useRadar: body.useRadar !== false,
        attachmentIds: body.attachmentIds,
      });
    } catch (e) {
      if (e instanceof AttachmentError) throw new HttpError(e.status, e.message);
      throw new HttpError(400, e instanceof Error ? e.message : '提交失败');
    }
    return sendJson(res, 202, { id });
  }
  m = p.match(/^\/api\/pm\/reviews\/(\d+)$/);
  if (m && method === 'GET') {
    const r = pm.get(idFrom(m));
    if (!r) throw new HttpError(404, '评审不存在');
    const review = { ...r, context: resolveRefs(db, r.context_refs), messages: r.messages.map((x) => ({ ...x, context: resolveRefs(db, x.context_refs) })) };
    return sendJson(res, 200, { review });
  }
  if (m && method === 'DELETE') {
    const id = idFrom(m);
    if (!pmCall(() => pm.delete(id))) throw new HttpError(404, '评审不存在或仍在进行中');
    return sendJson(res, 200, { ok: true });
  }
  m = p.match(/^\/api\/pm\/reviews\/(\d+)\/messages$/);
  if (m && method === 'POST') {
    const id = idFrom(m);
    // 8000 字上限按 UTF-8 最坏 4 字节/字计，另留 JSON 转义余量
    const body = await readJson(req, 64 * 1024);
    const messageId = pmCall(() => pm.ask(id, typeof body.text === 'string' ? body.text : '', body.mode, body.attachmentIds, body.skills));
    return sendJson(res, 202, { messageId });
  }
  m = p.match(/^\/api\/pm\/reviews\/(\d+)\/versions$/);
  if (m && method === 'POST') {
    const id = idFrom(m);
    // 80000 字上限：中文 3 字节/字，另留 JSON 转义余量
    const body = await readJson(req, 384 * 1024);
    const content = typeof body.content === 'string' ? body.content : '';
    const n = pmCall(() => pm.saveManual(id, content, body.baseN));
    record(() => ({ kind: 'version_manual', refType: 'review', refId: id, summary: `手动编辑 v${n}`, payload: paragraphDiff(pm.version(id, n - 1)?.content ?? '', content.trim()) }));
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
    const proto = url.pathname.match(/^\/proto\/([1-9]\d*)\/([1-9]\d*)$/);
    if (proto) {
      if (!user) {
        res.writeHead(302, { location: '/login' }).end();
        return;
      }
      if (!getProtoVersion(db, idFrom(proto), Number(proto[2]))) throw new HttpError(404, '原型版本不存在');
      const page = staticFor('/proto-full.html')!;
      res.writeHead(200, { 'content-type': page.type, 'cache-control': 'no-cache', 'content-length': page.body.length });
      res.end(req.method === 'HEAD' ? undefined : page.body);
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
  console.log(`[opc] 天枢 Tianshu 已启动：${cfg.publicOrigin}（监听 ${cfg.host}:${cfg.port}，数据 ${cfg.dbPath}）`);
  console.log(`[opc] Agent-Reach：${radar.reach.enabled ? `已启用（${radar.reach.bin}）` : '未启用'}`);
  console.log(`[opc] 产品顾问：${pm.skills.length ? `已加载 ${pm.skills.length} 个 pm-skills（${pmSkillsDir}）` : `未找到 pm-skills（${pmSkillsDir}），运行 scripts/setup-pm-skills.sh`}`);
  console.log(`[opc] 模型：${radar.llm.enabled ? `DeepSeek ${cfg.llm.model}` : '未配置 DEEPSEEK_API_KEY，分析/翻译不可用'}；每 ${cfg.fetchIntervalMin} 分钟采集一次`);
  radar.startSchedule();
  keeper.start();
  try {
    // 上次运行中断时遗留的导出临时文件
    fs.rmSync(wikiTmp, { recursive: true, force: true });
    wikiQueue.start();
    const ws = wikiQueue.status();
    const pages = Number((db.prepare('SELECT count(*) AS n FROM wiki_pages WHERE deleted = 0').get() as { n: number }).n);
    console.log(`[wiki] ${radar.llm.enabled ? '已启用' : '模型未配置，暂停摄入'}：${pages} 页，排队 ${ws.queued}，今日调用 ${ws.usedToday}/${ws.limit}`);
  } catch (e) {
    console.error('[wiki] 启动队列失败', e);
  }
  try {
    const n = files.recover();
    if (n) console.log(`[pm] ${n} 个附件因重启中断，已标记为失败`);
  } catch (e) {
    console.error('[pm] 恢复附件状态失败', e);
  }
  try {
    const n = kbFiles.recover();
    if (n) console.log(`[kb] ${n} 个上传因重启中断，已标记为失败`);
  } catch (e) {
    console.error('[kb] 恢复上传状态失败', e);
  }
  try {
    const n = recoverProtos(db);
    if (n) console.log(`[proto] ${n} 个原型任务因重启中断，已标记为失败`);
  } catch (e) {
    console.error('[proto] 恢复原型状态失败', e);
  }
  cleanupFiles();
  setInterval(cleanupFiles, 3600000).unref();
});

function cleanupFiles(): void {
  try {
    files.cleanup();
  } catch (e) {
    console.error('[pm] 清理附件失败', e);
  }
}

function shutdown(): void {
  radar.stop();
  keeper.stop();
  wikiQueue.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
