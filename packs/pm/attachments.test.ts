import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';
import type { ChatMessage, ContentPart, Llm } from '../../packages/core/llm.ts';
import { AttachmentError, AttachmentStore, LIMITS, sanitizeName } from './attachments.ts';
import type { AttachmentView } from './attachments.ts';
import type { ExecFn } from './extract.ts';
import { buildZip } from './zip.ts';

function tmpDb(): { db: DB; dir: string; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-att-'));
  const db = openDb(path.join(dir, 't.db'));
  return { db, dir, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}

test('迁移 6：pm_attachments 表、关联时写入 history_fts、删评审级联', () => {
  const { db, done } = tmpDb();
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 12);
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

// ---------------- AttachmentStore ----------------
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
type FakeLlm = { enabled: boolean; chat: (m: ChatMessage[], o?: Record<string, unknown>) => Promise<string> };
const describeLlm = (out = '图中写着：专业版 ¥99/月'): FakeLlm => ({ enabled: true, chat: async () => out });

function setupStore(llm: FakeLlm = describeLlm(), exec?: ExecFn, officeTimeoutMs?: number) {
  const t = tmpDb();
  const dir = path.join(t.dir, 'uploads');
  const store = new AttachmentStore(t.db, dir, llm as unknown as Llm, { log: () => {}, exec, officeTimeoutMs });
  return { ...t, store, uploads: dir };
}
function put(store: AttachmentStore, name: string, buf: Buffer | string, now?: number): AttachmentView {
  const tmp = store.tmpPath();
  fs.writeFileSync(tmp, buf);
  return store.create(tmp, name, now);
}
function errOf(fn: () => unknown): { status: number; message: string } {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof AttachmentError, String(e));
    return { status: e.status, message: e.message };
  }
  throw new Error('没有抛错');
}
const rowCount = (db: DB) => (db.prepare('SELECT count(*) AS n FROM pm_attachments').get() as { n: number }).n;
const review = (db: DB) => Number(db.prepare("INSERT INTO pm_reviews(created_at, updated_at, status, mode, input) VALUES (1, 1, 'done', 'idea', 'x')").run().lastInsertRowid);

test('sanitizeName：控制字符、路径符号、超长、空名', () => {
  assert.equal(sanitizeName('a/b\\c:*?"<>|\u0001.txt'), 'a_b_c_______.txt');
  assert.equal([...sanitizeName('字'.repeat(130))].length, 120);
  assert.equal(sanitizeName('\u0000'), '未命名');
  assert.equal(sanitizeName('  调研 😀.txt  '), '调研 😀.txt');
  assert.equal(sanitizeName('a\u202Etxt.exe'), 'atxt.exe');
});

