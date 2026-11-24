// Wiki 分类树：左侧「领域 → 主题 → 页面」。节点不是页面（没有正文、没有出处），只有名称、层级、排序。
// 写函数不自己开事务，调用方用 tx() 包起来（与 store.ts 一致）
import type { DB } from '../../packages/core/db.ts';
import { fence } from '../memory/events.ts';
import { WIKI_LIMITS, WikiError } from './types.ts';
import type { PageKind } from './types.ts';

export interface TreeNode {
  id: number;
  parent_id: number | null;
  title: string;
  sort: number;
  manual: boolean;
  /** 直属的未删除页面数 */
  own: number;
  /** 含子孙的未删除页面数 */
  total: number;
}

const TITLE_ERR = `名称需在 1–${WIKI_LIMITS.nodeTitle} 字之间`;

/** NFKC、去控制与不可见格式字符、折叠空白、截断到 40 个字符；返回空串表示不合法 */
export function cleanNodeTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const t = raw
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const a = [...t];
  return a.length > WIKI_LIMITS.nodeTitle ? a.slice(0, WIKI_LIMITS.nodeTitle).join('').trim() : t;
}

/** 同级重名比较用：NFKC 后不区分大小写 */
const key = (s: string): string => s.normalize('NFKC').toLowerCase();

interface NodeRow {
  id: number;
  parent_id: number | null;
  title: string;
  sort: number;
  manual: number;
}

const allRows = (db: DB): NodeRow[] =>
  db.prepare('SELECT id, parent_id, title, sort, manual FROM wiki_nodes ORDER BY sort, id').all() as unknown as NodeRow[];

const nodeCount = (db: DB): number => Number((db.prepare('SELECT count(*) AS n FROM wiki_nodes').get() as { n: number }).n);

/** 节点的深度：顶层为 1 */
function depthOf(rows: Map<number, NodeRow>, id: number): number {
  let d = 0;
  for (let cur: number | null = id; cur != null && d < 50; cur = rows.get(cur)?.parent_id ?? null) d++;
  return d;
}

