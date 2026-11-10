// 正文补全：RSS 只给摘要时，用 Agent-Reach 的 web read 读取原文全文，供分析与翻译使用。
import type { DB } from '../../packages/core/db.ts';
import { assertPublicAndRobotsAllowed } from '../../packages/core/net.ts';
import { cleanMarkdown } from '../../packages/core/reach.ts';
import type { Reach } from '../../packages/core/reach.ts';

/** 正文少于该长度才尝试补全 */
export const FULLTEXT_MIN_CHARS = 1200;

/** 这些来源自带完整内容或不适合整页读取 */
const SKIP_KINDS = new Set(['hf-models', 'github-releases', 'reach']);
const SKIP_GROUPS = new Set(['paper']);

interface Row {
  id: number;
  url: string;
  content: string;
  kind: string;
  grp: string;
  fulltext_at: number | null;
}

function load(db: DB, id: number): Row | undefined {
  return db
    .prepare('SELECT i.id, i.url, i.content, s.kind, s.grp, i.fulltext_at FROM items i JOIN sources s ON s.id = i.source_id WHERE i.id = ?')
    .get(id) as Row | undefined;
}

export function needsFulltext(r: Pick<Row, 'content' | 'kind' | 'grp' | 'fulltext_at'>): boolean {
  return r.fulltext_at == null && !SKIP_KINDS.has(r.kind) && !SKIP_GROUPS.has(r.grp) && r.content.trim().length < FULLTEXT_MIN_CHARS;
}

/** 补全单条；返回是否拿到了更长的正文。失败只记录，不抛出 */
export async function enrichItem(db: DB, reach: Reach, id: number, force = false): Promise<boolean> {
  if (!reach.enabled) return false;
  const r = load(db, id);
  if (!r) return false;
  if (!force && !needsFulltext(r)) return false;
  if (force && (SKIP_KINDS.has(r.kind) || r.content.trim().length >= FULLTEXT_MIN_CHARS)) return false;
  const mark = db.prepare('UPDATE items SET fulltext_at=?, fulltext_error=? WHERE id=?');
  try {
    await assertPublicAndRobotsAllowed(r.url);
    const items = await reach.run(['web', 'read', r.url], 60000);
    const text = cleanMarkdown(items[0]?.text ?? '');
    if (text.length > r.content.trim().length + 200) {
      db.prepare('UPDATE items SET content=?, fulltext_at=?, fulltext_error=NULL WHERE id=?').run(text, Date.now(), id);
      return true;
    }
    mark.run(Date.now(), '原文没有更多内容', id);
    return false;
  } catch (e) {
    mark.run(Date.now(), (e instanceof Error ? e.message : String(e)).slice(0, 300), id);
    return false;
  }
}

/** 为接下来要分析的条目补全正文（最新优先，串行，受 Agent-Reach 限速） */
export async function enrichPending(db: DB, reach: Reach, limit: number, window: number, log: (s: string) => void = () => {}): Promise<number> {
  if (!reach.enabled || limit <= 0) return 0;
  const rows = db
    .prepare(
      `SELECT i.id, i.content, s.kind, s.grp, i.fulltext_at FROM items i JOIN sources s ON s.id = i.source_id
       WHERE i.analyzed_at IS NULL AND i.dup_of IS NULL AND i.analysis_error IS NULL
       ORDER BY i.published_at DESC LIMIT ?`,
    )
    .all(window) as unknown as Row[];
  const todo = rows.filter(needsFulltext).slice(0, limit);
  let ok = 0;
  for (const r of todo) {
    if (await enrichItem(db, reach, r.id)) ok++;
  }
  if (todo.length) log(`  全文补全：尝试 ${todo.length}，成功 ${ok}`);
  return ok;
}