test('create：txt 处理成 ready，文件 0600、目录 0700，存储名为 32 位十六进制', async () => {
  const { db, store, uploads, done } = setupStore();
  const v = put(store, '纪要.txt', 'abc');
  assert.equal(v.status, 'processing');
  await store.idle();
  const r = store.view(v.id)!;
  assert.deepEqual([r.status, r.chars, r.kind, r.mime, r.name, r.truncated], ['ready', 3, 'doc', 'text/plain', '纪要.txt', false]);
  const row = db.prepare('SELECT storage, text FROM pm_attachments WHERE id = ?').get(v.id) as { storage: string; text: string };
  assert.match(row.storage, /^[0-9a-f]{32}$/);
  assert.equal(row.text, 'abc');
  assert.equal(fs.statSync(path.join(uploads, row.storage)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(uploads).mode & 0o777, 0o700);
  assert.equal(fs.readdirSync(uploads).filter((n) => n.startsWith('tmp-')).length, 0);
  assert.equal(store.file(v.id)!.path, path.join(uploads, row.storage));
  done();
});

test('create：文档提取不到文字时标记为 error，不当作 ready', async () => {
  const { store, done } = setupStore();
  const v = put(store, '空白.txt', ' \n\t ');
  await store.idle();
  const r = store.view(v.id)!;
  assert.deepEqual([r.status, r.error], ['error', '未提取到文字内容']);
  done();
});

test('create：超 10MB 413、svg / 损坏 OLE / 无法解码的文本 415 时删除 tmp，不入库', () => {
  const { db, store, done } = setupStore();
  for (const [name, buf, status, msg] of [
    ['big.txt', Buffer.alloc(LIMITS.fileMax + 1, 0x61), 413, '单个文件最大 10MB'],
    ['a.svg', Buffer.from('<svg/>'), 415, '不支持的文件类型'],
    ['a.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2]), 415, '文件损坏或结构不支持'],
    ['bad.txt', Buffer.from([0x61, 0xff, 0xff]), 415, '请另存为 UTF-8 文本'],
    ['bad.html', Buffer.from([0x3c, 0x70, 0, 0x3e]), 415, '请另存为 UTF-8 文本'],
    ['late-nul.txt', Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]), 415, '请另存为 UTF-8 文本'],
  ] as const) {
    const tmp = store.tmpPath();
    fs.writeFileSync(tmp, buf);
    assert.deepEqual(errOf(() => store.create(tmp, name)), { status, message: msg });
    assert.equal(fs.existsSync(tmp), false);
  }
  assert.equal(rowCount(db), 0);
  done();
});

test('create：未关联附件达 40 个后返回 400；总量超 2GB 返回 413', async () => {
  const { db, store, done } = setupStore();
  for (let i = 0; i < LIMITS.pending; i++) put(store, `${i}.txt`, 'x');
  assert.deepEqual(errOf(() => put(store, 'x.txt', 'x')), { status: 400, message: '待发送的附件过多' });
  await store.idle();
  db.prepare('DELETE FROM pm_attachments WHERE id > 1').run();
  db.prepare('UPDATE pm_attachments SET size = 2147483647').run();
  assert.deepEqual(errOf(() => put(store, 'y.txt', 'xy')), { status: 413, message: '附件存储空间已满' });
  done();
});

test('create：图片调用模型生成描述，未配置模型时为 error', async () => {
  const seen: { m: ChatMessage[]; o?: Record<string, unknown> }[] = [];
  const llm: FakeLlm = { enabled: true, chat: async (m, o) => (seen.push({ m, o }), '  图中写着：专业版 ¥99/月  ' + '描'.repeat(2000)) };
  const a = setupStore(llm);
  const v = put(a.store, '定价.PNG', PNG);
  await a.store.idle();
  const content = seen[0].m[0].content as ContentPart[];
  assert.equal(seen[0].m[0].role, 'user');
  assert.match((content[0] as { text: string }).text, /^请识别这张图片：先原样转录图中所有文字/);
  assert.ok((content[1] as { image_url: { url: string } }).image_url.url.startsWith('data:image/png;base64,'));
  assert.deepEqual(seen[0].o, { maxTokens: 2000, temperature: 0.2, timeoutMs: 120000 });
  const r = a.store.view(v.id)!;
  assert.deepEqual([r.status, r.kind, r.chars, r.truncated], ['ready', 'image', 1500, true]);
  a.done();

  const b = setupStore({ enabled: false, chat: async () => '' });
  const w = put(b.store, 'a.png', PNG);
  await b.store.idle();
  assert.deepEqual([b.store.view(w.id)!.status, b.store.view(w.id)!.error], ['error', '未配置模型，无法识别图片']);
  b.done();
});

test('create：pdf 用注入的 exec，报错文案写入 error', async () => {
  const exec: ExecFn = async () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' }));
  const { store, done } = setupStore(describeLlm(), exec);
  const v = put(store, 'a.pdf', '%PDF-1.4\n...');
  await store.idle();
  assert.deepEqual([store.view(v.id)!.status, store.view(v.id)!.error], ['error', '服务器未安装 PDF 解析工具（poppler-utils）']);
  done();
});

