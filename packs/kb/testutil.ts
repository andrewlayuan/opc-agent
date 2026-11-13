// 知识库测试共用：临时数据库
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';

export function tmpKbDb(): { db: DB; dir: string; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-kb-'));
  const db = openDb(path.join(dir, 't.db'));
  return { db, dir, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}

export const kbErr = (fn: () => unknown): { status: number; message: string; docId: number | undefined } | null => {
  try {
    fn();
  } catch (e) {
    return { status: (e as { status: number }).status, message: (e as Error).message, docId: (e as { docId?: number }).docId };
  }
  return null;
};

export function seedReview(db: DB, input = '给中小律所的合同审查工具，按席位收费', content = '## 一句话结论\n值得做，定价按席位'): number {
  const id = Number(db.prepare("INSERT INTO pm_reviews(created_at, updated_at, status, mode, input) VALUES (1, 1, 'done', 'idea', ?)").run(input).lastInsertRowid);
  db.prepare("INSERT INTO pm_versions(review_id, n, created_at, source, content) VALUES (?, 1, 1, 'ai_initial', ?)").run(id, content);
  return id;
}

export function seedItem(db: DB, translation?: string): number {
  db.prepare("INSERT OR IGNORE INTO sources(id, name, url) VALUES ('s1', '源', 'https://s')").run();
  const sql =
    "INSERT INTO items(source_id, url, title, norm_title, published_at, fetched_at, content, title_zh, summary_zh, analysis_zh, translation_zh, translated_at) VALUES ('s1', ?, 'Pricing', '', 1, 1, 'original english body', '定价新闻', '摘要内容', '[\"要点一\",\"要点二\"]', ?, ?)";
  return Number(db.prepare(sql).run(`https://a.com/${Math.random()}`, translation ?? null, translation ? 2 : null).lastInsertRowid);
}
