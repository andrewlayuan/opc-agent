// 情报 → 知识库：让 Wiki 知识图谱持续吸收情报，但把模型调用控制在每天 10 份资料以内。
// 1) 每天一份「情报日报」：昨天重要度 ≥3 的资讯（同一事件已归并），按主题汇总成一份笔记，不额外调用模型；
// 2) 与你相关（relevance ≥2）且重要度 ≥3 的资讯，每天最多再单独存入一部分。
// 入库后由 Wiki 后台队列照常扫描、摄入；两类加起来每天最多 dailyDocs 份。
import type { DB } from '../../packages/core/db.ts';
import { createDoc } from '../kb/docs.ts';
import { createFolder } from '../kb/folders.ts';
import { KbError, clipCp } from '../kb/types.ts';
import { loadTopics } from './text.ts';
import type { Topic } from './text.ts';

export const FEED_LIMITS = {
  /** 每天自动存入知识库的资料上限（日报 + 单条） */
  dailyDocs: 10,
  digestMin: 3,
  digestMax: 30,
  /** 日报在本地时间几点之后生成，让昨天晚上发布的条目有时间分析完 */
  digestAfterHour: 2,
  itemWindowHours: 48,
};
const FOLDER = '情报';

const startOfDay = (t: number): number => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const dayKey = (t: number): string => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 单行、限长，去掉会破坏 Markdown 结构的字符（方括号、尖括号、反引号） */
const clean = (s: unknown, n: number): string =>
  clipCp(String(s ?? '').replace(/\s+/g, ' ').trim(), n).replace(/[[\]<>`]/g, ' ').replace(/\s+/g, ' ').trim();

function folderId(db: DB, now: number): number | null {
  const r = db.prepare('SELECT id FROM kb_folders WHERE parent_id IS NULL AND name = ?').get(FOLDER) as { id: number } | undefined;
  if (r) return Number(r.id);
  try {
    return createFolder(db, FOLDER, null, now);
  } catch {
    return null; // 目录满了就放在「未归类」
  }
}

const fedToday = (db: DB, now: number): number =>
  Number((db.prepare('SELECT count(*) AS n FROM radar_wiki_feed WHERE doc_id IS NOT NULL AND at >= ?').get(startOfDay(now)) as { n: number }).n);

const record = (db: DB, key: string, docId: number | null, now: number): void => {
  db.prepare('INSERT OR IGNORE INTO radar_wiki_feed(key, doc_id, at) VALUES (?, ?, ?)').run(key, docId, now);
};

interface Row {
  id: number;
  url: string;
  title: string;
  summary: string;
  source: string;
  importance: number;
  topics: string;
}

export function digestMarkdown(db: DB, day: string, rows: Row[], topics: Topic[] = loadTopics()): string {
  const label = new Map(topics.map((t) => [t.id, t.label]));
  const also = db.prepare('SELECT s.name AS source FROM items i JOIN sources s ON s.id = i.source_id WHERE i.dup_of = ? ORDER BY i.published_at, i.id LIMIT 10');
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    let ts: string[] = [];
    try {
      ts = JSON.parse(r.topics) as string[];
    } catch {
      ts = [];
    }
    const g = ts.map((t) => label.get(t)).find(Boolean) ?? '其他';
    const others = (also.all(r.id) as { source: string }[]).map((x) => clean(x.source, 20));
    const extra = others.length ? `另有 ${others.length} 个来源（${others.join('、')}）报道。` : '';
    const url = /^https?:\/\//i.test(r.url) ? ` [原文](${r.url.replace(/[()\s]/g, '')})` : '';
    const line = `- **${clean(r.title, 100)}**（${clean(r.source, 20)}，重要度 ${r.importance}）${clean(r.summary, 200)}${extra}${url}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(line);
  }
  const head = [`# 情报日报 ${day}`, '', `情报雷达自动汇总：${day} 发布、重要度 3 以上的 ${rows.length} 条资讯（同一事件的多条报道已合并）。`, ''];
  return [...head, ...[...groups].flatMap(([g, ls]) => [`## ${g}`, '', ...ls, ''])].join('\n').trimEnd() + '\n';
}

/** 昨天的日报；只生成一次。返回新建的知识库条目 id，没有则 null */
function feedDigest(db: DB, now: number): number | null {
  if (new Date(now).getHours() < FEED_LIMITS.digestAfterHour) return null;
  const end = startOfDay(now);
  const start = startOfDay(end - 12 * 3600 * 1000);
  const day = dayKey(start);
  const key = `digest:${day}`;
  if (db.prepare('SELECT 1 FROM radar_wiki_feed WHERE key = ?').get(key)) return null;
  const rows = db
    .prepare(
      `SELECT i.id, i.url, coalesce(i.title_zh, i.title) AS title, coalesce(i.summary_zh, '') AS summary, s.name AS source, i.importance, i.topics
       FROM items i JOIN sources s ON s.id = i.source_id
       WHERE i.published_at >= ? AND i.published_at < ? AND i.dup_of IS NULL AND i.analyzed_at IS NOT NULL AND i.importance >= 3
       ORDER BY i.importance DESC, i.published_at DESC LIMIT ?`,
    )
    .all(start, end, FEED_LIMITS.digestMax) as unknown as Row[];
  if (rows.length < FEED_LIMITS.digestMin) {
    record(db, key, null, now);
    return null;
  }
  const id = createDoc(db, { kind: 'note', title: `情报日报 ${day}`, folderId: folderId(db, now), body: digestMarkdown(db, day, rows) }, now);
  record(db, key, id, now);
  return id;
}

/** 与你相关的重要资讯，按相关度、重要度取前几条，直接存成知识库「资讯」条目 */
function feedRelevant(db: DB, now: number, room: number): number {
  if (room <= 0) return 0;
  const rows = db
    .prepare(
      `SELECT i.id FROM items i
       WHERE i.dup_of IS NULL AND i.analyzed_at IS NOT NULL AND i.relevance >= 2 AND i.importance >= 3 AND i.published_at >= ?
         AND NOT EXISTS (SELECT 1 FROM radar_wiki_feed f WHERE f.key = 'item:' || i.id)
         AND NOT EXISTS (SELECT 1 FROM kb_docs d WHERE d.item_id = i.id)
       ORDER BY i.relevance DESC, i.importance DESC, i.published_at DESC LIMIT ?`,
    )
    .all(now - FEED_LIMITS.itemWindowHours * 3600 * 1000, room) as { id: number }[];
  let n = 0;
  const folder = folderId(db, now);
  for (const r of rows) {
    const key = `item:${r.id}`;
    try {
      record(db, key, createDoc(db, { kind: 'item', itemId: Number(r.id), folderId: folder }, now), now);
      n++;
    } catch (e) {
      if (e instanceof KbError && e.status === 409) record(db, key, null, now);
      else throw e;
    }
  }
  return n;
}

/** 每轮采集后调用：生成昨天的日报、补存与你相关的资讯；返回本次新入库的资料数 */
export function feedWiki(db: DB, now: number = Date.now()): number {
  let n = 0;
  if (fedToday(db, now) < FEED_LIMITS.dailyDocs && feedDigest(db, now) != null) n++;
  n += feedRelevant(db, now, FEED_LIMITS.dailyDocs - fedToday(db, now));
  return n;
}
