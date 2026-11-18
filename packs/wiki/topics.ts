// 页面主题：以总览页为主题，按链接（不分方向）把每页归到距离最近的总览页；
// 距离相同时看上一层相邻页面的多数归属；没有链接的页面按引用的资料归到同资料页面最多的主题
import type { DB } from '../../packages/core/db.ts';

export interface Topic {
  slug: string;
  title: string;
  count: number;
}

export function pageTopics(db: DB): { topics: Topic[]; of: Map<string, string | null> } {
  const pages = db.prepare('SELECT id, slug, kind, title FROM wiki_pages WHERE deleted = 0 ORDER BY id').all() as { id: number; slug: string; kind: string; title: string }[];
  const of = new Map<string, string | null>(pages.map((p) => [p.slug, null]));
  const heads = pages.filter((p) => p.kind === 'overview');
  if (!heads.length) return { topics: [], of };

  const adj = new Map<string, Set<string>>(pages.map((p) => [p.slug, new Set<string>()]));
  const edges = db
    .prepare(
      `SELECT f.slug AS a, t.slug AS b FROM wiki_links l
       JOIN wiki_pages f ON f.id = l.from_page AND f.deleted = 0
       JOIN wiki_pages t ON t.slug = l.to_slug AND t.deleted = 0
       WHERE f.id != t.id`,
    )
    .all() as { a: string; b: string }[];
  for (const e of edges) {
    adj.get(e.a)!.add(e.b);
    adj.get(e.b)!.add(e.a);
  }

  const order = new Map(heads.map((h, i) => [h.slug, i]));
  const vote = (counts: Map<string, number>): string | null => {
    let best: string | null = null;
    for (const [t, n] of counts) {
      const b = best == null ? 0 : counts.get(best)!;
      if (n > b || (n === b && best != null && order.get(t)! < order.get(best)!)) best = t;
    }
    return best;
  };

  // 分层 BFS：每层只看上一层已归属的相邻页面
  let frontier = heads.map((h) => h.slug);
  for (const s of frontier) of.set(s, s);
  while (frontier.length) {
    const next = new Map<string, Map<string, number>>();
    for (const s of frontier) {
      const t = of.get(s)!;
      for (const n of adj.get(s)!) {
        if (of.get(n) != null) continue;
        const c = next.get(n) ?? new Map<string, number>();
        c.set(t, (c.get(t) ?? 0) + 1);
        next.set(n, c);
      }
    }
    for (const [n, c] of next) of.set(n, vote(c));
    frontier = [...next.keys()];
  }

  // 没有链接可达的页面：按引用的资料投票
  const loose = pages.filter((p) => of.get(p.slug) == null);
  if (loose.length) {
    const cites = db.prepare('SELECT DISTINCT c.page_id AS page, c.doc_id AS doc FROM wiki_cites c JOIN wiki_pages p ON p.id = c.page_id AND p.deleted = 0').all() as { page: number; doc: number }[];
    const slugById = new Map(pages.map((p) => [p.id, p.slug]));
    const byDoc = new Map<number, Map<string, number>>();
    for (const c of cites) {
      const t = of.get(slugById.get(Number(c.page))!);
      if (t == null) continue;
      const m = byDoc.get(Number(c.doc)) ?? new Map<string, number>();
      m.set(t, (m.get(t) ?? 0) + 1);
      byDoc.set(Number(c.doc), m);
    }
    const docsOf = new Map<number, number[]>();
    for (const c of cites) docsOf.set(Number(c.page), [...(docsOf.get(Number(c.page)) ?? []), Number(c.doc)]);
    for (const p of loose) {
      const counts = new Map<string, number>();
      for (const d of docsOf.get(p.id) ?? []) for (const [t, n] of byDoc.get(d) ?? []) counts.set(t, (counts.get(t) ?? 0) + n);
      of.set(p.slug, vote(counts));
    }
  }

  const count = new Map<string, number>();
  for (const t of of.values()) if (t != null) count.set(t, (count.get(t) ?? 0) + 1);
  const topics = heads
    .map((h) => ({ slug: h.slug, title: h.title, count: count.get(h.slug) ?? 0 }))
    .sort((a, b) => b.count - a.count || order.get(a.slug)! - order.get(b.slug)!);
  return { topics, of };
}
