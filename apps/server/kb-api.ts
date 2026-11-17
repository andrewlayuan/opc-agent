// 知识库 API：目录、条目、上传、下载、搜索、目录建议、来源查询。调用方已完成登录与同源校验。
import fs from 'node:fs';
import type http from 'node:http';
import type { DB } from '../../packages/core/db.ts';
import type { Llm } from '../../packages/core/llm.ts';
import { createDoc, deleteDoc, findBySource, getDoc, listDocs, refreshStale, sourceText, updateDoc } from '../../packs/kb/docs.ts';
import { createFolder, deleteFolder, listFolders, updateFolder } from '../../packs/kb/folders.ts';
import { searchKb } from '../../packs/kb/search.ts';
import { suggestFolder } from '../../packs/kb/suggest.ts';
import { KB_LIMITS, KbError } from '../../packs/kb/types.ts';
import type { KbFiles } from '../../packs/kb/uploads.ts';
import { ExtractError } from '../../packs/pm/extract.ts';
import { decodeHtml } from '../../packs/pm/html.ts';
import { HttpError, contentDisposition, readBodyToFile, readJson, sendJson } from './http.ts';

export interface KbApiDeps {
  db: DB;
  files: KbFiles;
  llm: Pick<Llm, 'enabled' | 'chat'>;
}

const BODY_MAX = 16 * 1024;
/** 笔记正文 20 万字：中文 3 字节/字，另留 JSON 转义余量 */
const NOTE_BODY_MAX = 1024 * 1024;

function idOf(s: string): number {
  const id = Number(s);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, '非法 id');
  return id;
}

function optId(v: string | null): number | undefined {
  if (v == null || v === '') return undefined;
  return idOf(v);
}

/** JSON 里的可选外键：缺省为 undefined，null 表示清空，其余必须是正整数 */
function optRef(body: Record<string, unknown>, key: string): number | null | undefined {
  if (!(key in body)) return undefined;
  const v = body[key];
  if (v === null) return null;
  if (!Number.isSafeInteger(v) || (v as number) <= 0) throw new HttpError(400, '参数不合法');
  return v as number;
}

function folderParam(v: string | null): number | 'none' | null {
  if (v == null || v === '') return null;
  if (v === 'none') return 'none';
  return idOf(v);
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

function sendFile(req: http.IncomingMessage, res: http.ServerResponse, files: KbFiles, id: number): void {
  const f = files.file(id);
  let size: number;
  try {
    if (!f) throw new Error('missing');
    size = fs.statSync(f.path).size;
  } catch {
    throw new HttpError(404, '文件不存在');
  }
  const image = f.mime.startsWith('image/');
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
    console.error('[kb] 读取文件失败', e);
    res.destroy();
  });
  rs.pipe(res);
}

/**
 * 网页预览：原网页在沙箱中运行（不同源，读不到登录 Cookie、调不了接口），只允许页面自带的脚本、样式和内嵌资源，禁止一切网络请求和表单提交。
 * 已按 <meta charset> 等解码，统一以 UTF-8 输出
 */
export const PREVIEW_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  'worker-src blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

function sendPreview(res: http.ServerResponse, files: KbFiles, id: number): void {
  const f = files.file(id);
  if (!f || f.mime !== 'text/html') throw new HttpError(404, '没有可预览的网页');
  let html: string;
  try {
    html = decodeHtml(fs.readFileSync(f.path));
  } catch (e) {
    if (e instanceof ExtractError) throw new HttpError(422, e.message);
    throw new HttpError(404, '文件不存在');
  }
  const body = Buffer.from(html, 'utf8');
  res.setHeader('Content-Security-Policy', PREVIEW_CSP);
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'private, no-store',
    'cross-origin-resource-policy': 'same-origin',
    'content-length': body.length,
  });
  res.end(body);
}

/** 来源类条目在读取前按需重建；失败只记日志 */
function safeRefresh(db: DB): void {
  try {
    refreshStale(db);
  } catch (e) {
    console.error('[kb] 刷新来源失败', e);
  }
}

function view(db: DB, id: number) {
  const d = getDoc(db, id);
  if (!d) throw new HttpError(404, '条目不存在');
  return d;
}

/** 目录建议的输入：评审、资讯、条目由服务端取内容 */
function suggestInput(db: DB, body: Record<string, unknown>): { title: string; text: string } {
  const reviewId = optRef(body, 'reviewId');
  const itemId = optRef(body, 'itemId');
  const docId = optRef(body, 'docId');
  if (reviewId != null || itemId != null) {
    const s = sourceText(db, reviewId != null ? 'review' : 'item', (reviewId ?? itemId)!);
    if (!s) throw new HttpError(404, reviewId != null ? '评审不存在或尚未完成' : '资讯不存在');
    return { title: s.title, text: s.text };
  }
  if (docId != null) {
    const d = view(db, docId);
    return { title: d.doc.title, text: d.body ?? d.chunks.map((c) => c.body).join('\n\n') };
  }
  return { title: typeof body.title === 'string' ? body.title : '', text: typeof body.text === 'string' ? body.text : '' };
}

