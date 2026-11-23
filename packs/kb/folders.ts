// 知识库目录树：名称校验、层级与数量上限、移动防环、只删空目录
import type { DB } from '../../packages/core/db.ts';
import { tx } from '../memory/store.ts';
import { KB_LIMITS, KbError, clipCp, len } from './types.ts';

export interface Folder {
  id: number;
  parent_id: number | null;
  name: string;
  sort: number;
  count: number;
}

const BAD_NAME = '目录名需为 1–40 字，且不能包含 / \\ 或控制字符';
const NOT_FOUND = '目录不存在';
export const UNFILED = '未归类';

export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') throw new KbError(400, BAD_NAME);
  const n = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!n || len(n) > KB_LIMITS.folderName || /[/\\\u0000-\u001f\u007f]/.test(n)) throw new KbError(400, BAD_NAME);
  return n;
}

function uniq<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Error && /UNIQUE/.test(e.message)) throw new KbError(400, '同一层级已有同名目录');
    throw e;
  }
}

type Row = { id: number; parent_id: number | null; name: string; sort: number };

function rows(db: DB): Map<number, Row> {
  const all = db.prepare('SELECT id, parent_id, name, sort FROM kb_folders').all() as Row[];
  return new Map(all.map((r) => [Number(r.id), { ...r, id: Number(r.id), parent_id: r.parent_id == null ? null : Number(r.parent_id) }]));
}

/** 目录深度（顶层为 1） */
function depthOf(map: Map<number, Row>, id: number): number {
  let d = 0;
  for (let cur: number | null = id; cur != null && d <= 100; cur = map.get(cur)?.parent_id ?? null) d++;
  return d;
}

/** 以 id 为根的子树高度（只有自己为 1） */
function heightOf(map: Map<number, Row>, id: number): number {
  let h = 1;
  for (const r of map.values()) if (r.parent_id === id) h = Math.max(h, 1 + heightOf(map, r.id));
  return h;
}

export function assertFolder(db: DB, id: number | null): void {
  if (id == null) return;
  if (!db.prepare('SELECT 1 FROM kb_folders WHERE id = ?').get(id)) throw new KbError(404, NOT_FOUND);
}

export function listFolders(db: DB): { folders: Folder[]; unfiled: number; total: number } {
  const folders = (
    db
      .prepare(
        `SELECT f.id, f.parent_id, f.name, f.sort, (SELECT count(*) FROM kb_docs d WHERE d.folder_id = f.id) AS count
         FROM kb_folders f ORDER BY f.sort, f.name, f.id`,
      )
      .all() as unknown as Folder[]
  ).map((f) => ({ id: Number(f.id), parent_id: f.parent_id == null ? null : Number(f.parent_id), name: f.name, sort: Number(f.sort), count: Number(f.count) }));
  const c = db.prepare('SELECT count(*) AS total, sum(folder_id IS NULL) AS unfiled FROM kb_docs').get() as { total: number; unfiled: number | null };
  return { folders, unfiled: Number(c.unfiled ?? 0), total: Number(c.total) };
}

export function createFolder(db: DB, name: unknown, parentId: number | null, now: number = Date.now()): number {
  const n = cleanName(name);
  assertFolder(db, parentId);
  const map = rows(db);
  if (map.size >= KB_LIMITS.folders) throw new KbError(400, `目录最多 ${KB_LIMITS.folders} 个`);
  if (parentId != null && depthOf(map, parentId) + 1 > KB_LIMITS.depth) throw new KbError(400, `目录最多 ${KB_LIMITS.depth} 层`);
  return uniq(() => Number(db.prepare('INSERT INTO kb_folders(parent_id, name, created_at) VALUES (?, ?, ?)').run(parentId, n, now).lastInsertRowid));
}

