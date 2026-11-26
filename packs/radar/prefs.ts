import type { DB } from '../../packages/core/db.ts';
import type { Topic } from './text.ts';

/** 「我的关注」：关注的主题 + 重点阈值（0=全部，3=值得了解及以上，4=只看重要） */
export interface Interests {
  topics: string[];
  minImportance: 0 | 3 | 4;
}

const KEY = 'interests';
const DEFAULT: Interests = { topics: [], minImportance: 3 };

function sanitize(raw: unknown, topics: Topic[]): Interests {
  const valid = new Set(topics.map((t) => t.id));
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(o.topics) ? o.topics.filter((t): t is string => typeof t === 'string' && valid.has(t)) : [];
  const min = Number(o.minImportance);
  return {
    topics: [...new Set(list)].slice(0, 20),
    minImportance: min === 0 || min === 4 ? min : 3,
  };
}

export function getInterests(db: DB, topics: Topic[]): Interests {
  const row = db.prepare('SELECT value FROM prefs WHERE key = ?').get(KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULT };
  try {
    return sanitize(JSON.parse(row.value), topics);
  } catch {
    return { ...DEFAULT };
  }
}

/**
 * 保存关注。topics 是当前身份可选的主题；all 是全部主题（默认同 topics）：
 * 其它身份下设置过的关注会原样保留，切回那个身份时还在。
 */
export function setInterests(db: DB, topics: Topic[], input: unknown, all: Topic[] = topics): Interests {
  const v = sanitize(input, topics);
  const shown = new Set(topics.map((t) => t.id));
  const known = new Set(all.map((t) => t.id));
  const row = db.prepare('SELECT value FROM prefs WHERE key = ?').get(KEY) as { value: string } | undefined;
  let stored: unknown[] = [];
  try {
    const raw = row ? (JSON.parse(row.value) as { topics?: unknown }) : null;
    if (raw && Array.isArray(raw.topics)) stored = raw.topics;
  } catch {
    /* 旧数据损坏：当作没有 */
  }
  const kept = stored.filter((t): t is string => typeof t === 'string' && known.has(t) && !shown.has(t));
  db.prepare('INSERT INTO prefs(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(
    KEY,
    JSON.stringify({ topics: [...v.topics, ...kept].slice(0, 20), minImportance: v.minImportance }),
    Date.now(),
  );
  return v;
}
