import type { DB } from '../../packages/core/db.ts';

export interface ListParams {
  topic?: string;
  /** 命中任一主题即可（用于“我的关注”） */
  topics?: string[];
  grp?: string;
  source?: string;
  q?: string;
  days?: number;
  minImportance?: number;
  starred?: boolean;
  includeDup?: boolean;
  before?: number; // published_at 游标
  limit?: number;
}

export interface ItemView {
  id: number;
  url: string;
  title: string;
  title_zh: string | null;
  summary_zh: string | null;
  analysis: string[];
  topics: string[];
  importance: number | null;
  lang: string;
  author: string | null;
  published_at: number;
  source_id: string;
  source_name: string;
  grp: string;
  starred: boolean;
  analyzed: boolean;
  analysis_error: string | null;
  has_translation: boolean;
  dup_of: number | null;
}

const COLS = `i.id, i.url, i.title, i.title_zh, i.summary_zh, i.analysis_zh, i.topics, i.importance, i.lang, i.author,
  i.published_at, i.source_id, s.name AS source_name, s.grp, i.starred, i.analyzed_at, i.analysis_error,
  (i.translation_zh IS NOT NULL) AS has_tr, i.dup_of`;

type Row = Record<string, unknown>;

function toView(r: Row): ItemView {
  return {
    id: Number(r.id),
    url: String(r.url),
    title: String(r.title),
    title_zh: (r.title_zh as string) ?? null,
    summary_zh: (r.summary_zh as string) ?? null,
    analysis: r.analysis_zh ? (JSON.parse(String(r.analysis_zh)) as string[]) : [],
    topics: JSON.parse(String(r.topics || '[]')) as string[],
    importance: r.importance == null ? null : Number(r.importance),
    lang: String(r.lang),
    author: (r.author as string) ?? null,
    published_at: Number(r.published_at),
    source_id: String(r.source_id),
    source_name: String(r.source_name),
    grp: String(r.grp),
    starred: Boolean(r.starred),
    analyzed: r.analyzed_at != null,
    analysis_error: (r.analysis_error as string) ?? null,
    has_translation: Boolean(r.has_tr),
    dup_of: r.dup_of == null ? null : Number(r.dup_of),
  };
}

/** FTS5 trigram 查询：每个词加引号转义，避免语法注入 */
function ftsQuery(q: string): string | null {
  const terms = q
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (!terms.length || terms.some((t) => [...t].length < 3)) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
}

export function listItems(db: DB, p: ListParams): ItemView[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (!p.includeDup) where.push('i.dup_of IS NULL');
  const anyTopics = [...new Set([...(p.topic ? [p.topic] : []), ...(p.topics ?? [])])].slice(0, 20);
  if (anyTopics.length) {
    where.push(`EXISTS (SELECT 1 FROM json_each(i.topics) WHERE value IN (${anyTopics.map(() => '?').join(',')}))`);
    args.push(...anyTopics);
  }
  if (p.grp) {
    where.push('s.grp = ?');
    args.push(p.grp);
  }
  if (p.source) {
    where.push('i.source_id = ?');
    args.push(p.source);
  }
  if (p.days) {
    where.push('i.published_at >= ?');
    args.push(Date.now() - p.days * 24 * 3600 * 1000);
  }
  if (p.minImportance) {
    where.push('i.importance >= ?');
    args.push(p.minImportance);
  }
  if (p.starred) where.push('i.starred = 1');
  if (p.before) {
    where.push('i.published_at < ?');
    args.push(p.before);
  }
  let from = 'items i JOIN sources s ON s.id = i.source_id';
  if (p.q) {
    const fq = ftsQuery(p.q);
    if (fq) {
      from = 'items_fts f JOIN items i ON i.id = f.rowid JOIN sources s ON s.id = i.source_id';
      where.push('items_fts MATCH ?');
      args.push(fq);
    } else {
      const like = `%${p.q.trim().replace(/[\\%_]/g, (m) => '\\' + m)}%`;
      where.push("(i.title LIKE ? ESCAPE '\\' OR i.title_zh LIKE ? ESCAPE '\\' OR i.summary_zh LIKE ? ESCAPE '\\' OR i.content LIKE ? ESCAPE '\\')");
      args.push(like, like, like, like);
    }
  }
  const limit = Math.min(100, Math.max(1, p.limit ?? 30));
  const sql = `SELECT ${COLS} FROM ${from} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.published_at DESC LIMIT ${limit}`;
  return (db.prepare(sql).all(...args) as Row[]).map(toView);
}

export function getItem(db: DB, id: number): (ItemView & { content: string; translation_zh: string | null }) | null {
  const r = db.prepare(`SELECT ${COLS}, i.content, i.translation_zh FROM items i JOIN sources s ON s.id = i.source_id WHERE i.id = ?`).get(id) as Row | undefined;
  if (!r) return null;
  return { ...toView(r), content: String(r.content ?? ''), translation_zh: (r.translation_zh as string) ?? null };
}

export function stats(db: DB): { total: number; today: number; analyzed: number; pending: number } {
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const r = db
    .prepare(
      `SELECT count(*) AS total,
        sum(published_at >= ?) AS today,
        sum(analyzed_at IS NOT NULL) AS analyzed,
        sum(analyzed_at IS NULL AND dup_of IS NULL) AS pending
       FROM items`,
    )
    .get(dayAgo) as Record<string, number | null>;
  return { total: Number(r.total ?? 0), today: Number(r.today ?? 0), analyzed: Number(r.analyzed ?? 0), pending: Number(r.pending ?? 0) };
}
