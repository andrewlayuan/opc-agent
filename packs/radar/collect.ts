import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '../../packages/core/db.ts';
import { parseFeed, parseGithubReleases, parseHfModels, parsePageList } from '../../packages/core/feed.ts';
import type { FeedEntry } from '../../packages/core/feed.ts';
import { allowHost, politeFetch } from '../../packages/core/net.ts';
import type { Reach } from '../../packages/core/reach.ts';
import { DEFAULT_PROFILE, normalizeProfileId } from './profile-id.ts';
import { detectLang, normTitle, normalizeUrl, titleSimilarity } from './text.ts';
import type { TopicMatcher } from './text.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface SourceDef {
  id: string;
  name: string;
  url: string;
  kind?: 'feed' | 'hf-models' | 'github-releases' | 'reach' | 'page-list';
  /** kind=reach 时的 Agent-Reach 命令，例如 ["v2ex", "node", "openai"]；url 仅用于展示 */
  reach?: string[];
  grp?: string;
  lang?: string;
  filter?: boolean;
  maxItems?: number;
  /** 所属的职业档案 id（见 profiles.json）；省略表示只属于 tech */
  profiles?: string[];
}

export interface SourceRow {
  id: string;
  name: string;
  url: string;
  kind: string;
  grp: string;
  lang: string;
  filter: number;
  max_items: number;
  enabled: number;
  custom: number;
  etag: string | null;
  last_modified: string | null;
  last_fetch_at: number | null;
  last_ok_at: number | null;
  last_error: string | null;
  item_count: number;
  reach_args: string | null;
}

export const GROUPS: Record<string, string> = {
  lab: '官方博客',
  model: '模型发布',
  blog: '大牛博客',
  community: '社区',
  paper: '论文',
  media: '媒体',
  release: '开源发布',
  reg: '合规监管',
  custom: '自定义',
};

/** 按信息源类型解析响应正文；解析结果异常时抛出可读的原因 */
export function parseEntries(src: Pick<SourceRow, 'kind' | 'url'>, text: string): FeedEntry[] {
  if (src.kind === 'hf-models') return parseHfModels(text);
  if (src.kind === 'github-releases') return parseGithubReleases(text, src.url);
  if (src.kind === 'page-list') {
    const entries = parsePageList(text, src.url);
    if (!entries.length) throw new Error('页面结构可能已变化（未解析到文章链接）');
    return entries;
  }
  const entries = parseFeed(text, src.url);
  if (src.kind === 'feed' && !entries.length && !/<(rss|feed|rdf)/i.test(text)) throw new Error('响应不是 RSS/Atom（站点可能拒绝了自动访问）');
  return entries;
}

export function loadSourceDefs(): SourceDef[] {
  return (JSON.parse(fs.readFileSync(path.join(HERE, 'sources.json'), 'utf8')) as { sources: SourceDef[] }).sources;
}

/** 把 sources.json 同步进库（保留启用状态与缓存），并把所有源的域名加入外发白名单 */
export function syncSources(db: DB): void {
  const defs = loadSourceDefs();
  const upsert = db.prepare(`
    INSERT INTO sources(id, name, url, kind, grp, lang, filter, max_items, reach_args, custom, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(id) DO UPDATE SET
      etag=CASE WHEN url = excluded.url THEN etag ELSE NULL END,
      last_modified=CASE WHEN url = excluded.url THEN last_modified ELSE NULL END,
      name=excluded.name, url=excluded.url, kind=excluded.kind, grp=excluded.grp,
      lang=excluded.lang, filter=excluded.filter, max_items=excluded.max_items, reach_args=excluded.reach_args
    WHERE custom = 0`);
  // 新出现的内置源：只有属于当前档案才默认启用（已有源保留各自的启用状态）
  const active = db.prepare("SELECT value FROM prefs WHERE key = 'source_profile'").get() as { value: string } | undefined;
  const activeId = normalizeProfileId(active?.value);
  const ids = new Set(defs.map((d) => d.id));
  const stale = (db.prepare('SELECT id FROM sources WHERE custom = 0').all() as { id: string }[]).filter((r) => !ids.has(r.id));
  for (const r of stale) {
    db.prepare('DELETE FROM items WHERE source_id = ?').run(r.id);
    db.prepare('DELETE FROM sources WHERE id = ?').run(r.id);
  }
  for (const d of defs) {
    upsert.run(d.id, d.name, d.url, d.kind ?? 'feed', d.grp ?? 'media', d.lang ?? 'en', d.filter ? 1 : 0, d.maxItems ?? 30, d.reach ? JSON.stringify(d.reach) : null, (d.profiles?.length ? d.profiles : [DEFAULT_PROFILE]).includes(activeId) ? 1 : 0);
  }
  for (const r of db.prepare('SELECT url FROM sources').all() as { url: string }[]) {
    try {
      allowHost(new URL(r.url).hostname);
    } catch {
      /* 跳过非法 URL */
    }
  }
}

/** 清掉所有启用源的 ETag / Last-Modified，让下一次采集不会因「未修改」而跳过 */
export function resetSourceCache(db: DB): number {
  return Number(db.prepare('UPDATE sources SET etag = NULL, last_modified = NULL WHERE enabled = 1').run().changes);
}

export interface RunStats {
  runId: number;
  okSources: number;
  failedSources: number;
  newItems: number;
  newIds: number[];
}

