/** 原型接口：生成、修改、重试、版本列表与预览 HTML（spec 9） */
import type http from 'node:http';
import type { DB } from '../../packages/core/db.ts';
import { assemble, protoCsp, protoFileName } from '../../packs/proto/assemble.ts';
import type { ProtoRunner } from '../../packs/proto/runner.ts';
import { getVersion, listVersions } from '../../packs/proto/store.ts';
import { ProtoError } from '../../packs/proto/types.ts';
import { HttpError, contentDisposition, readJson, sendJson } from './http.ts';

interface Deps { db: DB; runner: ProtoRunner }
const ROUTE = /^\/api\/pm\/reviews\/([1-9]\d*)\/prototypes(?:\/([1-9]\d*)(?:\/(revise|retry|html))?)?$/;

function reviewExists(db: DB, id: number): boolean {
  return db.prepare('SELECT 1 FROM pm_reviews WHERE id = ?').get(id) != null;
}

function positive(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new HttpError(400, `${name} 不合法`);
  return v;
}

/** 只处理 /api/pm/reviews/:id/prototypes 前缀；不是原型接口时返回 false */
export async function handleProtoApi(deps: Deps, req: http.IncomingMessage, res: http.ServerResponse, method: string, url: URL): Promise<boolean> {
  const m = ROUTE.exec(url.pathname);
  if (!m) return false;
  const id = Number(m[1]);
  const n = m[2] ? Number(m[2]) : 0;
  const action = m[3] || '';
  try {
    if (method === 'GET' && !n) {
      if (!reviewExists(deps.db, id)) throw new HttpError(404, '评审不存在');
      sendJson(res, 200, { prototypes: listVersions(deps.db, id) });
      return true;
    }
    if (method === 'POST' && !n) {
      if (!reviewExists(deps.db, id)) throw new HttpError(404, '评审不存在');
      const body = await readJson(req, 4096);
      const versionN = positive(body.versionN, 'versionN');
      sendJson(res, 202, { prototype: deps.runner.generate(id, versionN) });
      return true;
    }
    if (method === 'POST' && n && (action === 'revise' || action === 'retry')) {
      const meta = action === 'retry'
        ? deps.runner.retry(id, n)
        : deps.runner.revise(id, n, String((await readJson(req, 4096)).text ?? ''));
      sendJson(res, 202, { prototype: meta });
      return true;
    }
    if (method === 'GET' && n && action === 'html') {
      const row = getVersion(deps.db, id, n);
      if (!row) throw new HttpError(404, '原型版本不存在');
      if (row.status !== 'done') throw new HttpError(409, '原型还没生成完成');
      const requested = url.searchParams.get('device');
      const device = requested === 'phone' || requested === 'desktop' ? requested : undefined;
      const html = Buffer.from(assemble(row, { device }), 'utf8');
      res.setHeader('Content-Security-Policy', protoCsp(false));
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      const headers: Record<string, string | number> = {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': html.length,
      };
      if (url.searchParams.get('download') === '1') headers['content-disposition'] = contentDisposition(protoFileName(row), false);
      res.writeHead(200, headers);
      res.end(html);
      return true;
    }
    return false;
  } catch (e) {
    if (e instanceof ProtoError) throw new HttpError(e.status, e.message);
    throw e;
  }
}
