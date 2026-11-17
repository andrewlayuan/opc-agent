// Wiki API：页面、版本、图片、图谱、提问、队列、操作日志、导出。调用方已完成登录与同源校验
import fs from 'node:fs';
import type http from 'node:http';
import type { DB } from '../../packages/core/db.ts';
import { LlmError } from '../../packages/core/llm.ts';
import type { Llm } from '../../packages/core/llm.ts';
import { askWiki, saveAnswer } from '../../packs/wiki/ask.ts';
import type { WikiAssets } from '../../packs/wiki/assets.ts';
import { lineDiff } from '../../packs/wiki/diff.ts';
import { exportWiki, parseScope } from '../../packs/wiki/export.ts';
import { slugify } from '../../packs/wiki/parse.ts';
import type { WikiQueue } from '../../packs/wiki/queue.ts';
import { restorePage, revertOp } from '../../packs/wiki/revert.ts';
import { createOp, finishOp, getOp, getPage, getPageRow, getRevision, listOps, listPages, listRevisions, tx, writePages } from '../../packs/wiki/store.ts';
import { WIKI_LIMITS, WikiError, isPageKind } from '../../packs/wiki/types.ts';
import { HttpError, contentDisposition, readBodyToFile, readJson, sendJson } from './http.ts';

export interface WikiApiDeps {
  db: DB;
  llm: Llm;
  queue: WikiQueue;
  assets: WikiAssets;
  tmpDir: string;
}

const BODY_SMALL = 8 * 1024;
/** 正文 2 万字：中文 3 字节/字，另留 JSON 转义余量 */
const BODY_PAGE = 256 * 1024;
const BODY_ANSWER = 128 * 1024;
const OPS_PAGE = 30;
const OPS_MAX = 100;
const DIFF_PAGES = 50;

function idOf(s: string): number {
  const id = Number(s);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, '非法 id');
  return id;
}

/** 路径或查询中的 slug：解码后必须已经是规范形式，否则 400 */
function slugParam(raw: string | null): string {
  let s: string;
  try {
    s = decodeURIComponent(raw ?? '');
  } catch {
    throw new HttpError(400, '页面名称不合法');
  }
  if (!s || slugify(s) !== s) throw new HttpError(400, '页面名称不合法');
  return s;
}

function livePage(db: DB, slug: string) {
  const p = getPage(db, slug);
  if (!p) throw new HttpError(404, '页面不存在');
  const links = (
    db
      .prepare('SELECT l.to_slug AS slug, p.title AS title FROM wiki_links l LEFT JOIN wiki_pages p ON p.slug = l.to_slug AND p.deleted = 0 WHERE l.from_page = ? ORDER BY l.to_slug')
      .all(p.id) as { slug: string; title: string | null }[]
  ).map((l) => ({ slug: l.slug, title: l.title ?? null }));
  return { ...p, links };
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function putPage(db: DB, slug: string, body: Record<string, unknown>) {
  const baseRev = body.baseRev ?? 0;
  if (!Number.isSafeInteger(baseRev) || (baseRev as number) < 0) throw new HttpError(400, 'baseRev 不合法');
  if (body.kind !== undefined && !isPageKind(body.kind)) throw new HttpError(400, '页面类型不合法');
  return tx(db, () => {
    const old = getPageRow(db, slug);
    if (old && !old.deleted && old.rev !== baseRev) throw new HttpError(409, '页面已被更新，请刷新后再改');
    const kind = isPageKind(body.kind) ? body.kind : (old?.kind ?? 'concept');
    const opId = createOp(db, 'edit', { status: 'running' });
    const { changes, dropped } = writePages(db, opId, [{ slug, kind, title: str(body.title), summary: str(body.summary), body: str(body.body) }], { byUser: true });
    finishOp(db, opId, { status: 'done', pages: changes, note: `编辑「${str(body.title).trim().slice(0, 40)}」` });
    return { opId, dropped };
  });
}

function graph(db: DB) {
  const nodes = db
    .prepare(
      `SELECT p.slug, p.title, p.kind,
              (SELECT count(DISTINCT l.from_page) FROM wiki_links l JOIN wiki_pages f ON f.id = l.from_page AND f.deleted = 0 WHERE l.to_slug = p.slug AND l.from_page != p.id) AS backlinks
       FROM wiki_pages p WHERE p.deleted = 0 ORDER BY p.id`,
    )
    .all() as { slug: string; title: string; kind: string; backlinks: number }[];
  const edges = db
    .prepare(
      `SELECT f.slug AS "from", t.slug AS "to" FROM wiki_links l
       JOIN wiki_pages f ON f.id = l.from_page AND f.deleted = 0
       JOIN wiki_pages t ON t.slug = l.to_slug AND t.deleted = 0
       WHERE f.id != t.id ORDER BY f.id, t.id`,
    )
    .all() as { from: string; to: string }[];
  return {
    nodes: nodes.map((n) => ({ slug: n.slug, title: n.title, kind: n.kind, backlinks: Number(n.backlinks) })),
    edges: edges.map((e) => ({ from: e.from, to: e.to })),
  };
}

function opDetail(db: DB, id: number) {
  const op = getOp(db, id);
  if (!op) throw new HttpError(404, '操作不存在');
  const diffs = op.pages.slice(0, DIFF_PAGES).map((c) => {
    const before = c.from_rev > 0 ? getRevision(db, c.page_id, c.from_rev) : null;
    const after = getRevision(db, c.page_id, c.to_rev);
    return {
      slug: c.slug,
      from_rev: c.from_rev,
      to_rev: c.to_rev,
      title: after?.title ?? before?.title ?? c.slug,
      deleted: Boolean(after?.deleted),
      /** 版本已被清理时无法给出差异 */
      pruned: (c.from_rev > 0 && !before) || !after,
      diff: lineDiff(before && !before.deleted ? before.body : '', after && !after.deleted ? after.body : ''),
    };
  });
  return { op, diffs };
}

const docTitles = (db: DB, ids: number[]) => {
  const m = new Map<number, string>();
  const q = db.prepare('SELECT title FROM kb_docs WHERE id = ?');
  for (const id of new Set(ids)) {
    const r = q.get(id) as { title: string } | undefined;
    if (r) m.set(id, r.title);
  }
  return m;
};

const pad = (n: number) => String(n).padStart(2, '0');
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
};

