// 记忆 API：画像（含版本）、记忆条目、技能、变更撤销、整理与沉淀、导出、清空。调用方已完成登录与同源校验。
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { DB } from '../../packages/core/db.ts';
import type { MemoryKeeper } from '../../packs/memory/consolidate.ts';
import { recentRuns } from '../../packs/memory/crystallize.ts';
import type { SkillKeeper } from '../../packs/memory/crystallize.ts';
import { pendingCount } from '../../packs/memory/events.ts';
import { listProfileVersions, restoreProfile } from '../../packs/memory/profile-versions.ts';
import { lineDiff } from '../../packs/wiki/diff.ts';
import {
  acceptPending,
  createSkill,
  deleteSkill,
  getSkill,
  listSkillRevisions,
  listSkills,
  restoreSkill,
  setPending,
  setSkillStatus,
  skillText,
  updateSkill,
} from '../../packs/memory/skills.ts';
import { ZipWriter } from '../../packs/wiki/zip.ts';
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
import { HttpError, contentDisposition, readJson, sendJson } from './http.ts';

export interface MemoryApiDeps {
  db: DB;
  keeper: MemoryKeeper;
  skills: SkillKeeper;
  llmEnabled: boolean;
}

const BODY_MAX = 4 * 1024;
const PROFILE_BODY_MAX = 16 * 1024;
const SKILL_BODY_MAX = 32 * 1024;
const S = '/api/memory/skills';

function skillSummary(db: DB): { total: number; active: number; candidate: number; retired: number; pending: number } {
  const all = listSkills(db);
  const n = (st: string) => all.filter((s) => s.status === st).length;
  return { total: all.length, active: n('active'), candidate: n('candidate'), retired: n('retired'), pending: all.filter((s) => s.pending).length };
}

const skillInput = (b: Record<string, unknown>) => ({ name: b.name, scene: b.scene, steps: b.steps, cautions: b.cautions, example: b.example ?? '' });

