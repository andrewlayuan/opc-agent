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
