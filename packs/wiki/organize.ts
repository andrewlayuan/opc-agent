// 整理目录结构：让模型给现有页面分类，整体提交、可用快照撤销（设计 §4.3）。
// 单独成文件：要用 ingest.ts 的 Calls，而 ingest.ts 又依赖 tree.ts，放进 tree.ts 会循环依赖
import type { DB } from '../../packages/core/db.ts';
import type { Llm } from '../../packages/core/llm.ts';
import { Calls } from './ingest.ts';
import { organizePrompt } from './prompts.ts';
import { createOp, finishOp, getOp, tx } from './store.ts';
import { VirtualTree, cleanPath, listNodes, pageNodes, placePage } from './tree.ts';
import { WIKI_LIMITS, WikiError } from './types.ts';

interface Snapshot {
  nodes: { id: number; parent_id: number | null; title: string; sort: number; manual: number; created_at: number }[];
  pages: { page_id: number; node_id: number; manual: number }[];
}

const takeSnapshot = (db: DB): Snapshot => ({
  nodes: db.prepare('SELECT id, parent_id, title, sort, manual, created_at FROM wiki_nodes ORDER BY id').all() as unknown as Snapshot['nodes'],
  pages: db.prepare('SELECT page_id, node_id, manual FROM wiki_page_node ORDER BY page_id').all() as unknown as Snapshot['pages'],
});

/** 删除没有页面也没有子节点的自动节点（manual 节点保留）；从下往上直到没有可删的 */
function pruneEmpty(db: DB): void {
  for (let again = true; again; ) {
    again = false;
    for (const n of listNodes(db)) {
      if (n.manual) continue;
      const kids = Number((db.prepare('SELECT count(*) AS c FROM wiki_nodes WHERE parent_id = ?').get(n.id) as { c: number }).c);
      const live = Number((db.prepare('SELECT count(*) AS c FROM wiki_page_node WHERE node_id = ?').get(n.id) as { c: number }).c);
      if (!kids && !live) {
        db.prepare('DELETE FROM wiki_nodes WHERE id = ?').run(n.id);
        again = true;
      }
    }
  }
}

/** 已固定页面只作上下文，最多给模型看这么多条，避免页面很多时提示词过大 */
const FIXED_CONTEXT_MAX = 200;

/**
 * 给没有手动放置的页面分类（source / answer 页不参与）。
 * 模型调用期间不碰数据库：每批的结果合并进内存里的虚拟树，下一批据此看到已形成的树；
 * 全部批次都成功后，在一个 tx() 里一次性写入。这样：
 * - 数据库事务不会跨 await 打开（否则别的请求的 BEGIN 会报错，失败回滚还会带走别人的写入）；
 * - 任何一批失败都只需抛错，分类与快照都没有改动；
 * - 提交时重新读取 manual 状态，模型调用期间用户的手动调整不会被覆盖。
 */
