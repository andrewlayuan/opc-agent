import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';

export function tmpKbDb(): { db: DB; dir: string; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-kb-'));
  const db = openDb(path.join(dir, 't.db'));
  return { db, dir, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}

const count = (db: DB, sql: string, ...a: (string | number)[]) => (db.prepare(sql).get(...a) as { n: number }).n;

test('迁移 7：知识库四张表、分块写入 kb_fts（含标题）、删条目级联清索引', () => {
  const { db, done } = tmpKbDb();
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 7);
  for (const t of ['kb_folders', 'kb_docs', 'kb_chunks', 'kb_fts']) {
    assert.equal(count(db, "SELECT count(*) AS n FROM sqlite_master WHERE name = ?", t), 1, t);
  }
  const doc = Number(db.prepare("INSERT INTO kb_docs(kind, title, body, created_at, updated_at) VALUES ('note', '竞品', 'x', 1, 1)").run().lastInsertRowid);
  db.prepare("INSERT INTO kb_chunks(doc_id, ord, heading, body) VALUES (?, 0, '定价策略', '按席位收费')").run(doc);
  assert.equal(count(db, `SELECT count(*) AS n FROM kb_fts WHERE kb_fts MATCH '"定价策"'`), 1);
  assert.equal(count(db, `SELECT count(*) AS n FROM kb_fts WHERE kb_fts MATCH '"按席位"'`), 1);
  db.prepare("UPDATE kb_chunks SET body = '按用量收费' WHERE doc_id = ?").run(doc);
  assert.equal(count(db, `SELECT count(*) AS n FROM kb_fts WHERE kb_fts MATCH '"按席位"'`), 0);
  assert.equal(count(db, `SELECT count(*) AS n FROM kb_fts WHERE kb_fts MATCH '"按用量"'`), 1);
  db.prepare('DELETE FROM kb_docs WHERE id = ?').run(doc);
  assert.equal(count(db, 'SELECT count(*) AS n FROM kb_chunks'), 0);
  assert.equal(count(db, 'SELECT count(*) AS n FROM kb_fts'), 0);
  assert.equal(count(db, "SELECT count(*) AS n FROM pragma_table_info('kb_docs') WHERE name = 'truncated'"), 1);
  done();
});

test('迁移 7：同一来源只能入库一次；同层目录不能重名（含顶层）', () => {
  const { db, done } = tmpKbDb();
  const ins = db.prepare("INSERT INTO kb_docs(kind, title, review_id, created_at, updated_at) VALUES ('review', 't', 7, 1, 1)");
  ins.run();
  assert.throws(() => ins.run(), /UNIQUE/);
  const f = db.prepare('INSERT INTO kb_folders(parent_id, name, created_at) VALUES (?, ?, 1)');
  const top = Number(f.run(null, '产品').lastInsertRowid);
  assert.throws(() => f.run(null, '产品'), /UNIQUE/);
  f.run(top, '竞品');
  assert.throws(() => f.run(top, '竞品'), /UNIQUE/);
  f.run(null, '竞品');
  done();
});
