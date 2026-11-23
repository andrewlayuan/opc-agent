import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DB } from '../../packages/core/db.ts';
import { tmpWikiDb } from './testutil.ts';

const count = (db: DB, sql: string, ...a: (string | number)[]) => Number((db.prepare(sql).get(...a) as { n: number }).n);

test('迁移 9：Wiki 各表存在，user_version=9', () => {
  const { db, done } = tmpWikiDb();
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 14);
  for (const t of ['wiki_pages', 'wiki_ops', 'wiki_revisions', 'wiki_links', 'wiki_cites', 'wiki_docs', 'wiki_assets', 'wiki_fts']) {
    assert.equal(count(db, 'SELECT count(*) AS n FROM sqlite_master WHERE name = ?', t), 1, t);
  }
  done();
});

test('迁移 9：wiki_fts 随页面插入、更新、软删除同步', () => {
  const { db, done } = tmpWikiDb();
  const id = Number(
    db.prepare("INSERT INTO wiki_pages(slug, kind, title, summary, body, created_at, updated_at) VALUES ('rag', 'concept', 'RAG', '摘要', '检索增强生成的做法', 1, 1)").run().lastInsertRowid,
  );
  const hit = (w: string) => count(db, 'SELECT count(*) AS n FROM wiki_fts WHERE wiki_fts MATCH ?', `"${w}"`);
  assert.equal(hit('检索增强'), 1);
  db.prepare("UPDATE wiki_pages SET body = '长上下文的做法' WHERE id = ?").run(id);
  assert.equal(hit('检索增强'), 0);
  assert.equal(hit('长上下文'), 1);
  db.prepare('UPDATE wiki_pages SET deleted = 1 WHERE id = ?').run(id);
  assert.equal(hit('长上下文'), 0);
  db.prepare('UPDATE wiki_pages SET deleted = 0 WHERE id = ?').run(id);
  assert.equal(hit('长上下文'), 1);
  db.prepare('DELETE FROM wiki_pages WHERE id = ?').run(id);
  assert.equal(count(db, 'SELECT count(*) AS n FROM wiki_fts'), 0);
  done();
});
