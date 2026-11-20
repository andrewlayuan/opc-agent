export interface FeedEntry {
  title: string;
  url: string;
  author?: string;
  publishedAt?: number;
  content: string;
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', copy: '©', reg: '®', trade: '™', bull: '•',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

function unwrapCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/** XML 节点文本：处理 CDATA 与实体 */
function nodeText(raw: string | undefined): string {
  if (!raw) return '';
  const hasCdata = raw.includes('<![CDATA[');
  const s = unwrapCdata(raw);
  return hasCdata ? s.trim() : decodeEntities(s).trim();
}

/** HTML 片段转纯文本 */
export function htmlToText(html: string, maxLen = 8000): string {
  let s = html
    .replace(/<(script|style|noscript|iframe|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/blockquote)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s)
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

function firstTag(block: string, names: string[]): string | undefined {
  for (const n of names) {
    const re = new RegExp(`<${n.replace(':', '\\:')}(?:\\s[^>]*)?>([\\s\\S]*?)</${n.replace(':', '\\:')}>`, 'i');
    const m = block.match(re);
    if (m && m[1].trim()) return m[1];
  }
  return undefined;
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : undefined;
}

function parseDate(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(nodeText(s));
  return Number.isFinite(t) ? t : undefined;
}

function atomLink(block: string): string | undefined {
  const links = block.match(/<link\b[^>]*\/?>/gi) ?? [];
  let fallback: string | undefined;
  for (const l of links) {
    const href = attr(l, 'href');
    if (!href) continue;
    const rel = (attr(l, 'rel') || 'alternate').toLowerCase();
    if (rel === 'alternate') return href;
    fallback ??= href;
  }
  return fallback;
}

export function parseFeed(xml: string, baseUrl: string): FeedEntry[] {
  // 不解析 DOCTYPE，不展开自定义实体
  const body = xml.replace(/<!DOCTYPE[\s\S]*?>/i, '');
  const isAtom = /<feed[\s>]/i.test(body) && /<entry[\s>]/i.test(body);
  const blocks = isAtom ? body.match(/<entry[\s>][\s\S]*?<\/entry>/gi) : body.match(/<item[\s>][\s\S]*?<\/item>/gi);
  const out: FeedEntry[] = [];
  for (const b of blocks ?? []) {
    const title = htmlToText(nodeText(firstTag(b, ['title'])), 500);
    let link: string | undefined;
    if (isAtom) link = atomLink(b);
    else {
      link = nodeText(firstTag(b, ['link'])) || undefined;
      if (!link) {
        const guid = b.match(/<guid([^>]*)>([\s\S]*?)<\/guid>/i);
        if (guid && !/isPermaLink\s*=\s*["']false/i.test(guid[1])) link = nodeText(guid[2]);
      }
      if (!link) link = atomLink(b);
    }
    if (!title || !link) continue;
    let url: string;
    try {
      url = new URL(link.trim(), baseUrl).href;
    } catch {
      continue;
    }
    if (!/^https?:/.test(url)) continue;
    const rawContent = firstTag(b, ['content:encoded', 'content', 'description', 'summary', 'media:description']) ?? '';
    const authorBlock = firstTag(b, ['dc:creator', 'author']);
    const author = authorBlock ? htmlToText(nodeText(firstTag(authorBlock, ['name']) ?? authorBlock), 200) : undefined;
    out.push({
      title,
      url,
      author: author || undefined,
      publishedAt: parseDate(firstTag(b, ['pubDate', 'published', 'dc:date', 'updated', 'issued'])),
      content: htmlToText(nodeText(rawContent)),
    });
  }
  return out;
}

interface HfModel {
  id?: string;
  modelId?: string;
  createdAt?: string;
  pipeline_tag?: string;
  likes?: number;
  downloads?: number;
  tags?: string[];
}

export function parseHfModels(json: string): FeedEntry[] {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: FeedEntry[] = [];
  for (const m of arr as HfModel[]) {
    const id = m.id || m.modelId;
    if (!id || !/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(id) || id.includes('..')) continue;
    const tags = (m.tags ?? []).filter((t) => !/^(region|deploy|endpoints|license):|^(safetensors|transformers)$/.test(t)).slice(0, 12);
    out.push({
      title: `Hugging Face 新模型：${id}`,
      url: `https://huggingface.co/${id}`,
      author: id.split('/')[0],
      publishedAt: m.createdAt ? Date.parse(m.createdAt) || undefined : undefined,
      content: [`任务类型：${m.pipeline_tag ?? '未知'}`, `点赞：${m.likes ?? 0}，下载：${m.downloads ?? 0}`, tags.length ? `标签：${tags.join(', ')}` : '']
        .filter(Boolean)
        .join('\n'),
    });
  }
  return out;
}

interface GhRelease {
  html_url?: string;
  name?: string | null;
  tag_name?: string;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
  author?: { login?: string };
}

/** GitHub REST API：/repos/{owner}/{repo}/releases */
export function parseGithubReleases(json: string, apiUrl: string): FeedEntry[] {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const repo = new URL(apiUrl).pathname.split('/').slice(2, 4).join('/');
  const out: FeedEntry[] = [];
  for (const r of arr as GhRelease[]) {
    if (r.draft || !r.html_url || !/^https:\/\/github\.com\//.test(r.html_url)) continue;
    const ver = (r.name || r.tag_name || '').trim();
    const body = (r.body ?? '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^#+\s*/gm, '')
      .replace(/\*\*/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    out.push({
      title: `${repo} ${ver}${r.prerelease ? '（预发布）' : ''}`,
      url: r.html_url,
      author: r.author?.login,
      publishedAt: r.published_at ? Date.parse(r.published_at) || undefined : undefined,
      content: body.length > 8000 ? body.slice(0, 8000) + '…' : body,
    });
  }
  return out;
}

const ATTR = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
const attrOf = (attrs: string, name: string): string | null => {
  const m = ATTR(name).exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
};
const ARTICLE_PATH = /^\/\d{4}-\d{2}\/\d{2}\/c_\d+\.htm$/;

/**
 * 政府网站文章列表页（如网信办栏目页）：逐个 <li> 取第一个链接。
 * 只保留与列表页同域名、路径形如 /YYYY-MM/DD/c_数字.htm 的文章链接；日期取 <li> 内第一个 YYYY-MM-DD，按东八区零点。
 */
export function parsePageList(html: string, pageUrl: string): FeedEntry[] {
  const base = new URL(pageUrl);
  const seen = new Set<string>();
  const out: FeedEntry[] = [];
  for (const li of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const a = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(li[1]);
    if (!a) continue;
    const href = attrOf(a[1], 'href');
    if (!href) continue;
    let u: URL;
    try {
      u = new URL(decodeEntities(href.trim()), base);
    } catch {
      continue;
    }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.hostname !== base.hostname || !ARTICLE_PATH.test(u.pathname)) continue;
    const url = `${base.protocol}//${u.host}${u.pathname}`;
    if (seen.has(url)) continue;
    const norm = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    const title = norm(attrOf(a[1], 'title') ?? '') || norm(a[2]);
    if (!title) continue;
    seen.add(url);
    const d = /(\d{4})-(\d{2})-(\d{2})/.exec(li[1].replace(/<a\b[^>]*>/gi, ''));
    const publishedAt = d ? Date.UTC(+d[1], +d[2] - 1, +d[3]) - 8 * 3600_000 : undefined;
    out.push({ title, url, ...(publishedAt !== undefined ? { publishedAt } : {}), content: '' });
  }
  return out;
}