export function updateFolder(db: DB, id: number, patch: { name?: unknown; parentId?: number | null; sort?: number }): void {
  assertFolder(db, id);
  if (patch.name !== undefined) {
    const n = cleanName(patch.name);
    uniq(() => db.prepare('UPDATE kb_folders SET name = ? WHERE id = ?').run(n, id));
  }
  if (patch.parentId !== undefined) {
    const to = patch.parentId;
    assertFolder(db, to);
    const map = rows(db);
    for (let cur: number | null = to; cur != null; cur = map.get(cur)?.parent_id ?? null) {
      if (cur === id) throw new KbError(400, '不能移动到自身或其子目录下');
    }
    const base = to == null ? 0 : depthOf(map, to);
    if (base + heightOf(map, id) > KB_LIMITS.depth) throw new KbError(400, `目录最多 ${KB_LIMITS.depth} 层`);
    uniq(() => db.prepare('UPDATE kb_folders SET parent_id = ? WHERE id = ?').run(to, id));
  }
  if (patch.sort !== undefined) {
    if (!Number.isSafeInteger(patch.sort)) throw new KbError(400, '排序值不合法');
    db.prepare('UPDATE kb_folders SET sort = ? WHERE id = ?').run(patch.sort, id);
  }
}

export function deleteFolder(db: DB, id: number): void {
  assertFolder(db, id);
  const busy = db.prepare('SELECT EXISTS(SELECT 1 FROM kb_folders WHERE parent_id = ?) OR EXISTS(SELECT 1 FROM kb_docs WHERE folder_id = ?) AS b').get(id, id) as { b: number };
  if (busy.b) throw new KbError(409, '目录不为空');
  db.prepare('DELETE FROM kb_folders WHERE id = ?').run(id);
}

export function folderPath(db: DB, id: number | null): string {
  if (id == null) return UNFILED;
  const map = rows(db);
  const parts: string[] = [];
  for (let cur: number | null = id; cur != null && parts.length <= KB_LIMITS.depth; cur = map.get(cur)?.parent_id ?? null) {
    const r = map.get(cur);
    if (!r) break;
    parts.unshift(r.name);
  }
  return parts.join('/');
}

/** 所有目录的完整路径，按路径排序 */
export function folderPaths(db: DB): { id: number; path: string }[] {
  const map = rows(db);
  const pathOf = (id: number): string => {
    const parts: string[] = [];
    for (let cur: number | null = id; cur != null && parts.length <= KB_LIMITS.depth; cur = map.get(cur)?.parent_id ?? null) parts.unshift(map.get(cur)!.name);
    return parts.join('/');
  };
  return [...map.keys()].map((id) => ({ id, path: pathOf(id) })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 批量导入用的目录段清洗：控制字符与反斜杠换成空格、合并空白、去首尾空白、截到 40 字；. 与 .. 视为空 */
function cleanSeg(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const n = clipCp(raw.replace(/[\u0000-\u001f\u007f\\]/g, ' ').replace(/\s+/g, ' ').trim(), KB_LIMITS.folderName).trim();
  return n === '.' || n === '..' ? '' : n;
}

/**
 * 按相对路径（/ 分隔）在 parentId 下逐层建目录，同名复用；返回 路径 → 目录 id（'' 与全空段映射到 parentId）。
 * 超过 5 层的段不再建，放在第 5 层；目录总数到 200 时停止新建，之后的路径放在已有的最深一层（capped=true）。
 * 一个事务内完成，任何错误整批回滚
 */
export function ensureFolders(db: DB, parentId: number | null, paths: string[], now: number = Date.now()): { map: Record<string, number | null>; capped: boolean } {
  return tx(db, () => {
    assertFolder(db, parentId);
    const all = rows(db);
    const child = new Map<string, number>();
    for (const r of all.values()) child.set(`${r.parent_id ?? 0}/${r.name}`, r.id);
    let total = all.size;
    const base = parentId == null ? 0 : depthOf(all, parentId);
    const ins = db.prepare('INSERT INTO kb_folders(parent_id, name, created_at) VALUES (?, ?, ?)');
    const map: Record<string, number | null> = {};
    let capped = false;
    for (const p of paths) {
      if (typeof p !== 'string') throw new KbError(400, '路径不合法');
      if (p in map) continue;
      let cur = parentId;
      let depth = base;
      for (const seg of p.split('/').map(cleanSeg).filter(Boolean)) {
        if (depth >= KB_LIMITS.depth) break;
        const name = cleanName(seg);
        const key = `${cur ?? 0}/${name}`;
        let id = child.get(key);
        if (id == null) {
          if (total >= KB_LIMITS.folders) {
            capped = true;
            break;
          }
          id = Number(ins.run(cur, name, now).lastInsertRowid);
          child.set(key, id);
          total++;
        }
        cur = id;
        depth++;
      }
      map[p] = cur;
    }
    return { map, capped };
  });
}