async function route(deps: KbApiDeps, req: http.IncomingMessage, res: http.ServerResponse, method: string, url: URL): Promise<boolean> {
  const { db, files } = deps;
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/kb/tree' && method === 'GET') {
    sendJson(res, 200, listFolders(db));
    return true;
  }
  if (p === '/api/kb/folders' && method === 'POST') {
    const body = await readJson(req, BODY_MAX);
    const id = createFolder(db, body.name, optRef(body, 'parentId') ?? null);
    sendJson(res, 201, { id });
    return true;
  }
  let m = p.match(/^\/api\/kb\/folders\/(\d+)$/);
  if (m && method === 'PATCH') {
    const id = idOf(m[1]);
    const body = await readJson(req, BODY_MAX);
    updateFolder(db, id, { name: body.name, parentId: optRef(body, 'parentId'), sort: body.sort === undefined ? undefined : (body.sort as number) });
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (m && method === 'DELETE') {
    deleteFolder(db, idOf(m[1]));
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (p === '/api/kb/docs' && method === 'GET') {
    const folder = folderParam(q.get('folder'));
    const term = (q.get('q') ?? '').slice(0, 200).trim();
    if (term) {
      safeRefresh(db);
      const hits = searchKb(db, term).filter((h) => folder == null || (folder === 'none' ? h.doc.folder_id == null : h.doc.folder_id === folder));
      sendJson(res, 200, { hits });
    } else {
      sendJson(res, 200, { docs: listDocs(db, folder, 500) });
    }
    return true;
  }
  if (p === '/api/kb/docs' && method === 'POST') {
    const body = await readJson(req, NOTE_BODY_MAX);
    const kind = body.kind;
    if (kind !== 'note' && kind !== 'review' && kind !== 'item') throw new HttpError(400, '类型不合法');
    const id = createDoc(db, {
      kind,
      title: body.title,
      folderId: optRef(body, 'folderId') ?? null,
      body: body.body,
      reviewId: kind === 'review' ? (body.reviewId as number) : undefined,
      itemId: kind === 'item' ? (body.itemId as number) : undefined,
    });
    sendJson(res, 201, { doc: view(db, id).doc });
    return true;
  }
  if (p === '/api/kb/uploads' && method === 'POST') {
    if (!String(req.headers['content-type'] || '').startsWith('application/octet-stream')) throw new HttpError(415, '需要 application/octet-stream');
    const name = uploadName(req);
    const folder = optId(q.get('folder')) ?? null;
    const tmp = files.tmpPath();
    try {
      await readBodyToFile(req, tmp, KB_LIMITS.fileMax);
    } catch (e) {
      // 剩余请求体不再读取，回应后关闭连接
      if (e instanceof HttpError && e.status === 413) res.setHeader('connection', 'close');
      throw e;
    }
    sendJson(res, 202, { doc: files.create(tmp, name, folder) });
    return true;
  }
  m = p.match(/^\/api\/kb\/docs\/(\d+)$/);
  if (m && method === 'GET') {
    const id = idOf(m[1]);
    safeRefresh(db);
    sendJson(res, 200, view(db, id));
    return true;
  }
  if (m && method === 'PATCH') {
    const id = idOf(m[1]);
    const body = await readJson(req, NOTE_BODY_MAX);
    updateDoc(db, id, { title: body.title, folderId: optRef(body, 'folderId'), body: body.body });
    sendJson(res, 200, { doc: view(db, id).doc });
    return true;
  }
  if (m && method === 'DELETE') {
    const { storage } = deleteDoc(db, idOf(m[1]));
    files.unlink(storage);
    sendJson(res, 200, { ok: true });
    return true;
  }
  m = p.match(/^\/api\/kb\/docs\/(\d+)\/preview$/);
  if (m && method === 'GET') {
    sendPreview(res, files, idOf(m[1]));
    return true;
  }
  m = p.match(/^\/api\/kb\/docs\/(\d+)\/file$/);
  if (m && (method === 'GET' || method === 'HEAD')) {
    sendFile(req, res, files, idOf(m[1]));
    return true;
  }
  if (p === '/api/kb/suggest' && method === 'POST') {
    const body = await readJson(req, BODY_MAX);
    const input = suggestInput(db, body);
    sendJson(res, 200, await suggestFolder(db, deps.llm, input));
    return true;
  }
  if (p === '/api/kb/source' && method === 'GET') {
    const reviewId = optId(q.get('reviewId'));
    const itemId = optId(q.get('itemId'));
    if (reviewId == null && itemId == null) throw new HttpError(400, '缺少来源参数');
    safeRefresh(db);
    sendJson(res, 200, { docId: findBySource(db, reviewId != null ? { reviewId } : { itemId }) });
    return true;
  }
  return false;
}

/** 处理 /api/kb 下的接口；不是知识库接口时返回 false。KbError 映射为 HTTP 状态码，409 带上已有 docId */
export async function handleKbApi(deps: KbApiDeps, req: http.IncomingMessage, res: http.ServerResponse, method: string, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/kb' && !url.pathname.startsWith('/api/kb/')) return false;
  try {
    if (await route(deps, req, res, method, url)) return true;
  } catch (e) {
    if (!(e instanceof KbError)) throw e;
    if (e.docId !== undefined) {
      sendJson(res, e.status, { error: e.message, docId: e.docId });
      return true;
    }
    throw new HttpError(e.status, e.message);
  }
  throw new HttpError(404, '接口不存在');
}
