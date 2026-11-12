import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';

function tmpDb(): { db: DB; dir: string; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-att-'));
  const db = openDb(path.join(dir, 't.db'));
  return { db, dir, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}

test('迁移 6：pm_attachments 表、关联时写入 history_fts、删评审级联', () => {
  const { db, done } = tmpDb();
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 6);
  const rid = Number(db.prepare("INSERT INTO pm_reviews(created_at, updated_at, status, mode, input) VALUES (1, 1, 'done', 'idea', '律所')").run().lastInsertRowid);
  const aid = Number(db.prepare("INSERT INTO pm_attachments(created_at, name, mime, kind, size, storage, status, text) VALUES (1, '纪要.docx', 'x', 'doc', 1, 'a1', 'ready', '用户最在意交付速度')").run().lastInsertRowid);
  const fts = () => db.prepare("SELECT body FROM history_fts WHERE kind = 'attachment'").all().map((r) => (r as { body: string }).body);
  assert.deepEqual(fts(), []);
  db.prepare('UPDATE pm_attachments SET review_id = ? WHERE id = ?').run(rid, aid);
  assert.deepEqual(fts(), ['纪要.docx\n用户最在意交付速度']);
  db.prepare('DELETE FROM pm_reviews WHERE id = ?').run(rid);
  assert.equal((db.prepare('SELECT count(*) AS n FROM pm_attachments').get() as { n: number }).n, 0);
  assert.deepEqual(fts(), []);
  done();
});
