// 运营接口：投放、平台文案的生成、AI 复核、编辑、替换、保留、版本、定稿与导出。调用方已完成登录与同源校验
import type http from 'node:http';
import type { DB } from '../../packages/core/db.ts';
import type { Llm } from '../../packages/core/llm.ts';
import { AI_NOTICE, RULES } from '../../packs/growth/checker.ts';
import { exportCampaign, parseExportFormat } from '../../packs/growth/export.ts';
import { generateCopy } from '../../packs/growth/gen.ts';
import { PLATFORMS } from '../../packs/growth/platforms.ts';
import { reviewCopy } from '../../packs/growth/review.ts';
import {
  TONES, addCopy, createCampaign, deleteCampaign, deleteCopy, finalizeCopy, getCampaign, getCopy, getRevision, keepHit, listCampaigns,
  listRevisions, replaceHits, restoreRevision, saveCopy, unfinalizeCopy, updateCampaign,
} from '../../packs/growth/store.ts';
import { GrowthError } from '../../packs/growth/types.ts';
import { NO_LLM, idOf } from './compliance-api.ts';
import { HttpError, contentDisposition, readJson, sendJson } from './http.ts';

export interface GrowthDeps {
  db: DB;
  llm: Llm;
}

/** 文案字段最长约 3000 字 ×3 倍，按 UTF-8 最坏 4 字节加 JSON 转义留余量 */
const COPY_BYTES = 384 * 1024;

function meta(deps: GrowthDeps) {
  const assessed = new Set((deps.db.prepare('SELECT DISTINCT product_id FROM cp_assessments').all() as { product_id: number }[]).map((r) => Number(r.product_id)));
  const products = deps.db.prepare('SELECT id, name, description FROM cp_products ORDER BY updated_at DESC, id DESC').all() as { id: number; name: string; description: string }[];
  return {
    platforms: PLATFORMS.map((p) => ({ id: p.id, name: p.name, fields: p.fields, total: p.total ? { label: p.total.label, min: p.total.min, max: p.total.max } : null })),
    tones: TONES,
    products: products.map((p) => ({ id: Number(p.id), name: String(p.name), description: String(p.description), assessed: assessed.has(Number(p.id)) })),
    rules: RULES.map(({ id, label, basis }) => ({ id, label, basis })),
    llm: deps.llm.enabled,
    aiNotice: AI_NOTICE,
  };
}

function needLlm(deps: GrowthDeps): void {
  if (!deps.llm.enabled) throw new HttpError(400, NO_LLM);
}

async function route(deps: GrowthDeps, req: http.IncomingMessage, res: http.ServerResponse, method: string, url: URL, parts: string[]): Promise<boolean> {
  const { db } = deps;
  const [a, b, c, d] = parts;

  if (parts.length === 1 && a === 'meta' && method === 'GET') return sendJson(res, 200, meta(deps)), true;

  if (a === 'campaigns') {
    if (parts.length === 1) {
      if (method === 'GET') return sendJson(res, 200, { campaigns: listCampaigns(db) }), true;
      if (method === 'POST') {
        const body = await readJson(req);
        const id = createCampaign(db, body, body.platforms);
        return sendJson(res, 200, { campaign: getCampaign(db, id) }), true;
      }
      return false;
    }
    const id = idOf(b);
    if (parts.length === 2) {
      if (method === 'GET') return sendJson(res, 200, { campaign: getCampaign(db, id) }), true;
      if (method === 'PUT') return updateCampaign(db, id, await readJson(req)), sendJson(res, 200, { campaign: getCampaign(db, id) }), true;
      if (method === 'DELETE') return deleteCampaign(db, id), sendJson(res, 200, { ok: true }), true;
      return false;
    }
    if (parts.length === 3 && c === 'copies' && method === 'POST') {
      const body = await readJson(req);
      return sendJson(res, 200, { copy: addCopy(db, id, body.platform) }), true;
    }
    if (parts.length === 3 && c === 'export' && method === 'GET') {
      parseExportFormat(url.searchParams.get('format'));
      const out = exportCampaign(getCampaign(db, id));
      const body = Buffer.from(out.body);
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': contentDisposition(out.name, false),
        'cache-control': 'no-store',
        'content-length': body.length,
      });
      res.end(body);
      return true;
    }
    return false;
  }

  if (a !== 'copies' || b === undefined) return false;
  const id = idOf(b);
  if (parts.length === 2) {
    if (method === 'GET') return sendJson(res, 200, { copy: getCopy(db, id) }), true;
    if (method === 'PUT') {
      const body = await readJson(req, COPY_BYTES);
      return sendJson(res, 200, { copy: saveCopy(db, id, body.fields, body.baseRev) }), true;
    }
    if (method === 'DELETE') return deleteCopy(db, id), sendJson(res, 200, { ok: true }), true;
    return false;
  }
  if (c === 'revisions' && method === 'GET') {
    if (parts.length === 3) return sendJson(res, 200, { revisions: listRevisions(db, id) }), true;
    if (parts.length !== 4) return false;
    const n = /^\d+$/.test(d) ? Number(d) : NaN;
    if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, '版本号格式不对');
    return sendJson(res, 200, getRevision(db, id, n, url.searchParams.get('diff') === '1')), true;
  }
  if (parts.length !== 3 || method !== 'POST') return false;
  switch (c) {
    case 'generate':
      needLlm(deps);
      return sendJson(res, 200, { copy: await generateCopy(db, deps.llm, id) }), true;
    case 'review':
      needLlm(deps);
      return sendJson(res, 200, { copy: await reviewCopy(db, deps.llm, id) }), true;
    case 'replace': {
      const body = await readJson(req);
      return sendJson(res, 200, { copy: replaceHits(db, id, body.baseRev, body.items) }), true;
    }
    case 'keep': {
      const body = await readJson(req);
      return sendJson(res, 200, { copy: keepHit(db, id, body.key, body.reason) }), true;
    }
    case 'restore': {
      const body = await readJson(req);
      return sendJson(res, 200, { copy: restoreRevision(db, id, body.rev) }), true;
    }
    case 'finalize':
      return sendJson(res, 200, { copy: finalizeCopy(db, id) }), true;
    case 'unfinalize':
      return sendJson(res, 200, { copy: unfinalizeCopy(db, id) }), true;
  }
  return false;
}

export async function handleGrowthApi(deps: GrowthDeps, req: http.IncomingMessage, res: http.ServerResponse, method: string, url: URL): Promise<boolean> {
  const p = url.pathname;
  if (p !== '/api/growth' && !p.startsWith('/api/growth/')) return false;
  const parts = p.slice('/api/growth/'.length).split('/');
  try {
    if (await route(deps, req, res, method, url, parts)) return true;
  } catch (e) {
    if (e instanceof GrowthError) return sendJson(res, e.status, { error: e.message, ...(e.issues ? { issues: e.issues } : {}) }), true;
    throw e;
  }
  throw new HttpError(404, '接口不存在');
}
