// 合规材料接口：主体、产品资料、材料起草、逐章生成、编辑与版本、定稿、导出。由 compliance-api.ts 的 route 转交
import type http from 'node:http';
import { generateChapter } from '../../packs/compliance/docs-gen.ts';
import { exportDoc, parseFormat } from '../../packs/compliance/docs-export.ts';
import {
  createDoc, deleteDoc, deleteSection, docProductId, finalizeDoc, getDoc, getRevision, listDocs, listRevisions,
  prepareGenerate, restoreSection, saveSection, unfinalizeDoc, writeGenerated,
} from '../../packs/compliance/docs-store.ts';
import { getEntity, saveEntity, saveFacts } from '../../packs/compliance/facts.ts';
import { getProduct } from '../../packs/compliance/store.ts';
import { ExtractError } from '../../packs/pm/extract.ts';
import { NO_LLM, idOf, viaLlm, type ComplianceDeps } from './compliance-api.ts';
import { HttpError, contentDisposition, readJson, sendJson } from './http.ts';

const GEN_FAIL = '模型调用失败，请稍后重试';
const EMPTY = '模型没有返回内容';
/** 章正文最多 20000 字，按 UTF-8 最坏 4 字节加 JSON 转义留余量 */
const SECTION_BODY_BYTES = 256 * 1024;

const queryOf = (req: http.IncomingMessage) => new URL(req.url ?? '/', 'http://x').searchParams;

export async function routeDocs(deps: ComplianceDeps, req: http.IncomingMessage, res: http.ServerResponse, method: string, parts: string[]): Promise<boolean> {
  const { db } = deps;
  const [a, b, c, d, e] = parts;

  if (parts.length === 1 && a === 'entity') {
    if (method === 'GET') return sendJson(res, 200, { entity: getEntity(db) }), true;
    if (method === 'PUT') return sendJson(res, 200, { entity: saveEntity(db, await readJson(req)) }), true;
    return false;
  }

  if (a === 'products' && b !== undefined && parts.length === 3) {
    const pid = idOf(b);
    if (c === 'facts' && method === 'PUT') return sendJson(res, 200, { facts: saveFacts(db, pid, await readJson(req)) }), true;
    if (c === 'docs' && method === 'GET') return sendJson(res, 200, { docs: listDocs(db, pid) }), true;
    if (c === 'docs' && method === 'POST') {
      const body = await readJson(req);
      return sendJson(res, 200, { doc: createDoc(db, pid, body.kind) }), true;
    }
    return false;
  }

  if (a !== 'docs' || b === undefined) return false;
  const id = idOf(b);

  if (parts.length === 2) {
    if (method === 'GET') return sendJson(res, 200, { doc: getDoc(db, id) }), true;
    if (method === 'DELETE') return deleteDoc(db, id), sendJson(res, 200, { ok: true }), true;
    return false;
  }
  if (parts.length === 3 && method === 'POST' && c === 'finalize') return finalizeRoute(deps, res, id), true;
  if (parts.length === 3 && method === 'POST' && c === 'unfinalize') return sendJson(res, 200, { doc: unfinalizeDoc(db, id) }), true;
  if (parts.length === 3 && method === 'GET' && c === 'export') return await exportRoute(deps, req, res, id), true;

  if (c !== 'sections' || d === undefined) return false;
  const key = d;
  if (parts.length === 4) {
    if (method === 'PUT') {
      const body = await readJson(req, SECTION_BODY_BYTES);
      return sendJson(res, 200, { section: saveSection(db, id, key, body.body, body.baseRev) }), true;
    }
    if (method === 'DELETE') return deleteSection(db, id, key), sendJson(res, 200, { ok: true }), true;
    return false;
  }
  if (parts.length !== 5) return false;
  if (e === 'generate' && method === 'POST') return await generateRoute(deps, res, id, key), true;
  if (e === 'restore' && method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, { section: restoreSection(db, id, key, body.rev) }), true;
  }
  if (e === 'revisions' && method === 'GET') {
    const rev = queryOf(req).get('rev');
    if (rev === null) return sendJson(res, 200, { revisions: listRevisions(db, id, key) }), true;
    const n = /^\d+$/.test(rev) ? Number(rev) : NaN;
    if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, '版本号格式不对');
    return sendJson(res, 200, { revision: getRevision(db, id, key, n) }), true;
  }
  return false;
}

async function generateRoute(deps: ComplianceDeps, res: http.ServerResponse, id: number, key: string): Promise<void> {
  const g = prepareGenerate(deps.db, id, key);
  if (g.chapter.mode === 'fixed') {
    const section = writeGenerated(deps.db, id, key, g.chapter.render!(g.ctx), 'fixed', g.hash);
    return sendJson(res, 200, { section });
  }
  if (!deps.llm.enabled) throw new HttpError(400, NO_LLM);
  const gen = deps.generate ?? generateChapter;
  const body = await viaLlm(async () => {
    try {
      return await gen(deps.llm, { template: g.template, chapter: g.chapter, ctx: g.ctx, reasons: g.reasons });
    } catch (err) {
      if (err instanceof Error && err.message === EMPTY) throw new HttpError(502, EMPTY);
      throw err;
    }
  }, GEN_FAIL);
  // 等模型期间材料可能被定稿或删除：writeGenerated 在事务内重查，分别 409 / 404
  sendJson(res, 200, { section: writeGenerated(deps.db, id, key, body, 'generate', g.hash, Date.now(), g.doc.created_at) });
}

function finalizeRoute(deps: ComplianceDeps, res: http.ServerResponse, id: number): void {
  const doc = finalizeDoc(deps.db, id);
  try {
    const { product } = getProduct(deps.db, doc.product_id);
    deps.record?.({
      kind: 'compliance_doc_final',
      refType: 'product',
      refId: doc.product_id,
      summary: `定稿：${product.name} ${doc.name}`,
      payload: { kind: doc.kind },
    });
  } catch (err) {
    console.error('[compliance] 记录事件失败', err);
  }
  sendJson(res, 200, { doc });
}

async function exportRoute(deps: ComplianceDeps, req: http.IncomingMessage, res: http.ServerResponse, id: number): Promise<void> {
  const format = parseFormat(queryOf(req).get('format'));
  docProductId(deps.db, id);
  let out: Awaited<ReturnType<typeof exportDoc>>;
  try {
    out = await exportDoc(deps.db, id, format, deps.convert ? { convert: deps.convert } : {});
  } catch (err) {
    if (err instanceof ExtractError) throw new HttpError(err.status, err.message);
    throw err;
  }
  res.writeHead(200, {
    'content-type': out.type,
    'content-disposition': contentDisposition(out.name, false),
    'cache-control': 'no-store',
    'content-length': out.body.length,
  });
  res.end(out.body);
}