async function sendExport(deps: WikiApiDeps, res: http.ServerResponse, rawScope: string | null): Promise<void> {
  const scope = parseScope(rawScope ?? '');
  fs.mkdirSync(deps.tmpDir, { recursive: true, mode: 0o700 });
  const r = await exportWiki(deps.db, scope, { assetsDir: deps.assets.dir, tmpDir: deps.tmpDir });
  const cleanup = () => fs.rm(r.file, { force: true }, () => {});
  res.on('close', cleanup);
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': contentDisposition(`tianshu-wiki-${today()}.zip`, false),
    'content-length': r.bytes,
    'cache-control': 'no-store',
  });
  const rs = fs.createReadStream(r.file);
  rs.on('error', (e) => {
    console.error('[wiki] 发送导出文件失败', e);
    res.destroy();
  });
  rs.pipe(res);
}

function sendAsset(req: http.IncomingMessage, res: http.ServerResponse, assets: WikiAssets, id: number): void {
  const f = assets.read(id);
  let size: number;
  try {
    if (!f) throw new Error('missing');
    const st = fs.lstatSync(f.file);
    if (!st.isFile()) throw new Error('not file');
    size = st.size;
  } catch {
    throw new HttpError(404, '图片不存在');
  }
  res.writeHead(200, {
    'content-type': f!.mime,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
    'cache-control': 'private, max-age=86400',
    'content-length': size,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const rs = fs.createReadStream(f!.file);
  rs.on('error', (e) => {
    console.error('[wiki] 读取图片失败', e);
    res.destroy();
  });
  rs.pipe(res);
}

async function route(deps: WikiApiDeps, req: http.IncomingMessage, res: http.ServerResponse, method: string, url: URL): Promise<boolean> {
  const { db, queue } = deps;
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/wiki/pages' && method === 'GET') {
    const kind = q.get('kind') || undefined;
    if (kind !== undefined && !isPageKind(kind)) throw new HttpError(400, '页面类型不合法');
    sendJson(res, 200, { pages: listPages(db, { kind, q: (q.get('q') ?? '').slice(0, 200) }) });
    return true;
  }
  let m = p.match(/^\/api\/wiki\/pages\/([^/]+)(?:\/(generate|revisions|restore))?$/);
  if (m) {
    const slug = slugParam(m[1]);
    const sub = m[2];
    if (!sub && method === 'GET') {
      sendJson(res, 200, { page: livePage(db, slug) });
      return true;
    }
    if (!sub && method === 'PUT') {
      const r = putPage(db, slug, await readJson(req, BODY_PAGE));
      sendJson(res, 200, { page: livePage(db, slug), opId: r.opId, dropped: r.dropped });
      return true;
    }
    if (sub === 'generate' && method === 'POST') {
      if (getPage(db, slug)) throw new HttpError(409, '页面已存在');
      const opId = queue.enqueueGenerate(slug);
      queue.kick();
      sendJson(res, 202, { opId });
      return true;
    }
    if (sub === 'revisions' && method === 'GET') {
      const page = getPageRow(db, slug);
      if (!page) throw new HttpError(404, '页面不存在');
      const rawRev = q.get('rev');
      if (rawRev == null) {
        sendJson(res, 200, { revisions: listRevisions(db, page.id), rev: page.rev });
        return true;
      }
      const revision = getRevision(db, page.id, idOf(rawRev));
      if (!revision) throw new HttpError(404, '版本不存在');
      const diff = q.get('diff') === '1' ? lineDiff(revision.deleted ? '' : revision.body, page.deleted ? '' : page.body) : undefined;
      sendJson(res, 200, { revision, diff, rev: page.rev });
      return true;
    }
    if (sub === 'restore' && method === 'POST') {
      const body = await readJson(req, BODY_SMALL);
      if (!Number.isSafeInteger(body.rev) || (body.rev as number) <= 0) throw new HttpError(400, '版本号不合法');
      sendJson(res, 200, { change: restorePage(db, slug, body.rev as number) });
      return true;
    }
    return false;
  }

  if (p === '/api/wiki/assets' && method === 'POST') {
    if (!String(req.headers['content-type'] || '').startsWith('application/octet-stream')) {
      res.setHeader('connection', 'close');
      throw new HttpError(415, '需要 application/octet-stream');
    }
    const page = getPageRow(db, slugParam(q.get('page')));
    if (!page || page.deleted) {
      res.setHeader('connection', 'close');
      throw new HttpError(404, '页面不存在');
    }
    const tmp = deps.assets.tmpPath();
    try {
      await readBodyToFile(req, tmp, WIKI_LIMITS.assetMax);
    } catch (e) {
      if (e instanceof HttpError && e.status === 413) {
        res.setHeader('connection', 'close');
        throw new HttpError(413, '图片最大 5MB');
      }
      throw e;
    }
    const r = deps.assets.create(tmp, page.id);
    sendJson(res, 201, { ...r, markdown: `![](asset:${r.id})` });
    return true;
  }
  m = p.match(/^\/api\/wiki\/assets\/(\d+)$/);
  if (m && (method === 'GET' || method === 'HEAD')) {
    sendAsset(req, res, deps.assets, idOf(m[1]));
    return true;
  }

  if (p === '/api/wiki/graph' && method === 'GET') {
    sendJson(res, 200, graph(db));
    return true;
  }
  if (p === '/api/wiki/ask' && method === 'POST') {
    const body = await readJson(req, BODY_SMALL);
    if (!deps.llm.enabled) throw new HttpError(503, '未配置模型，无法提问');
    sendJson(res, 200, await askWiki(db, deps.llm, body.question, { usedToday: () => queue.usedToday(), limit: queue.limit }));
    return true;
  }
  if (p === '/api/wiki/answers' && method === 'POST') {
    const body = await readJson(req, BODY_ANSWER);
    sendJson(res, 201, saveAnswer(db, body.question, body.answer));
    return true;
  }
  if (p === '/api/wiki/status' && method === 'GET') {
    sendJson(res, 200, { ...queue.status(), docs: Object.fromEntries(queue.docStates()) });
    return true;
  }
  m = p.match(/^\/api\/wiki\/ingest\/(\d+)$/);
  if (m && method === 'POST') {
    const opId = queue.enqueueIngest(idOf(m[1]), { manual: true });
    queue.kick();
    sendJson(res, 202, { opId });
    return true;
  }
  if (p === '/api/wiki/lint' && method === 'POST') {
    const opId = queue.enqueueLint();
    queue.kick();
    sendJson(res, 202, { opId });
    return true;
  }

  if (p === '/api/wiki/ops' && method === 'GET') {
    const before = q.get('before') ? idOf(q.get('before')!) : undefined;
    const rawLimit = q.get('limit');
    const limit = rawLimit ? Math.min(OPS_MAX, idOf(rawLimit)) : OPS_PAGE;
    const ops = listOps(db, { before, limit });
    const titles = docTitles(
      db,
      ops.flatMap((o) => (o.doc_id == null ? [] : [o.doc_id])),
    );
    sendJson(res, 200, { ops: ops.map((o) => ({ ...o, doc_title: o.doc_id == null ? null : (titles.get(o.doc_id) ?? null) })) });
    return true;
  }
  m = p.match(/^\/api\/wiki\/ops\/(\d+)(?:\/(revert|retry))?$/);
  if (m) {
    const id = idOf(m[1]);
    if (!m[2] && method === 'GET') {
      sendJson(res, 200, opDetail(db, id));
      return true;
    }
    if (m[2] === 'revert' && method === 'POST') {
      const body = await readJson(req, BODY_SMALL);
      const r = revertOp(db, id, { force: body.force === true });
      if (r.conflicts.length) sendJson(res, 409, { error: '部分页面已被后来的操作修改', conflicts: r.conflicts });
      else sendJson(res, 200, { revertOp: r.revertOp });
      return true;
    }
    if (m[2] === 'retry' && method === 'POST') {
      const opId = queue.retry(id);
      queue.kick();
      sendJson(res, 202, { opId });
      return true;
    }
    return false;
  }

  if (p === '/api/wiki/export' && method === 'GET') {
    await sendExport(deps, res, q.get('scope'));
    return true;
  }
  return false;
}

/** 处理 /api/wiki 下的接口；不是 Wiki 接口时返回 false。WikiError 映射为对应状态码，模型错误为 502 */
export async function handleWikiApi(deps: WikiApiDeps, req: http.IncomingMessage, res: http.ServerResponse, method: string, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/wiki' && !url.pathname.startsWith('/api/wiki/')) return false;
  try {
    if (await route(deps, req, res, method, url)) return true;
  } catch (e) {
    if (e instanceof WikiError) throw new HttpError(e.status, e.message);
    if (e instanceof LlmError) throw new HttpError(502, e.message);
    throw e;
  }
  throw new HttpError(404, '接口不存在');
}
