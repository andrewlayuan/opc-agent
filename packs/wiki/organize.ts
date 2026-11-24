// 整理目录结构：让模型给现有页面分类，整体提交、可用快照撤销（设计 §4.3）。
// 单独成文件：要用 ingest.ts 的 Calls，而 ingest.ts 又依赖 tree.ts，放进 tree.ts 会循环依赖
import type { DB } from '../../packages/core/db.ts';
import type { Llm } from '../../packages/core/llm.ts';
import { Calls } from './ingest.ts';
import { organizePrompt } from './prompts.ts';
import { createOp, finishOp, getOp, tx } from './store.ts';
import { cleanPath, ensurePath, listNodes, pageNodes, placePage, renderTree } from './tree.ts';
import { WIKI_LIMITS, WikiError } from './types.ts';

interface Snapshot {
  nodes: { id: number; parent_id: number | null; title: string; sort: number; manual: number; created_at: number }[];
  pages: { page_id: number; node_id: number; manual: number }[];
}

const takeSnapshot = (db: DB): Snapshot => ({
  nodes: db.prepare('SELECT id, parent_id, title, sort, manual, created_at FROM wiki_nodes ORDER BY id').all() as unknown as Snapshot['nodes'],
  pages: db.prepare('SELECT page_id, node_id, manual FROM wiki_page_node ORDER BY page_id').all() as unknown as Snapshot['pages'],
});

function pathText(nodes: Map<number, { parent_id: number | null; title: string }>, id: number): string {
  const out: string[] = [];
  for (let cur: number | null = id, g = 0; cur != null && g < 10; cur = nodes.get(cur)?.parent_id ?? null, g++) out.unshift(nodes.get(cur)?.title ?? '?');
  return out.join(' / ');
}

/**
 * 给没有手动放置的页面分类（source / answer 页不参与）。
 * 每批的结果先写进真实表，下一批才看得到已形成的树；整个过程在一个 SAVEPOINT 里，任何一批失败都整体回滚。
 * 成功后清理没有页面也没有子节点的自动节点，并把整理前的快照存入 wiki_node_undo
 */
export async function organize(db: DB, llm: Llm, opId: number, o: { now?: number } = {}): Promise<{ llmCalls: number; note: string }> {
  const now = o.now ?? Date.now();
  const calls = new Calls(llm);
  const pages = db
    .prepare("SELECT id, slug, kind, title, summary FROM wiki_pages WHERE deleted = 0 AND kind NOT IN ('source', 'answer') ORDER BY slug")
    .all() as unknown as { id: number; slug: string; kind: string; title: string; summary: string }[];
  const have = pageNodes(db);
  const todo = pages.filter((p) => !have.get(p.id)?.manual);
  const fixed = pages.filter((p) => have.get(p.id)?.manual);
  if (!todo.length) {
    const note = '没有需要整理的页面';
    finishOp(db, opId, { status: 'done', llmCalls: 0, note, now });
    return { llmCalls: 0, note };
  }

  const bySlug = new Map(todo.map((p) => [p.slug, p]));
  const seen = new Set<string>();
  const nodesBefore = listNodes(db).length;
  const snapshot = takeSnapshot(db);
  const batches = Math.min(Math.ceil(todo.length / WIKI_LIMITS.organizeBatch), WIKI_LIMITS.organizeCalls);
  let placed = 0;

  db.exec('SAVEPOINT organize_run');
  try {
    for (let i = 0; i < batches; i++) {
      const slice = todo.slice(i * WIKI_LIMITS.organizeBatch, (i + 1) * WIKI_LIMITS.organizeBatch);
      const nodes = new Map(listNodes(db).map((n) => [n.id, n]));
      const fixedText = fixed.map((p) => `${p.slug} → ${pathText(nodes, have.get(p.id)!.node_id)}`).join('\n');
      const out = await calls.json<{ nodes?: unknown }>(organizePrompt(slice, renderTree(db), fixedText), 8000);
      if (!Array.isArray(out.nodes)) throw new WikiError(502, '模型没有给出分类');
      for (const item of out.nodes as unknown[]) {
        if (!item || typeof item !== 'object') continue;
        const e = item as { path?: unknown; pages?: unknown };
        const path = cleanPath(e.path);
        if (!path || !Array.isArray(e.pages)) continue;
        const slugs = (e.pages as unknown[]).filter((s): s is string => typeof s === 'string' && bySlug.has(s) && !seen.has(s));
        if (!slugs.length) continue;
        const node = ensurePath(db, path, { now });
        if (node == null) continue;
        for (const s of slugs) {
          seen.add(s);
          placePage(db, bySlug.get(s)!.id, node);
          placed++;
        }
      }
    }
    // 清理空的自动节点：从最深一层往上，直到没有可删的
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
    const created = Math.max(0, listNodes(db).length - nodesBefore);
    const note = `整理 ${placed} 个页面，新建 ${created} 个节点`;
    db.prepare('INSERT INTO wiki_node_undo(op_id, snapshot) VALUES (?, ?)').run(opId, JSON.stringify(snapshot));
    finishOp(db, opId, { status: 'done', llmCalls: calls.n, note, now });
    db.exec('RELEASE organize_run');
    return { llmCalls: calls.n, note };
  } catch (e) {
    db.exec('ROLLBACK TO organize_run');
    db.exec('RELEASE organize_run');
    throw e;
  }
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
    // 父节点必须先于子节点：按快照里的顺序（id 升序，父节点总是先建出来）
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
