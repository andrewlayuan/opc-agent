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

export function setInterests(db: DB, topics: Topic[], input: unknown): Interests {
  const v = sanitize(input, topics);
  db.prepare('INSERT INTO prefs(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(
    KEY,
    JSON.stringify(v),
    Date.now(),
  );
  return v;
}
