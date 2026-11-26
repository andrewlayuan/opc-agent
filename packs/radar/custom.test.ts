import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';
import { syncSources } from './collect.ts';
import { SourceInputError, parseSourceInput, updateCustomSource } from './custom.ts';

function tmpDb(): { db: DB; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-custom-'));
  const db = openDb(path.join(dir, 't.db'));
  syncSources(db);
  return { db, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}
const addCustom = (db: DB) =>
  db
    .prepare("INSERT INTO sources(id, name, url, kind, grp, lang, filter, max_items, custom, etag, last_modified, last_error) VALUES ('custom-1', '旧名', 'https://a.example/feed', 'feed', 'custom', 'en', 0, 20, 1, 'E', 'M', 'boom')")
    .run();
const row = (db: DB) => db.prepare("SELECT name, url, lang, filter, etag, last_modified, last_error FROM sources WHERE id = 'custom-1'").get() as Record<string, unknown>;

test('parseSourceInput：只收 https、无凭据、无非标准端口、名称必填', () => {
  const ok = parseSourceInput({ name: '  名称  ', url: ' https://a.example/feed ', lang: 'zh', filter: true });
  assert.deepEqual([ok.name, ok.url.href, ok.lang, ok.filter], ['名称', 'https://a.example/feed', 'zh', 1]);
  assert.equal(parseSourceInput({ name: 'x', url: 'https://a.example:443/f' }).lang, 'en');
  const bads: Record<string, unknown>[] = [
    { url: 'http://a.example/f' },
    { url: 'ftp://a.example/f' },
    { url: 'https://u:p@a.example/f' },
    { url: 'https://a.example:8443/f' },
    { url: 'nonsense' },
    { url: 5 },
    {},
    { url: 'https://a.example/f', name: '   ' },
  ];
  for (const bad of bads) assert.throws(() => parseSourceInput({ name: 'x', ...bad }), SourceInputError, JSON.stringify(bad));
  assert.equal(parseSourceInput({ name: 'a'.repeat(200), url: 'https://a.example/f' }).name.length, 80);
});

test('updateCustomSource：改名称/语言/过滤；地址不变时保留缓存与错误，地址变化时清掉', () => {
  const { db, done } = tmpDb();
  addCustom(db);
  let r = updateCustomSource(db, 'custom-1', parseSourceInput({ name: '新名', url: 'https://a.example/feed', lang: 'zh', filter: true }));
  assert.equal(r.moved, false);
  assert.deepEqual({ ...row(db) }, { name: '新名', url: 'https://a.example/feed', lang: 'zh', filter: 1, etag: 'E', last_modified: 'M', last_error: 'boom' });
  r = updateCustomSource(db, 'custom-1', parseSourceInput({ name: '新名', url: 'https://b.example/rss' }));
  assert.equal(r.moved, true);
  assert.deepEqual({ ...row(db) }, { name: '新名', url: 'https://b.example/rss', lang: 'en', filter: 0, etag: null, last_modified: null, last_error: null });
  done();
});

test('updateCustomSource：内置源不能改（400），不存在的 404，且没有任何改动', () => {
  const { db, done } = tmpDb();
  const before = db.prepare("SELECT name, url FROM sources WHERE id = 'openai'").get();
  const input = parseSourceInput({ name: 'x', url: 'https://evil.example/f' });
  assert.throws(() => updateCustomSource(db, 'openai', input), (e: unknown) => e instanceof SourceInputError && e.status === 400);
  assert.throws(() => updateCustomSource(db, 'ghost', input), (e: unknown) => e instanceof SourceInputError && e.status === 404);
  assert.deepEqual(db.prepare("SELECT name, url FROM sources WHERE id = 'openai'").get(), before);
  done();
});
