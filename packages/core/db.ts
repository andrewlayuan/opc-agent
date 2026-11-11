import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'feed',
    grp TEXT NOT NULL DEFAULT 'media',
    lang TEXT NOT NULL DEFAULT 'en',
    filter INTEGER NOT NULL DEFAULT 0,
    max_items INTEGER NOT NULL DEFAULT 30,
    enabled INTEGER NOT NULL DEFAULT 1,
    custom INTEGER NOT NULL DEFAULT 0,
    etag TEXT,
    last_modified TEXT,
    last_fetch_at INTEGER,
    last_ok_at INTEGER,
    last_error TEXT,
    item_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL REFERENCES sources(id),
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    norm_title TEXT NOT NULL,
    author TEXT,
    published_at INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    lang TEXT NOT NULL DEFAULT 'en',
    topics TEXT NOT NULL DEFAULT '[]',
    dup_of INTEGER,
    title_zh TEXT,
    summary_zh TEXT,
    analysis_zh TEXT,
    importance INTEGER,
    analyzed_at INTEGER,
    analysis_error TEXT,
    translation_zh TEXT,
    translated_at INTEGER,
    starred INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX items_pub ON items(published_at DESC);
  CREATE INDEX items_source ON items(source_id, published_at DESC);
  CREATE INDEX items_pending ON items(analyzed_at, published_at DESC);
  CREATE VIRTUAL TABLE items_fts USING fts5(
    title, content, title_zh, summary_zh,
    content='items', content_rowid='id', tokenize='trigram'
  );
  CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
    INSERT INTO items_fts(rowid, title, content, title_zh, summary_zh)
    VALUES (new.id, new.title, new.content, coalesce(new.title_zh,''), coalesce(new.summary_zh,''));
  END;
  CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, title, content, title_zh, summary_zh)
    VALUES ('delete', old.id, old.title, old.content, coalesce(old.title_zh,''), coalesce(old.summary_zh,''));
  END;
  CREATE TRIGGER items_au AFTER UPDATE OF title, content, title_zh, summary_zh ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, title, content, title_zh, summary_zh)
    VALUES ('delete', old.id, old.title, old.content, coalesce(old.title_zh,''), coalesce(old.summary_zh,''));
    INSERT INTO items_fts(rowid, title, content, title_zh, summary_zh)
    VALUES (new.id, new.title, new.content, coalesce(new.title_zh,''), coalesce(new.summary_zh,''));
  END;
  CREATE TABLE runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    ok_sources INTEGER NOT NULL DEFAULT 0,
    failed_sources INTEGER NOT NULL DEFAULT 0,
    new_items INTEGER NOT NULL DEFAULT 0,
    analyzed INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE TABLE briefs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    period_start INTEGER NOT NULL,
    period_end INTEGER NOT NULL,
    content TEXT NOT NULL,
    item_ids TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE sources ADD COLUMN reach_args TEXT;
  ALTER TABLE items ADD COLUMN fulltext_at INTEGER;
  ALTER TABLE items ADD COLUMN fulltext_error TEXT;
  `,
  `
  ALTER TABLE items ADD COLUMN topics_rev TEXT;
  CREATE TABLE prefs (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE pm_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL DEFAULT 'running',
    mode TEXT NOT NULL,
    input TEXT NOT NULL,
    skills TEXT NOT NULL DEFAULT '[]',
    content TEXT,
    item_ids TEXT NOT NULL DEFAULT '[]',
    error TEXT
  );
  CREATE INDEX pm_reviews_created ON pm_reviews(created_at DESC);
  `,
  `
  CREATE TABLE pm_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id INTEGER NOT NULL REFERENCES pm_reviews(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    version_n INTEGER,
    status TEXT NOT NULL DEFAULT 'done',
    error TEXT
  );
  CREATE INDEX pm_messages_review ON pm_messages(review_id, id);
  CREATE TABLE pm_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id INTEGER NOT NULL REFERENCES pm_reviews(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    content TEXT NOT NULL,
    message_id INTEGER,
    note TEXT,
    UNIQUE (review_id, n)
  );
  ALTER TABLE pm_reviews ADD COLUMN updated_at INTEGER;
  INSERT INTO pm_versions(review_id, n, created_at, source, content)
    SELECT id, 1, coalesce(finished_at, created_at), 'ai_initial', content
    FROM pm_reviews WHERE status = 'done' AND content IS NOT NULL;
  UPDATE pm_reviews SET updated_at = coalesce(finished_at, created_at);
  `,
  `
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ref_type TEXT,
    ref_id INTEGER,
    summary TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    consumed_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX events_pending ON events(consumed_at, id);
  CREATE INDEX events_ref ON events(kind, ref_type, ref_id, at);
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    manual INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER
  );
  CREATE TABLE profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    content TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    manual INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO profile(id, content, updated_at) VALUES (1, '', 0);
  CREATE TABLE memory_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    op TEXT NOT NULL,
    memory_id INTEGER,
    kind TEXT,
    before TEXT,
    after TEXT,
    reason TEXT,
    source TEXT NOT NULL,
    event_ids TEXT NOT NULL DEFAULT '[]',
    undone_at INTEGER
  );
  CREATE INDEX memory_changes_at ON memory_changes(at DESC);
  CREATE VIRTUAL TABLE history_fts USING fts5(review_id UNINDEXED, kind UNINDEXED, body, tokenize='trigram');
  CREATE TRIGGER pm_reviews_hi AFTER INSERT ON pm_reviews BEGIN
    INSERT INTO history_fts(review_id, kind, body) VALUES (new.id, 'input', new.input);
  END;
  CREATE TRIGGER pm_versions_hi AFTER INSERT ON pm_versions BEGIN
    INSERT INTO history_fts(review_id, kind, body) VALUES (new.review_id, 'version', new.content);
  END;
  CREATE TRIGGER pm_messages_hi AFTER INSERT ON pm_messages WHEN new.status = 'done' AND new.content != '' BEGIN
    INSERT INTO history_fts(review_id, kind, body) VALUES (new.review_id, 'message', new.content);
  END;
  CREATE TRIGGER pm_messages_hu AFTER UPDATE OF status ON pm_messages
    WHEN new.status = 'done' AND old.status != 'done' AND new.content != '' BEGIN
    INSERT INTO history_fts(review_id, kind, body) VALUES (new.review_id, 'message', new.content);
  END;
  CREATE TRIGGER pm_reviews_hd AFTER DELETE ON pm_reviews BEGIN
    DELETE FROM history_fts WHERE review_id = old.id;
  END;
  INSERT INTO history_fts(review_id, kind, body) SELECT id, 'input', input FROM pm_reviews;
  INSERT INTO history_fts(review_id, kind, body) SELECT review_id, 'version', content FROM pm_versions ORDER BY id;
  INSERT INTO history_fts(review_id, kind, body) SELECT review_id, 'message', content FROM pm_messages WHERE status = 'done' AND content != '' ORDER BY id;
  ALTER TABLE items ADD COLUMN relevance INTEGER;
  ALTER TABLE items ADD COLUMN relevance_zh TEXT;
  ALTER TABLE pm_reviews ADD COLUMN context_refs TEXT;
  ALTER TABLE pm_messages ADD COLUMN context_refs TEXT;
  `,
];

export type DB = DatabaseSync;

export function openDb(dbPath: string, opts: { readOnly?: boolean } = {}): DB {
  if (opts.readOnly) {
    return new DatabaseSync(dbPath, { readOnly: true });
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  let v = row.user_version;
  while (v < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      v++;
      db.exec(`PRAGMA user_version = ${v}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
