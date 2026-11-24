import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Llm } from '../../packages/core/llm.ts';
import { openZip } from '../pm/zip.ts';
import { createDoc, insertUpload, setBody } from './docs.ts';
import { csvField, exportKb, safeName } from './export.ts';
import { createFolder } from './folders.ts';
import { seedItem, seedReview, tmpKbDb } from './testutil.ts';
import { KbFiles } from './uploads.ts';

const llm = { enabled: false, chat: async () => '' } as unknown as Llm;
const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function setup() {
  const t = tmpKbDb();
  const kbDir = path.join(t.dir, 'kb');
  fs.mkdirSync(kbDir, { recursive: true });
  const files = new KbFiles(t.db, kbDir, llm, { log: () => {} });
  const tmpDir = path.join(t.dir, 'tmp');
  fs.mkdirSync(tmpDir);
  let n = 0;
  const upload = (title: string, fileName: string, data: Buffer | null, folderId: number | null = null, body = '提取的正文', now?: number) => {
    const storage = (++n).toString(16).padStart(32, '0');
    if (data) fs.writeFileSync(path.join(kbDir, storage), data);
    const id = insertUpload(t.db, { title, folderId, fileName, mime: 'application/pdf', size: data?.length ?? 1, storage }, now);
    setBody(t.db, id, body, now);
    return id;
  };
  const run = (max?: number) => {
    const r = exportKb(t.db, files, { tmpDir, ...(max != null ? { max } : {}) });
    const z = openZip(fs.readFileSync(r.file));
    return { ...r, zip: z, text: (name: string) => z.read(name).toString('utf8') };
  };
  return { ...t, files, tmpDir, upload, run };
}

test('safeName：去掉 \\/:*?"<>| 与控制字符、去首尾空白和点、空则「未命名」、最长 80 码点保留扩展名', () => {
  assert.equal(safeName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(safeName('x\u0000y\u001fz\u200b'), 'x y z');
  assert.equal(safeName('  ..隐藏. . '), '隐藏');
  assert.equal(safeName(''), '未命名');
  assert.equal(safeName(' ... ', '资料'), '资料');
  assert.equal(safeName('con'), '_con');
  assert.equal(safeName('NUL.txt'), '_NUL.txt');
  const long = safeName(`${'长'.repeat(100)}.pdf`);
  assert.equal([...long].length, 80);
  assert.equal(long, `${'长'.repeat(76)}.pdf`);
  assert.equal(safeName('长'.repeat(100)), '长'.repeat(80));
  assert.equal(safeName(`${'😀'.repeat(90)}.md`), `${'😀'.repeat(77)}.md`, '按码点截断，不切开代理对');
});

test('csvField：逗号引号换行转义；= + - @ 开头加单引号', () => {
  assert.equal(csvField('普通'), '普通');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('a\nb'), '"a\nb"');
  assert.equal(csvField('a\rb'), '"a\rb"');
  for (const c of ['=', '+', '-', '@']) assert.equal(csvField(`${c}1+1`), `'${c}1+1`);
  assert.equal(csvField('=a,b'), `"'=a,b"`);
  assert.equal(csvField(null), '');
  assert.equal(csvField(12), '12');
  assert.equal(csvField(-5), '-5', '数字不加单引号');
});

