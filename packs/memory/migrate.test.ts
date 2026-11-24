import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../../packages/core/db.ts';

const V5_DROP = `
  DROP TABLE IF EXISTS wiki_node_undo; DROP TABLE IF EXISTS wiki_page_node; DROP TABLE IF EXISTS wiki_nodes; DROP TABLE IF EXISTS kb_expand_calls; DROP TABLE IF EXISTS kb_expand; DROP TABLE IF EXISTS skill_runs; DROP TABLE IF EXISTS skill_revisions; DROP TABLE IF EXISTS skills; DROP TABLE IF EXISTS profile_versions;
  DROP TABLE IF EXISTS gr_revisions; DROP TABLE IF EXISTS gr_copies; DROP TABLE IF EXISTS gr_campaigns; DROP TABLE IF EXISTS cp_doc_revisions; DROP TABLE IF EXISTS cp_doc_sections; DROP TABLE IF EXISTS cp_docs; DROP TABLE IF EXISTS cp_entity;
  DROP TABLE IF EXISTS cp_items; DROP TABLE IF EXISTS cp_assessments; DROP TABLE IF EXISTS cp_products;
  DROP TABLE IF EXISTS wiki_fts; DROP TABLE IF EXISTS wiki_assets; DROP TABLE IF EXISTS wiki_docs; DROP TABLE IF EXISTS wiki_cites; DROP TABLE IF EXISTS wiki_links; DROP TABLE IF EXISTS wiki_revisions; DROP TABLE IF EXISTS wiki_ops; DROP TABLE IF EXISTS wiki_pages; DROP TABLE IF EXISTS pm_prototypes; DROP TABLE IF EXISTS kb_fts; DROP TABLE IF EXISTS kb_chunks; DROP TABLE IF EXISTS kb_docs; DROP TABLE IF EXISTS kb_folders;
  DROP TABLE IF EXISTS pm_attachments;
  DROP TRIGGER IF EXISTS pm_reviews_hi; DROP TRIGGER IF EXISTS pm_versions_hi; DROP TRIGGER IF EXISTS pm_messages_hi;
  DROP TRIGGER IF EXISTS pm_messages_hu; DROP TRIGGER IF EXISTS pm_reviews_hd;
  DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS memories; DROP TABLE IF EXISTS profile;
  DROP TABLE IF EXISTS memory_changes; DROP TABLE IF EXISTS history_fts;
  ALTER TABLE items DROP COLUMN relevance; ALTER TABLE items DROP COLUMN relevance_zh;
  ALTER TABLE pm_reviews DROP COLUMN context_refs; ALTER TABLE pm_messages DROP COLUMN context_refs; ALTER TABLE pm_messages DROP COLUMN skills;
  PRAGMA user_version = 4;
`;

test('迁移 5：新表、profile 单行、history_fts 触发器与回填', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-mig5-'));
  const file = path.join(dir, 't.db');
  openDb(file).close();
  // 回到第 4 版并写入已有数据，模拟线上升级
  const raw = new DatabaseSync(file);
  raw.exec(V5_DROP);
  raw.exec(`INSERT INTO pm_reviews(id, created_at, status, mode, input) VALUES (1, 1, 'done', 'idea', '给独立开发者的发票识别工具');
    INSERT INTO pm_versions(review_id, n, created_at, source, content) VALUES (1, 1, 1, 'ai_initial', '## 一句话结论\n值得做');
    INSERT INTO pm_messages(review_id, created_at, role, kind, content, status) VALUES (1, 1, 'user', 'ask', '定价怎么定比较合理', 'done');
    INSERT INTO pm_messages(review_id, created_at, role, kind, content, status) VALUES (1, 1, 'assistant', 'ask', '', 'error');`);
  raw.close();

  const db = openDb(file);
  const get = (sql: string) => db.prepare(sql).get() as Record<string, unknown>;
  const count = (where: string) => Number(get(`SELECT count(*) AS n FROM ${where}`).n);
  const run = (sql: string) => db.prepare(sql).run();

  assert.equal(get('PRAGMA user_version').user_version, 16);
  assert.deepEqual({ ...get('SELECT id, content, manual FROM profile') }, { id: 1, content: '', manual: 0 });
  for (const t of ['events', 'memories', 'memory_changes']) assert.equal(count(t), 0);
  assert.equal(count('history_fts WHERE review_id = 1'), 3);
  for (const col of ['relevance', 'relevance_zh']) assert.ok((db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).some((c) => c.name === col));

  run("INSERT INTO pm_reviews(id, created_at, status, mode, input) VALUES (2, 2, 'done', 'idea', '面向中小律所的合同审查')");
  assert.equal(count(`history_fts WHERE history_fts MATCH '"合同审查"'`), 1);
  run("INSERT INTO pm_versions(review_id, n, created_at, source, content) VALUES (2, 1, 2, 'ai_initial', '律所版本正文')");
  run("INSERT INTO pm_messages(id, review_id, created_at, role, kind, content, status) VALUES (50, 2, 2, 'assistant', 'ask', '', 'running')");
  assert.equal(count("history_fts WHERE review_id = 2 AND kind = 'message'"), 0);
  run("UPDATE pm_messages SET content = '先按席位收费', status = 'done' WHERE id = 50");
  assert.equal(count("history_fts WHERE review_id = 2 AND kind = 'message'"), 1);
  run("INSERT INTO pm_messages(id, review_id, created_at, role, kind, content, status) VALUES (51, 2, 2, 'assistant', 'ask', '', 'running')");
  run("UPDATE pm_messages SET status = 'error', error = 'x' WHERE id = 51");
  assert.equal(count("history_fts WHERE review_id = 2 AND kind = 'message'"), 1);
  assert.deepEqual(
    (db.prepare('SELECT kind FROM history_fts WHERE review_id = 2 ORDER BY rowid').all() as { kind: string }[]).map((r) => r.kind),
    ['input', 'version', 'message'],
  );

  run('DELETE FROM pm_reviews WHERE id = 1');
  assert.equal(count('history_fts WHERE review_id = 1'), 0);
  assert.equal(count('history_fts WHERE review_id = 2'), 3);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