export function listNodes(db: DB): TreeNode[] {
  const rows = allRows(db);
  const own = new Map<number, number>();
  for (const r of db
    .prepare('SELECT pn.node_id AS id, count(*) AS n FROM wiki_page_node pn JOIN wiki_pages p ON p.id = pn.page_id WHERE p.deleted = 0 GROUP BY pn.node_id')
    .all() as unknown as { id: number; n: number }[]) {
    own.set(r.id, Number(r.n));
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const total = new Map<number, number>();
  for (const r of rows) {
    const n = own.get(r.id) ?? 0;
    if (!n) continue;
    for (let cur: number | null = r.id, g = 0; cur != null && g < 50; cur = byId.get(cur)?.parent_id ?? null, g++) total.set(cur, (total.get(cur) ?? 0) + n);
  }
  return rows.map((r) => ({
    id: r.id,
    parent_id: r.parent_id,
    title: r.title,
    sort: r.sort,
    manual: r.manual === 1,
    own: own.get(r.id) ?? 0,
    total: total.get(r.id) ?? 0,
  }));
}

export function pageNodes(db: DB): Map<number, { node_id: number; manual: boolean }> {
  const m = new Map<number, { node_id: number; manual: boolean }>();
  for (const r of db.prepare('SELECT page_id, node_id, manual FROM wiki_page_node').all() as unknown as { page_id: number; node_id: number; manual: number }[]) {
    m.set(r.page_id, { node_id: r.node_id, manual: r.manual === 1 });
  }
  return m;
}

function insertNode(db: DB, title: string, parentId: number | null, manual: boolean, now: number): number {
  const max = db.prepare('SELECT coalesce(max(sort), 0) AS s FROM wiki_nodes WHERE coalesce(parent_id, 0) = ?').get(parentId ?? 0) as { s: number };
  return Number(
    db
      .prepare('INSERT INTO wiki_nodes(parent_id, title, sort, manual, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(parentId, title, Number(max.s) + 1, manual ? 1 : 0, now).lastInsertRowid,
  );
}

/**
 * 逐层匹配同名节点，不存在才新建；超过 3 层截断。
 * budget.left 为本次最多还能新建几个；用完（或节点总数到 200）后返回已匹配到的最深一层，一层都没有返回 null
 */
export function ensurePath(db: DB, path: string[], o: { manual?: boolean; budget?: { left: number }; now?: number } = {}): number | null {
  const now = o.now ?? Date.now();
  const rows = allRows(db);
  let total = rows.length;
  let parent: number | null = null;
  let hit: number | null = null;
  const names = path.map(cleanNodeTitle).filter(Boolean).slice(0, WIKI_LIMITS.nodeDepth);
  for (const name of names) {
    const found = rows.find((r) => r.parent_id === parent && key(r.title) === key(name));
    if (found) {
      parent = hit = found.id;
      continue;
    }
    if (total >= WIKI_LIMITS.nodes || (o.budget && o.budget.left <= 0)) return hit;
    const id = insertNode(db, name, parent, !!o.manual, now);
    rows.push({ id, parent_id: parent, title: name, sort: 0, manual: o.manual ? 1 : 0 });
    total++;
    if (o.budget) o.budget.left--;
    parent = hit = id;
  }
  return hit;
}

/** nodeId 为 null 表示取消分类 */
export function placePage(db: DB, pageId: number, nodeId: number | null, o: { manual?: boolean } = {}): void {
  if (nodeId == null) {
    db.prepare('DELETE FROM wiki_page_node WHERE page_id = ?').run(pageId);
    return;
  }
  db.prepare(
    'INSERT INTO wiki_page_node(page_id, node_id, manual) VALUES (?, ?, ?) ON CONFLICT(page_id) DO UPDATE SET node_id = excluded.node_id, manual = excluded.manual',
  ).run(pageId, nodeId, o.manual ? 1 : 0);
}

function checkTitle(raw: unknown): string {
  const t = cleanNodeTitle(raw);
  if (!t) throw new WikiError(400, TITLE_ERR);
  return t;
}

export function createNode(db: DB, title: unknown, parentId: number | null, now: number = Date.now()): number {
  const t = checkTitle(title);
  const rows = allRows(db);
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (parentId != null) {
    if (!byId.has(parentId)) throw new WikiError(404, '节点不存在');
    if (depthOf(byId, parentId) >= WIKI_LIMITS.nodeDepth) throw new WikiError(400, `最多 ${WIKI_LIMITS.nodeDepth} 层`);
  }
  if (rows.some((r) => r.parent_id === parentId && key(r.title) === key(t))) throw new WikiError(409, '同级已有同名节点');
  if (rows.length >= WIKI_LIMITS.nodes) throw new WikiError(400, `最多 ${WIKI_LIMITS.nodes} 个节点`);
  return insertNode(db, t, parentId, true, now);
}

export function renameNode(db: DB, id: number, title: unknown): void {
  const rows = allRows(db);
  const me = rows.find((r) => r.id === id);
  if (!me) throw new WikiError(404, '节点不存在');
  const t = checkTitle(title);
  if (rows.some((r) => r.id !== id && r.parent_id === me.parent_id && key(r.title) === key(t))) throw new WikiError(409, '同级已有同名节点');
  db.prepare('UPDATE wiki_nodes SET title = ?, manual = 1 WHERE id = ?').run(t, id);
}

/** 只删空节点：没有子节点、没有未删除页面。只挂着已软删除页面的节点视为空，其归属行一并清掉 */
export function deleteNode(db: DB, id: number): void {
  if (!db.prepare('SELECT 1 FROM wiki_nodes WHERE id = ?').get(id)) throw new WikiError(404, '节点不存在');
  const kids = Number((db.prepare('SELECT count(*) AS n FROM wiki_nodes WHERE parent_id = ?').get(id) as { n: number }).n);
  const live = Number(
    (db.prepare('SELECT count(*) AS n FROM wiki_page_node pn JOIN wiki_pages p ON p.id = pn.page_id WHERE pn.node_id = ? AND p.deleted = 0').get(id) as { n: number }).n,
  );
  if (kids || live) throw new WikiError(409, '节点下还有内容');
  db.prepare('DELETE FROM wiki_page_node WHERE node_id = ?').run(id);
  db.prepare('DELETE FROM wiki_nodes WHERE id = ?').run(id);
}

/** 系统节点：取或建顶层节点（manual = 0）；节点总数到上限且不存在时返回 null */
export function systemNode(db: DB, title: '资料摘要' | '问答', now: number = Date.now()): number | null {
  const found = (db.prepare('SELECT id FROM wiki_nodes WHERE parent_id IS NULL AND title = ?').get(title) as { id: number } | undefined)?.id;
  if (found != null) return found;
  if (nodeCount(db) >= WIKI_LIMITS.nodes) return null;
  return insertNode(db, title, null, false, now);
}

// ---------------- 摄入时分类 ----------------

/**
 * 校验模型给的 path：必须是 1–3 个字符串，清洗后都非空、且不含 / 或 >（避免模型把整条路径塞进一个名字）。
 * 不合法返回 null（页面保持未分类）；超过 3 层截断到第 3 层
 */
export function cleanPath(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const out: string[] = [];
  for (const x of raw.slice(0, WIKI_LIMITS.nodeDepth)) {
    const t = cleanNodeTitle(x);
    if (!t || /[/>＞／]/.test(t)) return null;
    out.push(t);
  }
  return out;
}

/** 分类树的缩进文本（每层两个空格，节点名经 fence 转义），给规划提示词用；最多 200 行 */
export function renderTree(db: DB): string {
  const nodes = listNodes(db);
  if (!nodes.length) return '（还没有分类）';
  const kids = new Map<number | null, TreeNode[]>();
  for (const n of nodes) {
    const a = kids.get(n.parent_id) ?? [];
    a.push(n);
    kids.set(n.parent_id, a);
  }
  const lines: string[] = [];
  const walk = (parent: number | null, depth: number): void => {
    for (const n of kids.get(parent) ?? []) {
      if (lines.length >= WIKI_LIMITS.nodes) return;
      lines.push(`${'  '.repeat(depth)}- ${fence(n.title)}`);
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join('\n');
}

/**
 * 给本次摄入写入的页面落位（设计 §4.1）：已有归属的不动；source / answer 放系统节点；
 * 其余按 path 匹配或新建（一次摄入最多新建 5 个节点）；path 非法的保持未分类。
 * 单个页面出错只记入 failed，不影响其他页面
 */
export function placeIngested(
  db: DB,
  items: { slug: string; kind: PageKind; path: unknown }[],
  now: number,
): { placed: number; failed: string[] } {
  const have = pageNodes(db);
  const budget = { left: WIKI_LIMITS.ingestNewNodes };
  const failed: string[] = [];
  let placed = 0;
  for (const it of items) {
    // 每个页面一个 SAVEPOINT：这个页面落位失败时，连它刚建出来的节点一起回滚，不留空节点
    db.exec('SAVEPOINT place_one');
    const left = budget.left;
    try {
      const row = db.prepare('SELECT id FROM wiki_pages WHERE slug = ?').get(it.slug) as { id: number } | undefined;
      if (!row) {
        db.exec('RELEASE place_one');
        failed.push(it.slug);
        continue;
      }
      if (have.has(row.id)) {
        db.exec('RELEASE place_one');
        continue;
      }
      let node: number | null = null;
      if (it.kind === 'source') node = systemNode(db, '资料摘要', now);
      else if (it.kind === 'answer') node = systemNode(db, '问答', now);
      else {
        const path = cleanPath(it.path);
        if (path) node = ensurePath(db, path, { budget, now });
      }
      if (node != null) {
        placePage(db, row.id, node);
        placed++;
      }
      db.exec('RELEASE place_one');
    } catch {
      db.exec('ROLLBACK TO place_one');
      db.exec('RELEASE place_one');
      budget.left = left;
      failed.push(it.slug);
    }
  }
  return { placed, failed };
}