export async function organize(db: DB, llm: Llm, opId: number, o: { now?: number } = {}): Promise<{ llmCalls: number; note: string }> {
  const now = o.now ?? Date.now();
  const calls = new Calls(llm);
  const pages = db
    .prepare("SELECT id, slug, kind, title, summary FROM wiki_pages WHERE deleted = 0 AND kind NOT IN ('source', 'answer', 'trend') ORDER BY slug")
    .all() as unknown as { id: number; slug: string; kind: string; title: string; summary: string }[];
  const have = pageNodes(db);
  const todo = pages.filter((p) => !have.get(p.id)?.manual);
  const fixed = pages.filter((p) => have.get(p.id)?.manual);
  if (!todo.length) {
    const note = '没有需要整理的页面';
    finishOp(db, opId, { status: 'done', llmCalls: 0, note, now });
    return { llmCalls: 0, note };
  }

  const tree = new VirtualTree(db);
  const seen = new Set<string>();
  const decided: { slug: string; path: string[] }[] = [];
  const batches = Math.min(Math.ceil(todo.length / WIKI_LIMITS.organizeBatch), WIKI_LIMITS.organizeCalls);
  for (let i = 0; i < batches; i++) {
    const slice = todo.slice(i * WIKI_LIMITS.organizeBatch, (i + 1) * WIKI_LIMITS.organizeBatch);
    const inSlice = new Set(slice.map((p) => p.slug));
    const fixedText = fixed.slice(0, FIXED_CONTEXT_MAX).map((p) => `${p.slug} → ${tree.pathOf(have.get(p.id)!.node_id)}`).join('\n');
    const out = await calls.json<{ nodes?: unknown }>(organizePrompt(slice, tree.render(), fixedText), 8000);
    if (!Array.isArray(out.nodes)) throw new WikiError(502, '模型没有给出分类');
    for (const item of out.nodes as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const e = item as { path?: unknown; pages?: unknown };
      const path = cleanPath(e.path);
      if (!path || !Array.isArray(e.pages)) continue;
      const slugs = (e.pages as unknown[]).filter((x): x is string => typeof x === 'string' && inSlice.has(x) && !seen.has(x));
      if (!slugs.length || tree.ensure(path) == null) continue;
      for (const slug of slugs) {
        seen.add(slug);
        decided.push({ slug, path });
      }
    }
  }

  return tx(db, () => {
    const idsBefore = new Set(listNodes(db).map((n) => n.id));
    const snapshot = takeSnapshot(db);
    // 模型调用期间用户可能手动调整过：提交时以当前的 manual 与页面状态为准
    const nowHave = pageNodes(db);
    const byslug = new Map(
      (db.prepare("SELECT id, slug FROM wiki_pages WHERE deleted = 0 AND kind NOT IN ('source', 'answer', 'trend')").all() as unknown as { id: number; slug: string }[]).map((r) => [r.slug, r.id]),
    );
    let placed = 0;
    for (const d of decided) {
      const id = byslug.get(d.slug);
      if (id == null || nowHave.get(id)?.manual) continue;
      const node = VirtualTree.commit(db, d.path, now);
      if (node == null) continue;
      placePage(db, id, node);
      placed++;
    }
    pruneEmpty(db);
    const created = listNodes(db).filter((n) => !idsBefore.has(n.id)).length;
    const note = `整理 ${placed} 个页面，新建 ${created} 个节点`;
    db.prepare('INSERT INTO wiki_node_undo(op_id, snapshot) VALUES (?, ?)').run(opId, JSON.stringify(snapshot));
    finishOp(db, opId, { status: 'done', llmCalls: calls.n, note, now });
    return { llmCalls: calls.n, note };
  });
}

/** 恢复整理前的快照：整体替换整棵树与分类。整理之后手动做的调整会随之丢失（界面撤销前会确认） */
export function revertOrganize(db: DB, opId: number, o: { now?: number } = {}): { revertOp: number } {
  const op = getOp(db, opId);
  if (!op) throw new WikiError(404, '操作不存在');
  const row = db.prepare('SELECT snapshot FROM wiki_node_undo WHERE op_id = ?').get(opId) as { snapshot: string } | undefined;
  if (op.kind !== 'organize' || op.status !== 'done' || !row) throw new WikiError(400, '该操作不能撤销');
  const snap = JSON.parse(row.snapshot) as Snapshot;
  const now = o.now ?? Date.now();
  return tx(db, () => {
    db.exec('DELETE FROM wiki_page_node; DELETE FROM wiki_nodes;');
    const insNode = db.prepare('INSERT INTO wiki_nodes(id, parent_id, title, sort, manual, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    // 快照按 id 升序，父节点总是先于子节点建出来
    for (const n of snap.nodes) insNode.run(n.id, n.parent_id, n.title, n.sort, n.manual, n.created_at);
    const alive = db.prepare('SELECT 1 FROM wiki_pages WHERE id = ?');
    const insPage = db.prepare('INSERT INTO wiki_page_node(page_id, node_id, manual) VALUES (?, ?, ?)');
    for (const p of snap.pages) if (alive.get(p.page_id)) insPage.run(p.page_id, p.node_id, p.manual);
    const rid = createOp(db, 'revert', { status: 'running', targetOp: opId, now });
    finishOp(db, rid, { status: 'done', note: `撤销整理 #${opId}`, now });
    db.prepare("UPDATE wiki_ops SET status = 'reverted' WHERE id = ?").run(opId);
    return { revertOp: rid };
  });
}
