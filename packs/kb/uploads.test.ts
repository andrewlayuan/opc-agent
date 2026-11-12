import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Llm } from '../../packages/core/llm.ts';
import { buildZip } from '../pm/zip.ts';
import { getDoc } from './docs.ts';
import { tmpKbDb } from './testutil.ts';
import { KbFiles } from './uploads.ts';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.alloc(32)]);
type Fake = { enabled: boolean; chat: () => Promise<string> };
const llmOf = (out = '图中写着：专业版 ¥99/月', enabled = true): Fake => ({ enabled, chat: async () => out });

function setup(llm: Fake = llmOf()) {
  const t = tmpKbDb();
  const dir = path.join(t.dir, 'kb');
  const files = new KbFiles(t.db, dir, llm as unknown as Llm, { log: () => {} });
  const put = (name: string, buf: Buffer | string, folder: number | null = null) => {
    const tmp = files.tmpPath();
    fs.writeFileSync(tmp, buf);
    return files.create(tmp, name, folder);
  };
  return { ...t, files, dir, put };
}
const errOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return { status: (e as { status: number }).status, message: (e as Error).message };
  }
  return null;
};
const tmps = (dir: string) => fs.readdirSync(dir).filter((n) => n.startsWith('tmp-')).length;

test('上传：txt 与 docx 处理成 ready；文件 0600、目录 0700；标题为去扩展名的文件名', async () => {
  const { db, files, dir, put, done } = setup();
  const a = put('定价调研.txt', '# 结论\n按席位收费');
  assert.equal(a.status, 'processing');
  assert.equal(a.title, '定价调研');
  const xml = '<w:document><w:body><w:p><w:r><w:t>竞品甲按用量收费</w:t></w:r></w:p></w:body></w:document>';
  const b = put('竞品.docx', buildZip({ 'word/document.xml': xml }));
  await files.idle();
  const da = getDoc(db, a.id)!;
  assert.equal(da.doc.status, 'ready');
  assert.deepEqual(da.chunks, [{ ord: 0, heading: '结论', body: '按席位收费' }]);
  assert.equal(da.doc.file_name, '定价调研.txt');
  assert.equal(getDoc(db, b.id)!.body, '竞品甲按用量收费');
  const f = files.file(a.id)!;
  assert.equal(fs.statSync(f.path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(f.name, '定价调研.txt');
  assert.equal(tmps(dir), 0);
  done();
});

test('上传：空白文本、超过 20 万字标记为 error', async () => {
  const { db, files, put, done } = setup();
  const a = put('空.txt', ' \n\t ');
  const b = put('长.txt', '字'.repeat(200_001));
  await files.idle();
  assert.deepEqual([getDoc(db, a.id)!.doc.status, getDoc(db, a.id)!.doc.error], ['error', '未提取到文字内容']);
  assert.deepEqual([getDoc(db, b.id)!.doc.status, getDoc(db, b.id)!.doc.error], ['error', '正文超过 20 万字，请拆分后上传']);
  done();
});

test('上传：svg 415、超 10MB 413、超总容量 413；失败不入库且删 tmp', () => {
  const { db, dir, put, done } = setup();
  assert.deepEqual(errOf(() => put('a.svg', '<svg/>')), { status: 415, message: errOf(() => put('b.svg', '<svg/>'))!.message });
  assert.equal(errOf(() => put('big.txt', Buffer.alloc(10 * 1024 * 1024 + 1, 0x61)))!.status, 413);
  db.prepare("INSERT INTO kb_docs(kind, title, status, file_size, storage, created_at, updated_at) VALUES ('upload', 'x', 'ready', ?, 'zz', 1, 1)").run(1024 * 1024 * 1024 - 5);
  assert.deepEqual(errOf(() => put('c.txt', '0123456789')), { status: 413, message: '知识库存储空间已满' });
  assert.equal(Number((db.prepare('SELECT count(*) AS n FROM kb_docs').get() as { n: number }).n), 1);
  assert.equal(tmps(dir), 0);
  assert.equal(fs.readdirSync(dir).length, 0);
  assert.equal(errOf(() => put('d.txt', 'x', 999))!.status, 404);
  assert.equal(fs.readdirSync(dir).length, 0);
  done();
});

test('上传：图片用模型描述；没有配置模型时报错', async () => {
  const ok = setup();
  const a = ok.put('截图.png', PNG);
  await ok.files.idle();
  assert.deepEqual([getDoc(ok.db, a.id)!.doc.status, getDoc(ok.db, a.id)!.body], ['ready', '图中写着：专业版 ¥99/月']);
  ok.done();
  const no = setup(llmOf('', false));
  const b = no.put('截图.png', PNG);
  await no.files.idle();
  assert.deepEqual([getDoc(no.db, b.id)!.doc.status, getDoc(no.db, b.id)!.doc.error], ['error', '未配置模型，无法识别图片']);
  no.done();
});

test('上传：处理中被删除不报错；recover 把 processing 置 error 并删 tmp', async () => {
  let release!: (s: string) => void;
  const slow: Fake = { enabled: true, chat: () => new Promise<string>((r) => (release = r)) };
  const { db, files, dir, put, done } = setup(slow);
  const a = put('图.png', PNG);
  await new Promise((r) => setTimeout(r, 20));
  db.prepare('DELETE FROM kb_docs WHERE id = ?').run(a.id);
  release('描述');
  await files.idle();
  assert.equal(getDoc(db, a.id), null);
  const b = put('b.txt', 'x');
  db.prepare("UPDATE kb_docs SET status = 'processing' WHERE id = ?").run(b.id);
  await files.idle();
  db.prepare("UPDATE kb_docs SET status = 'processing' WHERE id = ?").run(b.id);
  fs.writeFileSync(path.join(dir, 'tmp-abc'), 'x');
  files.recover();
  assert.deepEqual([getDoc(db, b.id)!.doc.status, getDoc(db, b.id)!.doc.error], ['error', '服务重启，处理中断，请删除后重新上传']);
  assert.equal(tmps(dir), 0);
  done();
});