test('remove：处理中删除后，处理完成不报错也不复活', async () => {
  let release: (s: string) => void = () => {};
  const llm: FakeLlm = { enabled: true, chat: () => new Promise<string>((r) => (release = r)) };
  const { db, store, uploads, done } = setupStore(llm);
  const v = put(store, 'a.png', PNG);
  const storage = (db.prepare('SELECT storage FROM pm_attachments WHERE id = ?').get(v.id) as { storage: string }).storage;
  await new Promise((r) => setTimeout(r, 10));
  store.remove(v.id);
  release('描述');
  await store.idle();
  assert.equal(rowCount(db), 0);
  assert.equal(fs.existsSync(path.join(uploads, storage)), false);
  done();
});

test('remove：已关联返回 409，不存在返回 404', async () => {
  const { db, store, done } = setupStore();
  const v = put(store, 'a.txt', 'x');
  await store.idle();
  db.prepare('UPDATE pm_attachments SET review_id = ? WHERE id = ?').run(review(db), v.id);
  assert.deepEqual(errOf(() => store.remove(v.id)), { status: 409, message: '附件已发送，不能单独删除' });
  assert.deepEqual(errOf(() => store.remove(999)), { status: 404, message: '附件不存在' });
  done();
});

test('validate：各种非法输入的状态码与文案', async () => {
  const { db, store, done } = setupStore();
  const ids = Array.from({ length: 9 }, (_, i) => put(store, `${i}.txt`, 'x').id);
  const img1 = put(store, 'a.png', PNG).id;
  const img2 = put(store, 'b.png', PNG).id;
  await store.idle();
  assert.deepEqual(store.validate([], null), []);
  for (const bad of ['1', [0], [1.5], [-1], [ids[0], ids[0]], null, [String(ids[0])]]) assert.deepEqual(errOf(() => store.validate(bad, null)), { status: 400, message: '附件参数不合法' });
  assert.deepEqual(errOf(() => store.validate(ids, null)), { status: 400, message: '一次最多 8 个附件' });
  assert.deepEqual(errOf(() => store.validate([9999], null)), { status: 400, message: '附件不存在' });
  db.prepare("UPDATE pm_attachments SET status = 'processing' WHERE id = ?").run(ids[1]);
  assert.deepEqual(errOf(() => store.validate([ids[0], ids[1]], null)), { status: 409, message: '附件还在处理' });
  db.prepare("UPDATE pm_attachments SET status = 'error' WHERE id = ?").run(ids[2]);
  assert.deepEqual(errOf(() => store.validate([ids[2]], null)), { status: 400, message: '附件处理失败，请移除后重新上传' });
  const rid = review(db);
  db.prepare('UPDATE pm_attachments SET review_id = ? WHERE id = ?').run(rid, ids[3]);
  assert.deepEqual(errOf(() => store.validate([ids[3]], null)), { status: 409, message: '附件已被使用' });
  db.prepare('UPDATE pm_attachments SET size = ? WHERE id = ?').run(15 * 1024 * 1024, img1);
  db.prepare('UPDATE pm_attachments SET size = ? WHERE id = ?').run(6 * 1024 * 1024, img2);
  assert.deepEqual(errOf(() => store.validate([img1, img2], null)), { status: 400, message: '图片合计不能超过 20MB' });
  for (let i = 0; i < 18; i++) db.prepare("INSERT INTO pm_attachments(created_at, review_id, name, mime, kind, size, storage, status) VALUES (1, ?, 'f', 'text/plain', 'doc', 1, ?, 'ready')").run(rid, `s${i}`);
  assert.deepEqual(errOf(() => store.validate([ids[4], ids[5]], rid)), { status: 400, message: '每个评审最多 20 个附件' });
  assert.deepEqual(store.validate([ids[5], ids[4]], null).map((r) => r.id), [ids[5], ids[4]]);
  assert.equal(store.validate([ids[4]], rid).length, 1);
  done();
});