/** 打包导出：memories.json（同 JSON 导出）、skills.json（含版本）、profile.md、profile-versions.json */
function sendZip(db: DB, res: http.ServerResponse, now: number): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-memexp-'));
  let data: Buffer;
  try {
    const file = path.join(dir, 'out.zip');
    const z = new ZipWriter(file);
    const json = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2));
    z.add('memories.json', json(exportMemory(db, now)));
    z.add('skills.json', json(listSkills(db).map((s) => ({ ...s, revisions: listSkillRevisions(db, s.id) }))));
    const profile = getProfile(db).content.trim();
    z.add('profile.md', Buffer.from(profile ? `${profile}\n` : ''));
    z.add('profile-versions.json', json(listProfileVersions(db)));
    z.close();
    data = fs.readFileSync(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': contentDisposition(`opc-memory-${ymd(now)}.zip`, false),
    'cache-control': 'no-store',
    'content-length': data.length,
  });
  res.end(data);
}

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
  const { db, keeper, skills } = deps;

  if (p === '/api/memory' && method === 'GET') {
    sendJson(res, 200, {
      profile: getProfile(db),
      memories: listMemories(db),
      changes: recentChanges(db, 50),
      pending: pendingCount(db),
      running: keeper.running,
      llm: deps.llmEnabled,
      skills: skillSummary(db),
      profileVersions: (db.prepare('SELECT COUNT(*) AS n FROM profile_versions').get() as { n: number }).n,
      skillsEnabled: skills.enabled,
      skillsBlocker: skills.blocker,
      crystallizing: skills.running,
    });
    return true;
  }
  if (p === '/api/memory/profile/versions' && method === 'GET') {
    sendJson(res, 200, { versions: listProfileVersions(db) });
    return true;
  }
  let m = p.match(/^\/api\/memory\/profile\/versions\/(\d+)\/diff$/);
  if (m && method === 'GET') {
    const rev = idOf(m[1]);
    const v = listProfileVersions(db).find((x) => x.rev === rev);
    if (!v) throw new HttpError(404, '版本不存在');
    sendJson(res, 200, { diff: lineDiff(v.content, getProfile(db).content) });
    return true;
  }
  m = p.match(/^\/api\/memory\/skills\/(\d+)\/revisions\/(\d+)\/diff$/);
  if (m && method === 'GET') {
    const id = idOf(m[1]);
    const rev = idOf(m[2]);
    const cur = call(() => getSkill(db, id));
    const v = call(() => listSkillRevisions(db, id)).find((x) => x.rev === rev);
    if (!v) throw new HttpError(404, '版本不存在');
    sendJson(res, 200, { diff: lineDiff(skillText(v.skill), skillText(cur)) });
    return true;
  }
  m = p.match(/^\/api\/memory\/skills\/(\d+)\/pending\/diff$/);
  if (m && method === 'GET') {
    const id = idOf(m[1]);
    const cur = call(() => getSkill(db, id));
    if (!cur.pending) throw new HttpError(404, '没有待采用的新版本');
    sendJson(res, 200, { diff: lineDiff(skillText(cur), skillText(cur.pending)) });
    return true;
  }
  if (p === '/api/memory/profile/restore' && method === 'POST') {
    const body = await readJson(req, BODY_MAX);
    sendJson(res, 200, call(() => restoreProfile(db, body.rev)));
    return true;
  }
  if (p === S && method === 'GET') {
    sendJson(res, 200, { skills: listSkills(db), runs: recentRuns(db, 5), enabled: skills.enabled, blocker: skills.blocker, running: skills.running, last: skills.last });
    return true;
  }
  if (p === S && method === 'POST') {
    const body = await readJson(req, SKILL_BODY_MAX);
    const id = call(() => createSkill(db, skillInput(body), { source: 'manual' }));
    sendJson(res, 201, { id });
    return true;
  }
  if (p === `${S}/crystallize` && method === 'POST') {
    if (!skills.running) {
      const why = skills.check();
      if (why) throw new HttpError(409, why);
    }
    skills.runNow().catch((e) => console.error('[skills] 沉淀出错', e));
    sendJson(res, 202, { started: true });
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
  m = p.match(/^\/api\/memory\/items\/(\d+)$/);
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
  m = p.match(/^\/api\/memory\/skills\/(\d+)(?:\/(status|revisions|restore|accept|pending))?$/);
  if (m) {
    const id = idOf(m[1]);
    const act = m[2] ?? '';
    if (act === '' && method === 'PUT') {
      const body = await readJson(req, SKILL_BODY_MAX);
      sendJson(res, 200, { skill: call(() => updateSkill(db, id, skillInput(body), { origin: 'manual' })) });
      return true;
    }
    if (act === '' && method === 'DELETE') {
      call(() => deleteSkill(db, id));
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (act === 'status' && method === 'POST') {
      const body = await readJson(req, BODY_MAX);
      sendJson(res, 200, { skill: call(() => setSkillStatus(db, id, body.status)) });
      return true;
    }
    if (act === 'revisions' && method === 'GET') {
      sendJson(res, 200, { revisions: call(() => listSkillRevisions(db, id)) });
      return true;
    }
    if (act === 'restore' && method === 'POST') {
      const body = await readJson(req, BODY_MAX);
      sendJson(res, 200, { skill: call(() => restoreSkill(db, id, body.rev)) });
      return true;
    }
    if (act === 'accept' && method === 'POST') {
      sendJson(res, 200, { skill: call(() => acceptPending(db, id)) });
      return true;
    }
    if (act === 'pending' && method === 'DELETE') {
      call(() => setPending(db, id, null));
      sendJson(res, 200, { ok: true });
      return true;
    }
    return false;
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
    const format = new URL(req.url ?? '/', 'http://x').searchParams.get('format') ?? 'json';
    if (format !== 'json' && format !== 'zip') throw new HttpError(400, '导出格式只能是 json 或 zip');
    if (format === 'zip') {
      sendZip(db, res, now);
      return true;
    }
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
