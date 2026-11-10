import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Topic {
  id: string;
  label: string;
  hint?: string;
  /** false：关键词太宽泛，分析后只采用模型判定 */
  autoTag?: boolean;
  keywords: string[];
}

/** 给模型看的主题清单：id=名称（边界说明） */
export function topicPromptList(topics: Topic[]): string {
  return topics.map((t) => `${t.id}=${t.label}${t.hint ? `（${t.hint}）` : ''}`).join('；');
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function loadTopics(): Topic[] {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'topics.json'), 'utf8')) as { topics: Topic[] };
  return raw.topics;
}

/** 主题集合的版本号：增删主题或改名后变化，用于触发历史条目重新归类 */
export function topicsRev(topics: Topic[]): string {
  return createHash('sha256')
    .update(topics.map((t) => `${t.id}=${t.label}`).join('\n'))
    .digest('hex')
    .slice(0, 12);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class TopicMatcher {
  private compiled: { id: string; re: RegExp }[];
  readonly topics: Topic[];
  constructor(topics: Topic[]) {
    this.topics = topics;
    this.compiled = topics.map((t) => {
      const parts = t.keywords.map((k) => {
        const e = escapeRe(k);
        return /^[A-Za-z0-9]{1,4}$/.test(k) ? `(?<![A-Za-z0-9])${e}(?![A-Za-z0-9])` : e;
      });
      return { id: t.id, re: new RegExp(parts.join('|'), 'i') };
    });
  }
  match(text: string): string[] {
    return this.compiled.filter((c) => c.re.test(text)).map((c) => c.id);
  }
}

const TRACKING = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|source|spm|from|share_token|si)$/i;

export function normalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if (u.protocol === 'http:') u.protocol = 'https:';
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  let s = u.href;
  if (u.pathname.length > 1 && s.endsWith('/') && !u.search) s = s.slice(0, -1);
  return s;
}

/** 标题规范化：小写、去标点；中文按字保留 */
export function normTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shingles(s: string): Set<string> {
  const out = new Set<string>();
  for (const run of s.match(/[\u4e00-\u9fff]+|[^\s\u4e00-\u9fff]+/g) ?? []) {
    if (/[\u4e00-\u9fff]/.test(run)) {
      if (run.length === 1) out.add(run);
      for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
    } else out.add(run);
  }
  return out;
}

export function titleSimilarity(a: string, b: string): number {
  const A = shingles(a);
  const B = shingles(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function detectLang(s: string): 'zh' | 'en' {
  const sample = s.slice(0, 400);
  const cjk = (sample.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return cjk >= 4 || cjk / Math.max(1, sample.length) > 0.15 ? 'zh' : 'en';
}
