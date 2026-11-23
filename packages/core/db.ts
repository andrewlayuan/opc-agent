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
  `
  CREATE TABLE pm_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    review_id INTEGER REFERENCES pm_reviews(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES pm_messages(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL,
    storage TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'processing',
    text TEXT NOT NULL DEFAULT '',
    orig_chars INTEGER,
    error TEXT
  );
  CREATE INDEX pm_attachments_review ON pm_attachments(review_id, message_id, id);
  CREATE INDEX pm_attachments_orphan ON pm_attachments(created_at) WHERE review_id IS NULL;
  CREATE TRIGGER pm_attachments_hl AFTER UPDATE OF review_id ON pm_attachments
    WHEN old.review_id IS NULL AND new.review_id IS NOT NULL AND new.text != '' BEGIN
    INSERT INTO history_fts(review_id, kind, body) VALUES (new.review_id, 'attachment', new.name || char(10) || new.text);
  END;
  `,
  `
  CREATE TABLE kb_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER REFERENCES kb_folders(id),
    name TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX kb_folders_name ON kb_folders(coalesce(parent_id, 0), name);

  CREATE TABLE kb_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id INTEGER REFERENCES kb_folders(id),
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',
    error TEXT,
    body TEXT NOT NULL DEFAULT '',
    review_id INTEGER UNIQUE,
    item_id INTEGER UNIQUE,
    indexed_rev TEXT,
    truncated INTEGER NOT NULL DEFAULT 0,
    file_name TEXT,
    file_mime TEXT,
    file_size INTEGER,
    storage TEXT UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX kb_docs_folder ON kb_docs(folder_id, updated_at DESC);

  CREATE TABLE kb_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL REFERENCES kb_docs(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    heading TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    UNIQUE (doc_id, ord)
  );
  -- 普通 FTS5 表，rowid = kb_chunks.id，索引标题与正文
  CREATE VIRTUAL TABLE kb_fts USING fts5(body, tokenize='trigram');
  CREATE TRIGGER kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
    INSERT INTO kb_fts(rowid, body) VALUES (new.id, new.heading || char(10) || new.body);
  END;
  CREATE TRIGGER kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
    DELETE FROM kb_fts WHERE rowid = old.id;
  END;
  CREATE TRIGGER kb_chunks_au AFTER UPDATE ON kb_chunks BEGIN
    DELETE FROM kb_fts WHERE rowid = old.id;
    INSERT INTO kb_fts(rowid, body) VALUES (new.id, new.heading || char(10) || new.body);
  END;
  `,
  // 8：PRD 原型版本。每版一份完整快照（大纲 + 各页清理后的 HTML），随评审删除
  `
  CREATE TABLE pm_prototypes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id INTEGER NOT NULL REFERENCES pm_reviews(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL DEFAULT 'running',
    base_version_n INTEGER NOT NULL,
    from_n INTEGER,
    request TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    progress TEXT NOT NULL DEFAULT '{"stage":"queued","done":0,"total":0}',
    outline TEXT NOT NULL DEFAULT 'null',
    pages TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    UNIQUE (review_id, n)
  );
  CREATE INDEX pm_prototypes_review ON pm_prototypes(review_id, n);
  `,
  // 9：LLM Wiki 知识层。页面软删除；wiki_fts 只收录未删除的页面
  `
  CREATE TABLE wiki_pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    source_doc INTEGER UNIQUE REFERENCES kb_docs(id) ON DELETE SET NULL,
    edited_by_user INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    rev INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX wiki_pages_kind ON wiki_pages(kind, updated_at DESC);

  CREATE TABLE wiki_ops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    doc_id INTEGER,
    target_op INTEGER,
    status TEXT NOT NULL DEFAULT 'queued',
    pages TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    error TEXT,
    llm_calls INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX wiki_ops_status ON wiki_ops(status, id);
  CREATE INDEX wiki_ops_created ON wiki_ops(created_at);

  CREATE TABLE wiki_revisions (
    page_id INTEGER NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
    rev INTEGER NOT NULL,
    op_id INTEGER REFERENCES wiki_ops(id),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    body TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (page_id, rev)
  );

  CREATE TABLE wiki_links (
    from_page INTEGER NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
    to_slug TEXT NOT NULL,
    PRIMARY KEY (from_page, to_slug)
  );
  CREATE INDEX wiki_links_to ON wiki_links(to_slug);

  CREATE TABLE wiki_cites (
    page_id INTEGER NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
    doc_id INTEGER NOT NULL,
    ord INTEGER NOT NULL,
    PRIMARY KEY (page_id, doc_id, ord)
  );
  CREATE INDEX wiki_cites_doc ON wiki_cites(doc_id);

  CREATE TABLE wiki_docs (
    doc_id INTEGER PRIMARY KEY,
    body_hash TEXT NOT NULL,
    state TEXT NOT NULL,
    fails INTEGER NOT NULL DEFAULT 0,
    ingested_at INTEGER NOT NULL
  );

  CREATE TABLE wiki_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id INTEGER REFERENCES wiki_pages(id) ON DELETE SET NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    storage TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE VIRTUAL TABLE wiki_fts USING fts5(title, summary, body, tokenize='trigram');
  CREATE TRIGGER wiki_pages_ai AFTER INSERT ON wiki_pages WHEN new.deleted = 0 BEGIN
    INSERT INTO wiki_fts(rowid, title, summary, body) VALUES (new.id, new.title, new.summary, new.body);
  END;
  CREATE TRIGGER wiki_pages_ad AFTER DELETE ON wiki_pages BEGIN
    DELETE FROM wiki_fts WHERE rowid = old.id;
  END;
  CREATE TRIGGER wiki_pages_au AFTER UPDATE ON wiki_pages BEGIN
    DELETE FROM wiki_fts WHERE rowid = old.id;
    INSERT INTO wiki_fts(rowid, title, summary, body) SELECT new.id, new.title, new.summary, new.body WHERE new.deleted = 0;
  END;
  `,

  // 10：追问时追加的框架，记在该轮 user 消息上
  `ALTER TABLE pm_messages ADD COLUMN skills TEXT;`,

  // 11：合规台账。产品 → 判定快照 → 事项；重新判定只增补，不覆盖手填字段
  `
  CREATE TABLE cp_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    review_id INTEGER REFERENCES pm_reviews(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE cp_assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES cp_products(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    rules_version INTEGER NOT NULL,
    answers TEXT NOT NULL,
    prefilled TEXT,
    result TEXT NOT NULL
  );
  CREATE INDEX cp_assessments_product ON cp_assessments(product_id, id);
  CREATE TABLE cp_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES cp_products(id) ON DELETE CASCADE,
    item TEXT NOT NULL,
    level TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo',
    stale INTEGER NOT NULL DEFAULT 0,
    ref_no TEXT,
    done_at INTEGER,
    due_at INTEGER,
    remind_at INTEGER,
    note TEXT,
    na_reason TEXT,
    explain TEXT,
    assessment_id INTEGER REFERENCES cp_assessments(id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (product_id, item)
  );
  `,
  // 12：合规材料起草——全局主体（单行）、产品资料列、材料、章、章版本
  `
  CREATE TABLE cp_entity (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated_at INTEGER NOT NULL);
  ALTER TABLE cp_products ADD COLUMN facts TEXT NOT NULL DEFAULT '{}';
  CREATE TABLE cp_docs (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES cp_products(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    template_version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final')),
    finalized_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (product_id, kind)
  );
  CREATE TABLE cp_doc_sections (
    id INTEGER PRIMARY KEY,
    doc_id INTEGER NOT NULL REFERENCES cp_docs(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    ord INTEGER NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    rev INTEGER NOT NULL DEFAULT 0,
    origin TEXT,
    input_hash TEXT,
    removed INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    UNIQUE (doc_id, key)
  );
  CREATE TABLE cp_doc_revisions (
    id INTEGER PRIMARY KEY,
    section_id INTEGER NOT NULL REFERENCES cp_doc_sections(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    body TEXT NOT NULL,
    origin TEXT NOT NULL,
    input_hash TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (section_id, n)
  );
  `,
  // 13: 运营——投放、平台文案、文案版本
  `
  CREATE TABLE gr_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    product_id INTEGER REFERENCES cp_products(id) ON DELETE SET NULL,
    product_name TEXT NOT NULL,
    product_desc TEXT NOT NULL DEFAULT '',
    points TEXT NOT NULL,
    audience TEXT NOT NULL DEFAULT '',
    offer TEXT NOT NULL DEFAULT '',
    tone TEXT NOT NULL DEFAULT 'warm',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE gr_copies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES gr_campaigns(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    rev INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    kept TEXT NOT NULL DEFAULT '{}',
    gen_hash TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (campaign_id, platform)
  );
  CREATE TABLE gr_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    copy_id INTEGER NOT NULL REFERENCES gr_copies(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    origin TEXT NOT NULL,
    fields TEXT NOT NULL,
    review TEXT,
    review_base INTEGER,
    reviewed_at INTEGER,
    UNIQUE (copy_id, n)
  );
  CREATE INDEX gr_copies_campaign ON gr_copies(campaign_id);
  `,
  // 14：技能沉淀与画像版本
  `CREATE TABLE skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    scene TEXT NOT NULL,
    steps TEXT NOT NULL DEFAULT '[]',
    cautions TEXT NOT NULL DEFAULT '[]',
    example TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'candidate',
    manual INTEGER NOT NULL DEFAULT 0,
    pending TEXT,
    uses INTEGER NOT NULL DEFAULT 0,
    hits INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX skills_status ON skills(status, updated_at DESC);
  -- 每次沉淀一行：事件游标（upto_event）、每日预算计数与运行记录
  CREATE TABLE skill_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    upto_event INTEGER NOT NULL DEFAULT 0,
    events INTEGER NOT NULL DEFAULT 0,
    added INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0,
    dropped INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE TABLE skill_revisions (
    skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    rev INTEGER NOT NULL,
    content TEXT NOT NULL,
    origin TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (skill_id, rev)
  );
  CREATE TABLE profile_versions (
    rev INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    origin TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    event_ids TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  `,
  // 15：知识库查询扩写的缓存与每日调用记录
  `
  CREATE TABLE kb_expand (
    key TEXT PRIMARY KEY,
    terms TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE kb_expand_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    ok INTEGER NOT NULL
  );
  CREATE INDEX kb_expand_calls_at ON kb_expand_calls(at);
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
