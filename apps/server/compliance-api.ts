// 合规 API：问卷与目录、产品、判定、台账、提醒、AI 预填与解释。调用方已完成登录与同源校验
import type http from 'node:http';
import type { DB } from '../../packages/core/db.ts';
import { LlmError } from '../../packages/core/llm.ts';
import type { Llm } from '../../packages/core/llm.ts';
import type { EventInput } from '../../packs/memory/events.ts';
import { listReminders } from '../../packs/compliance/reminders.ts';
import { CATALOG, QUESTIONS, RULES_VERSION, validateAnswers, type Answers } from '../../packs/compliance/rules.ts';
import { CpError, assessAndMerge, createProduct, deleteProduct, getItem, getProduct, listProducts, saveExplain, updateItem, updateProduct } from '../../packs/compliance/store.ts';
import type { ItemPatch } from '../../packs/compliance/store.ts';
import { HttpError, readJson, sendJson } from './http.ts';

export const NOTICE = '结果为自查参考，以属地主管部门口径为准。';

export type PrefillFn = (llm: Llm, product: { name: string; description: string }) => Promise<{ answers: Answers; basis: Record<string, string> }>;
export type ExplainFn = (llm: Llm, input: { item: string; reasons: string[]; product: { name: string; description: string } }) => Promise<string>;

export interface ComplianceDeps {
  db: DB;
  llm: Llm;
  record?: (e: EventInput) => void;
  prefill?: PrefillFn;
  explain?: ExplainFn;
}

const QIDS = new Set(QUESTIONS.map((q) => q.id));
const NAME = new Map(CATALOG.map((c) => [c.id, c.name]));

function idOf(s: string): number {
  const id = Number(s);
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, '非法 id');
  return id;
}

function meta() {
  return {
    version: RULES_VERSION,
    questions: QUESTIONS.map((q) => ({ id: q.id, title: q.title, multi: q.multi, options: q.options, ...(q.exclusive ? { exclusive: q.exclusive } : {}), ...(q.dependsOn ? { dependsOn: q.dependsOn } : {}) })),
    catalog: CATALOG,
    notice: NOTICE,
  };
}

function reviewIdOf(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new HttpError(400, 'reviewId 格式不对');
  return v;
}

async function route(deps: ComplianceDeps, req: http.IncomingMessage, res: http.ServerResponse, method: string, parts: string[]): Promise<boolean> {
  const { db } = deps;
  const [a, b, c] = parts;
  if (parts.length === 1 && a === 'meta' && method === 'GET') return sendJson(res, 200, meta()), true;
  if (parts.length === 1 && a === 'reminders' && method === 'GET') return sendJson(res, 200, { reminders: listReminders(db) }), true;
  if (parts.length === 1 && a === 'products') {
    if (method === 'GET') return sendJson(res, 200, { products: listProducts(db) }), true;
    if (method === 'POST') {
      const body = await readJson(req);
      const id = createProduct(db, { name: body.name, description: body.description }, reviewIdOf(body.reviewId));
      return sendJson(res, 200, getProduct(db, id)), true;
    }
    return false;
  }
  if (a === 'products' && b !== undefined) {
    const id = idOf(b);
    if (parts.length === 2) {
      if (method === 'GET') return sendJson(res, 200, getProduct(db, id)), true;
      if (method === 'PATCH') {
        const body = await readJson(req);
        updateProduct(db, id, { name: body.name, description: body.description });
        return sendJson(res, 200, getProduct(db, id)), true;
      }
      if (method === 'DELETE') return deleteProduct(db, id), sendJson(res, 200, { ok: true }), true;
      return false;
    }
    if (parts.length === 3 && c === 'assess' && method === 'POST') return await assessRoute(deps, req, res, id), true;
    if (parts.length === 3 && c === 'prefill' && method === 'POST') return await prefillRoute(deps, res, id), true;
    return false;
  }
  if (a === 'items' && b !== undefined) {
    const id = idOf(b);
    if (parts.length === 2 && method === 'PATCH') {
      const body = await readJson(req);
      return sendJson(res, 200, { item: updateItem(db, id, body as ItemPatch) }), true;
    }
    if (parts.length === 3 && c === 'explain' && method === 'POST') return await explainRoute(deps, res, id), true;
  }
  return false;
}

async function assessRoute(deps: ComplianceDeps, req: http.IncomingMessage, res: http.ServerResponse, id: number): Promise<void> {
  const body = await readJson(req);
  if (body.version !== RULES_VERSION) throw new CpError(409, '问卷已更新，请刷新');
  const v = validateAnswers(body.answers);
  if (!v.ok) throw new CpError(400, '问卷未答完或有非法选项', { missing: v.missing, invalid: v.invalid });
  const prefilled = Array.isArray(body.prefilled) ? [...new Set(body.prefilled.filter((x): x is string => typeof x === 'string' && QIDS.has(x)))] : [];
  const { result } = assessAndMerge(deps.db, id, v.answers, prefilled);
  const detail = getProduct(deps.db, id);
  try {
    deps.record?.({
      kind: 'compliance_assess',
      refType: 'product',
      refId: id,
      summary: `合规自查：${detail.product.name}`,
      payload: { required: result.items.filter((x) => x.level === 'required').map((x) => NAME.get(x.id) ?? x.id) },
    });
  } catch (err) {
    console.error('[compliance] 记录事件失败', err);
  }
  sendJson(res, 200, detail);
}

async function prefillRoute(deps: ComplianceDeps, res: http.ServerResponse, id: number): Promise<void> {
  if (!deps.prefill) throw new HttpError(501, '尚未开放');
  const { product } = getProduct(deps.db, id);
  if (!deps.llm.enabled) throw new HttpError(400, '未配置模型');
  const out = await deps.prefill(deps.llm, { name: product.name, description: product.description });
  sendJson(res, 200, out);
}

async function explainRoute(deps: ComplianceDeps, res: http.ServerResponse, id: number): Promise<void> {
  if (!deps.explain) throw new HttpError(501, '尚未开放');
  const it = getItem(deps.db, id);
  if (!it) throw new CpError(404, '事项不存在');
  if (it.level !== 'maybe') throw new CpError(400, '只有「可能需要」的事项可以生成说明');
  if (!deps.llm.enabled) throw new HttpError(400, '未配置模型');
  const { product, assessment } = getProduct(deps.db, it.product_id);
  const reasons = assessment?.result.items.find((x) => x.id === it.item)?.reasons ?? [];
  const text = await deps.explain(deps.llm, { item: it.item, reasons, product: { name: product.name, description: product.description } });
  saveExplain(deps.db, id, text);
  sendJson(res, 200, { item: getItem(deps.db, id) });
}

/** 处理 /api/compliance 下的接口；不是合规接口时返回 false。CpError 映射为对应状态码（detail 并入响应体），模型错误为 502 */
export async function handleComplianceApi(deps: ComplianceDeps, req: http.IncomingMessage, res: http.ServerResponse, method: string, url: URL): Promise<boolean> {
  const p = url.pathname;
  if (p !== '/api/compliance' && !p.startsWith('/api/compliance/')) return false;
  const parts = p.slice('/api/compliance/'.length).split('/');
  try {
    if (await route(deps, req, res, method, parts)) return true;
  } catch (e) {
    if (e instanceof CpError) return sendJson(res, e.status, { error: e.message, ...e.detail }), true;
    if (e instanceof LlmError) throw new HttpError(502, e.message);
    throw e;
  }
  throw new HttpError(404, '接口不存在');
}