test('exportKb：目录结构、未归类在根目录、上传导出原文件逐字节一致、笔记评审资讯为「# 标题」开头的 .md', () => {
  const s = setup();
  try {
    const top = createFolder(s.db, '产品资料', null);
    const sub = createFolder(s.db, '竞品', top);
    createFolder(s.db, '空目录', null);
    const pdf = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
    s.upload('价格策略', 'price.pdf', pdf, sub);
    createDoc(s.db, { kind: 'note', title: '会议纪要', body: '## 议题\n定价', folderId: top });
    createDoc(s.db, { kind: 'review', reviewId: seedReview(s.db), folderId: top });
    createDoc(s.db, { kind: 'item', itemId: seedItem(s.db) });
    const r = s.run();
    assert.equal(r.count, 4);
    assert.equal(r.bytes, fs.statSync(r.file).size);
    assert.ok(path.dirname(r.file) === s.tmpDir);
    assert.deepEqual([...r.zip.names].sort(), [
      '产品资料/会议纪要.md',
      '产品资料/竞品/价格策略.pdf',
      '产品资料/给中小律所的合同审查工具，按席位收费.md',
      '定价新闻.md',
      '清单.csv',
    ].sort());
    assert.ok(r.zip.read('产品资料/竞品/价格策略.pdf').equals(pdf), '原文件逐字节一致');
    assert.equal(r.text('产品资料/会议纪要.md'), '# 会议纪要\n\n## 议题\n定价\n');
    assert.equal(r.text('产品资料/给中小律所的合同审查工具，按席位收费.md'), '# 给中小律所的合同审查工具，按席位收费\n\n## 一句话结论\n值得做，定价按席位\n');
    const item = r.text('定价新闻.md');
    assert.ok(item.startsWith('# 定价新闻\n\n来源：https://a.com/'), item);
    assert.ok(!item.slice(2).includes('# 定价新闻'), '资讯标题不重复');
    assert.match(item, /## 摘要\n摘要内容/);
  } finally {
    s.done();
  }
});

test('exportKb：同目录重名（含只差大小写的文件与子目录 Docs / docs）编号为「名称 (2)」', () => {
  const s = setup();
  try {
    const a = createFolder(s.db, 'Docs', null);
    const b = createFolder(s.db, 'docs', null);
    createDoc(s.db, { kind: 'note', title: '甲', body: '一', folderId: a });
    createDoc(s.db, { kind: 'note', title: '乙', body: '二', folderId: b });
    s.upload('Docs', 'Docs', Buffer.from('无扩展名'), null);
    createDoc(s.db, { kind: 'note', title: '报告', body: '第一份' });
    createDoc(s.db, { kind: 'note', title: '报告', body: '第二份' });
    s.upload('Readme', 'x.TXT', Buffer.from('1'), null);
    s.upload('readme', 'y.txt', Buffer.from('2'), null);
    createDoc(s.db, { kind: 'note', title: 'a/b', body: '斜杠' });
    const r = s.run();
    assert.deepEqual([...r.zip.names].filter((n) => n !== '清单.csv').sort(), ['Docs (3)', 'Docs/甲.md', 'Readme.TXT', 'a b.md', 'docs (2)/乙.md', 'readme (2).txt', '报告 (2).md', '报告.md'].sort());
    assert.equal(r.text('报告.md'), '# 报告\n\n第一份\n');
    assert.equal(r.text('报告 (2).md'), '# 报告\n\n第二份\n');
    assert.equal(r.text('Docs (3)'), '无扩展名', '目录已占用 docs (2)，文件顺延为 (3)');
  } finally {
    s.done();
  }
});

test('exportKb：原文件缺失时导出正文 .md 并在清单注明「原文件缺失，已导出正文」；error 状态的上传照常导出原文件', () => {
  const s = setup();
  try {
    s.upload('丢失', 'lost.docx', null, null, '提取到的正文');
    const bad = s.upload('坏', 'bad.pdf', Buffer.from('%PDF-坏'), null);
    s.db.prepare("UPDATE kb_docs SET status = 'error', error = '提取失败' WHERE id = ?").run(bad);
    const proc = s.upload('处理中', 'p.pdf', Buffer.from('%PDF-p'), null);
    s.db.prepare("UPDATE kb_docs SET status = 'processing' WHERE id = ?").run(proc);
    s.upload('好', 'ok.pdf', Buffer.from('%PDF-ok'), null);
    const r = s.run();
    assert.ok(r.zip.has('丢失.md') && !r.zip.has('丢失.docx'));
    assert.equal(r.text('丢失.md'), '# 丢失\n\n提取到的正文\n');
    assert.equal(r.text('坏.pdf'), '%PDF-坏');
    assert.equal(r.text('处理中.pdf'), '%PDF-p');
    const rows = r.text('清单.csv').slice(1).split('\r\n');
    const status = (p: string) => rows.find((l) => l.startsWith(`${p},`))?.split(',')[3];
    assert.equal(status('丢失.md'), '原文件缺失，已导出正文');
    assert.equal(status('坏.pdf'), '失败：提取失败');
    assert.equal(status('处理中.pdf'), '处理中');
    assert.equal(status('好.pdf'), '正常');
  } finally {
    s.done();
  }
});

test('exportKb：清单.csv 以 BOM 开头、列为 路径,标题,类型,状态,创建时间,更新时间,原文件名,大小', () => {
  const s = setup();
  try {
    const t1 = new Date(2026, 0, 2, 3, 4, 5).getTime();
    const t2 = new Date(2026, 10, 24, 13, 59, 0).getTime();
    const f = createFolder(s.db, '资料, 合集', null);
    s.upload('价格', 'price.pdf', Buffer.from('12345'), f, '正文', t1);
    createDoc(s.db, { kind: 'note', title: '=SUM(A1)', body: '正文' }, t2);
    const r = s.run();
    const raw = r.zip.read('清单.csv');
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = raw.subarray(3).toString('utf8');
    assert.ok(text.endsWith('\r\n'));
    const lines = text.split('\r\n');
    assert.equal(lines[0], '路径,标题,类型,状态,创建时间,更新时间,原文件名,大小');
    const md = Buffer.byteLength('# =SUM(A1)\n\n正文\n');
    assert.deepEqual(lines.slice(1, -1).sort(), [
      `"资料, 合集/价格.pdf",价格,上传,正常,${fmt(t1)},${fmt(t1)},price.pdf,5`,
      `'=SUM(A1).md,'=SUM(A1),笔记,正常,${fmt(t2)},${fmt(t2)},,${md}`,
    ].sort());
    assert.equal(lines.at(-1), '');
  } finally {
    s.done();
  }
});

test('exportKb：超过 max 抛 413 且临时文件被删除', () => {
  const s = setup();
  try {
    s.upload('大', 'big.pdf', randomBytes(5000), null);
    assert.throws(
      () => exportKb(s.db, s.files, { tmpDir: s.tmpDir, max: 1000 }),
      (e: Error & { status?: number }) => e.status === 413 && e.message.includes('1.5GB'),
    );
    assert.deepEqual(fs.readdirSync(s.tmpDir), []);
  } finally {
    s.done();
  }
});
