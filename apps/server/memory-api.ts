// 记忆 API：画像、记忆条目、变更撤销、整理、导出、清空。调用方已完成登录与同源校验。
import type http from 'node:http';
import type { DB } from '../../packages/core/db.ts';
import type { MemoryKeeper } from '../../packs/memory/consolidate.ts';
import { pendingCount } from '../../packs/memory/events.ts';
import {
  MemoryError,
  addMemory,
  clearMemory,
  deleteMemory,
  exportMemory,
  getProfile,
  listMemories,
  recentChanges,
  setProfile,
  undoChange,
  updateMemory,
} from '../../packs/memory/store.ts';
import { HttpError, readJson, sendJson } from './http.ts';

export interface MemoryApiDeps {
  db: DB;
  keeper: MemoryKeeper;
  llmEnabled: boolean;
}

const BODY_MAX = 4 * 1024;
const PROFILE_BODY_MAX = 16 * 1024;

function idOf(s: string): number {
  const id = Number(s);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, '非法 id');
  return id;
}

/** 把记忆模块的业务错误映射为 HTTP 状态码 */
function call<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof MemoryError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');

/** 处理 /api/memory 下的接口；不是记忆接口时返回 false */
export async function handleMemoryApi(deps: MemoryApiDeps, req: http.IncomingMessage, res: http.ServerResponse, method: string, p: string): Promise<boolean> {
  if (p !== '/api/memory' && !p.startsWith('/api/memory/')) return false;
  const { db, keeper } = deps;

  if (p === '/api/memory' && method === 'GET') {
    sendJson(res, 200, {
      profile: getProfile(db),
      memories: listMemories(db),
      changes: recentChanges(db, 50),
      pending: pendingCount(db),
      running: keeper.running,
      llm: deps.llmEnabled,
    });
    return true;
  }
  if (p === '/api/memory' && method === 'DELETE') {
    const body = await readJson(req, BODY_MAX);
    call(() => clearMemory(db, body.confirm));
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (p === '/api/memory/profile' && method === 'PUT') {
    const body = await readJson(req, PROFILE_BODY_MAX);
    call(() => setProfile(db, body.content));
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (p === '/api/memory/items' && method === 'POST') {
    const body = await readJson(req, BODY_MAX);
    const id = call(() => addMemory(db, body.kind, body.content));
    sendJson(res, 201, { id });
    return true;
  }
  let m = p.match(/^\/api\/memory\/items\/(\d+)$/);
  if (m && method === 'PUT') {
    const id = idOf(m[1]);
    const body = await readJson(req, BODY_MAX);
    call(() => updateMemory(db, id, { kind: body.kind, content: body.content }));
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (m && method === 'DELETE') {
    const id = idOf(m[1]);
    call(() => deleteMemory(db, id));
    sendJson(res, 200, { ok: true });
    return true;
  }
  m = p.match(/^\/api\/memory\/changes\/(\d+)\/undo$/);
  if (m && method === 'POST') {
    const id = idOf(m[1]);
    call(() => undoChange(db, id));
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (p === '/api/memory/consolidate' && method === 'POST') {
    if (!deps.llmEnabled) throw new HttpError(400, '未配置 DEEPSEEK_API_KEY');
    if (!keeper.running && pendingCount(db) === 0) {
      sendJson(res, 200, { started: false });
      return true;
    }
    keeper.runNow().catch((e) => console.error('[memory] 整理出错', e));
    sendJson(res, 202, { started: true });
    return true;
  }
  if (p === '/api/memory/export' && method === 'GET') {
    const now = Date.now();
    const data = Buffer.from(JSON.stringify(exportMemory(db, now), null, 2));
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="opc-memory-${ymd(now)}.json"`,
      'cache-control': 'no-store',
      'content-length': data.length,
    });
    res.end(data);
    return true;
  }
  return false;
}