test('claim：并发下第二次 claim 返回 409', async () => {
  const { db, store, done } = setupStore();
  const a = put(store, 'a.txt', 'x').id;
  await store.idle();
  const rows = store.validate([a], null);
  const r1 = review(db);
  const r2 = review(db);
  store.claim(rows, r1, null);
  assert.deepEqual(errOf(() => store.claim(rows, r2, null)), { status: 409, message: '附件已被使用' });
  assert.deepEqual(store.forReview(r1).map((r) => r.id), [a]);
  assert.equal(store.storagesOf(r1).length, 1);
  assert.deepEqual(store.forReview(r2), []);
  done();
});

test('recover：processing 改为 error', () => {
  const { db, store, done } = setupStore();
  db.prepare("INSERT INTO pm_attachments(created_at, name, mime, kind, size, storage, status) VALUES (1, 'a', 'text/plain', 'doc', 1, 'x1', 'processing')").run();
  assert.equal(store.recover(), 1);
  assert.deepEqual({ ...(db.prepare('SELECT status, error FROM pm_attachments').get() as object) }, { status: 'error', error: '服务重启，处理中断，请删除后重新上传' });
  done();
});

test('cleanup：删除超过 24 小时未关联的附件和无主文件，保留已关联的和新的', async () => {
  const { db, store, uploads, done } = setupStore();
  const now = Date.now();
  const linked = put(store, 'a.txt', 'x').id;
  const orphan = put(store, 'b.txt', 'y').id;
  const fresh = put(store, 'c.txt', 'z').id;
  await store.idle();
  db.prepare('UPDATE pm_attachments SET review_id = ?, created_at = ? WHERE id = ?').run(review(db), now - 30 * 3600e3, linked);
  db.prepare('UPDATE pm_attachments SET created_at = ? WHERE id = ?').run(now - 25 * 3600e3, orphan);
  const old = (now - 25 * 3600e3) / 1000;
  for (const n of ['f'.repeat(32), 'tmp-x']) {
    fs.writeFileSync(path.join(uploads, n), 'x');
    fs.utimesSync(path.join(uploads, n), old, old);
  }
  fs.writeFileSync(path.join(uploads, 'e'.repeat(32)), 'new');
  const storages = () => db.prepare('SELECT id, storage FROM pm_attachments ORDER BY id').all() as { id: number; storage: string }[];
  const before = storages();
  assert.deepEqual(store.cleanup(now), { rows: 1, files: 2 });
  assert.deepEqual(storages().map((r) => r.id), [linked, fresh]);
  for (const r of storages()) assert.ok(fs.existsSync(path.join(uploads, r.storage)));
  assert.equal(fs.existsSync(path.join(uploads, before.find((r) => r.id === orphan)!.storage)), false);
  assert.ok(fs.existsSync(path.join(uploads, 'e'.repeat(32))));
  done();
});

test('create：docx 在 worker 中提取；构造的未闭合标签超时后为 error，不卡主线程', async () => {
  const { store, done } = setupStore(describeLlm(), undefined, 300);
  const ok = put(store, '纪要.docx', buildZip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>用户最在意交付速度</w:t></w:r></w:p></w:body></w:document>' }));
  const bad = put(store, '炸弹.docx', buildZip({ 'word/document.xml': '<w:p>'.repeat(200000) }));
  let ticks = 0;
  const iv = setInterval(() => ticks++, 20);
  await store.idle();
  clearInterval(iv);
  assert.ok(ticks >= 5, `主线程应保持响应（ticks=${ticks}）`);
  assert.deepEqual([store.view(ok.id)!.status, store.view(ok.id)!.chars], ['ready', 9]);
  assert.deepEqual([store.view(bad.id)!.status, store.view(bad.id)!.error], ['error', '文件损坏或结构不支持']);
  done();
});