export function insertEntries(db: DB, src: SourceRow, entries: FeedEntry[], matcher: TopicMatcher, maxAgeDays: number): number[] {
  const now = Date.now();
  const minTime = now - maxAgeDays * 24 * 3600 * 1000;
  const exists = db.prepare('SELECT 1 FROM items WHERE url = ?');
  const deleted = db.prepare('SELECT 1 FROM radar_deleted_urls WHERE url = ?');
  const recent = db.prepare('SELECT id, norm_title FROM items WHERE published_at > ? AND dup_of IS NULL ORDER BY published_at DESC LIMIT 2000');
  const ins = db.prepare(`INSERT INTO items(source_id, url, title, norm_title, author, published_at, fetched_at, content, lang, topics, dup_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const recentTitles = recent.all(now - 4 * 24 * 3600 * 1000) as { id: number; norm_title: string }[];
  const ids: number[] = [];
  let taken = 0;
  const sorted = [...entries].sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  for (const e of sorted) {
    if (taken >= src.max_items) break;
    let url: string;
    try {
      url = normalizeUrl(e.url);
    } catch {
      continue;
    }
    const published = e.publishedAt && e.publishedAt <= now + 3600_000 ? e.publishedAt : now;
    if (published < minTime) continue;
    if (exists.get(url)) continue;
    if (deleted.get(url)) continue;
    const text = `${e.title}\n${e.content.slice(0, 3000)}`;
    const topics = matcher.match(text);
    if (src.filter && !topics.some((t) => t !== 'product')) continue;
    const nt = normTitle(e.title);
    let dupOf: number | null = null;
    if (nt.length >= 12) {
      for (const r of recentTitles) {
        if (titleSimilarity(nt, r.norm_title) >= 0.8) {
          dupOf = r.id;
          break;
        }
      }
    }
    const lang = src.lang === 'zh' ? 'zh' : detectLang(text);
    const res = ins.run(src.id, url, e.title, nt, e.author ?? null, published, now, e.content, lang, JSON.stringify(topics), dupOf);
    const id = Number(res.lastInsertRowid);
    ids.push(id);
    if (dupOf === null) recentTitles.unshift({ id, norm_title: nt });
    taken++;
  }
  return ids;
}

function fromReach(items: Awaited<ReturnType<Reach['run']>>): FeedEntry[] {
  const out: FeedEntry[] = [];
  for (const it of items) {
    if (!it.title || !it.url || !/^https?:\/\//.test(it.url)) continue;
    const t = it.published_at ? Date.parse(it.published_at) : NaN;
    out.push({ title: it.title.slice(0, 500), url: it.url, author: it.author ?? undefined, publishedAt: Number.isFinite(t) ? t : undefined, content: (it.text ?? '').slice(0, 8000) });
  }
  return out;
}

async function fetchReachSource(src: SourceRow, reach: Reach | undefined): Promise<FeedEntry[]> {
  if (!reach?.enabled) throw new Error('未安装或已停用 Agent-Reach');
  const args = JSON.parse(src.reach_args ?? '[]') as unknown;
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) throw new Error('reach 参数格式错误');
  return fromReach(await reach.run([...(args as string[]), String(Math.min(50, src.max_items))]));
}

export async function collectOnce(
  db: DB,
  matcher: TopicMatcher,
  opts: { maxAgeDays: number; onlySource?: string; reach?: Reach; log?: (s: string) => void },
): Promise<RunStats> {
  const log = opts.log ?? (() => {});
  const runId = Number(db.prepare('INSERT INTO runs(started_at) VALUES (?)').run(Date.now()).lastInsertRowid);
  const sources = (
    opts.onlySource
      ? db.prepare('SELECT * FROM sources WHERE id = ?').all(opts.onlySource)
      : db.prepare('SELECT * FROM sources WHERE enabled = 1').all()
  ) as unknown as SourceRow[];
  const stats: RunStats = { runId, okSources: 0, failedSources: 0, newItems: 0, newIds: [] };
  const upd = db.prepare('UPDATE sources SET etag=?, last_modified=?, last_fetch_at=?, last_ok_at=?, last_error=?, item_count=item_count+? WHERE id=?');
  const fail = db.prepare('UPDATE sources SET last_fetch_at=?, last_error=? WHERE id=?');

  // 并发跑各源；同域名的请求在 politeFetch 内部串行限速
  let cursor = 0;
  const workers = Array.from({ length: 8 }, async () => {
    while (cursor < sources.length) {
      const src = sources[cursor++];
      const now = Date.now();
      try {
        if (src.kind === 'reach') {
          const entries = await fetchReachSource(src, opts.reach);
          const ids = insertEntries(db, src, entries, matcher, opts.maxAgeDays);
          upd.run(null, null, now, now, null, ids.length, src.id);
          stats.okSources++;
          stats.newItems += ids.length;
          stats.newIds.push(...ids);
          log(`  ✓ ${src.name}: ${entries.length} 条，新增 ${ids.length}（Agent-Reach）`);
          continue;
        }
        const res = await politeFetch(src.url, { etag: src.etag, lastModified: src.last_modified });
        if (res.notModified) {
          upd.run(src.etag, src.last_modified, now, now, null, 0, src.id);
          stats.okSources++;
          continue;
        }
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        const entries = parseEntries(src, res.text);
        const ids = insertEntries(db, src, entries, matcher, opts.maxAgeDays);
        upd.run(res.etag ?? null, res.lastModified ?? null, now, now, null, ids.length, src.id);
        stats.okSources++;
        stats.newItems += ids.length;
        stats.newIds.push(...ids);
        log(`  ✓ ${src.name}: ${entries.length} 条，新增 ${ids.length}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        fail.run(now, msg.slice(0, 300), src.id);
        stats.failedSources++;
        log(`  ✗ ${src.name}: ${msg}`);
      }
    }
  });
  await Promise.all(workers);
  db.prepare('UPDATE runs SET ok_sources=?, failed_sources=?, new_items=? WHERE id=?').run(stats.okSources, stats.failedSources, stats.newItems, runId);
  return stats;
}
