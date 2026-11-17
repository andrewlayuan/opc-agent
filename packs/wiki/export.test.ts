import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { DB } from '../../packages/core/db.ts';
import { createDoc } from '../kb/docs.ts';
import { createFolder } from '../kb/folders.ts';
import { exportWiki, pageToHtml, pageToMarkdown, parseScope, safeName } from './export.ts';
import { createOp, finishOp, getPageRow, tx, writePages } from './store.ts';
import type { PageDraft } from './store.ts';
import { seedDoc, tmpWikiDb } from './testutil.ts';
import { WikiError } from './types.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

const put = (db: DB, drafts: PageDraft[]) =>
  tx(db, () => {
    const id = createOp(db, 'edit', { status: 'running' });
    finishOp(db, id, { status: 'done', pages: writePages(db, id, drafts).changes });
  });
const pg = (slug: string, title: string, body: string, kind: PageDraft['kind'] = 'concept', sourceDoc?: number): PageDraft => ({ slug, kind, title, summary: `${title}摘要`, body, sourceDoc });

function setup() {
  const t = tmpWikiDb();
  const assetsDir = path.join(t.dir, 'assets');
  const tmpDir = path.join(t.dir, 'tmp');
  fs.mkdirSync(assetsDir);
  fs.mkdirSync(tmpDir);
  return { ...t, assetsDir, tmpDir };
}
const names = (file: string) => execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).trim().split('\n');
const entry = (file: string, n: string) => execFileSync('unzip', ['-p', file, n], { encoding: 'utf8' });
const addAsset = (db: DB, dir: string, pageSlug: string): number => {
  const storage = `${crypto.randomUUID()}.png`;
  fs.writeFileSync(path.join(dir, storage), PNG);
  const pid = getPageRow(db, pageSlug)!.id;
  return Number(db.prepare('INSERT INTO wiki_assets(page_id, mime, size, storage, created_at) VALUES (?, ?, ?, ?, ?)').run(pid, 'image/png', PNG.length, storage, Date.now()).lastInsertRowid);
};

test('parseScope：只接受 all、kind:<kind>、folder:<正整数>', () => {
  assert.deepEqual(parseScope('all'), { all: true });
  assert.deepEqual(parseScope('kind:concept'), { kind: 'concept' });
  assert.deepEqual(parseScope('folder:12'), { folder: 12 });
  for (const bad of ['', 'kind:x', 'folder:0', 'folder:-1', 'folder:1.5', 'folder:abc', 'ALL', 'kind:', 'folder:1e3']) {
    assert.throws(() => parseScope(bad), (e) => e instanceof WikiError && e.status === 400, bad);
  }
});

test('safeName：去掉危险字符、开头的点，截断到 80 字，空值为「未命名」', () => {
  const s = safeName('../a/b:c');
  assert.ok(!/[/\\:]/.test(s) && !s.startsWith('.'), s);
  assert.ok(s.includes('a') && s.includes('b') && s.includes('c'));
  assert.equal(safeName(''), '未命名');
  assert.equal(safeName('..'), '未命名');
  assert.equal(safeName('a*b?c"d<e>f|g\u0001h\\i'), 'a b c d e f g h i');
  assert.equal([...safeName('字'.repeat(200))].length, 80);
  assert.ok(!safeName('名字. ').endsWith('.'));
});

test('pageToMarkdown：YAML 元数据，链接改写为 [[标题]]，引用改写为脚注', () => {
  const { db, done } = setup();
  try {
    const d = seedDoc(db, '资料甲', '## 第一节\n内容');
    put(db, [pg('beta', 'Beta 页', '内容'), pg('alpha', 'Alpha', `参见 [[beta]] 和 [[beta|别名]]，未知 [[ghost|幽灵]]。依据[^${d}:0]，再次[^${d}:0]`)]);
    const p = getPageRow(db, 'alpha')!;
    const md = pageToMarkdown(db, p, new Map([['beta', 'Beta 页']]));
    assert.ok(md.startsWith('---\nslug: alpha\nkind: concept\nupdated: '), md);
    assert.ok(md.includes('参见 [[Beta 页]] 和 [[Beta 页]]'), md);
    assert.ok(md.includes('[[幽灵]]'), md);
    assert.ok(md.includes('依据[^1]，再次[^1]'), md);
    assert.ok(md.includes('[^1]: 资料甲 › 第一节'), md);
    assert.ok(!md.includes(`[^${d}:0]`));
  } finally {
    done();
  }
});

test('pageToHtml：转义正文中的 HTML，不含外部资源属性，图片以 data: 内嵌', () => {
  const { db, assetsDir, done } = setup();
  try {
    put(db, [pg('x', '<b>标题</b>', '## 小节\n<script>alert(1)</script>\n\n**粗** *斜* [外链](https://evil.example/x) ![外图](http://evil.example/a.png)\n\n- 一\n- 二\n\n1. 甲\n\n> 引用\n\n```\n<img src=x onerror=1>\n```\n\n![图](asset:1)')]);
    const id = addAsset(db, assetsDir, 'x');
    assert.equal(id, 1);
    const html = pageToHtml(db, getPageRow(db, 'x')!, assetsDir);
    assert.ok(!html.includes('<script'), html);
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('&lt;b&gt;标题'));
    assert.ok(!/(src|href)\s*=\s*["']?\s*https?:/i.test(html), html);
    assert.ok(!/<a[\s>]/i.test(html));
    assert.ok(html.includes('<strong>粗</strong>') && html.includes('<em>斜</em>'));
    assert.ok(html.includes('<h2>小节</h2>') && html.includes('<ul>') && html.includes('<ol>') && html.includes('<blockquote>') && html.includes('<pre>'));
    assert.ok(html.includes('src="data:image/png;base64,'), html);
    const tags = new Set([...html.matchAll(/<([a-z][a-z0-9]*)/gi)].map((m) => m[1].toLowerCase()));
    for (const t of tags) assert.ok(['html', 'head', 'meta', 'title', 'body', 'h1', 'h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'blockquote', 'pre', 'strong', 'em', 'img'].includes(t), t);
  } finally {
    done();
  }
});

test('exportWiki：标题含 ../ 时 zip 中没有路径穿越', async () => {
  const { db, assetsDir, tmpDir, done } = setup();
  try {
    put(db, [pg('etc', '../../etc', '内容'), pg('etc2', '..', '内容'), pg('etc3', '/abs/x', '内容', 'entity')]);
    const r = await exportWiki(db, { all: true }, { assetsDir, tmpDir });
    const list = names(r.file);
    for (const n of list) assert.ok(!n.startsWith('..') && !n.includes('/..') && !n.startsWith('/') && !n.includes('\\'), n);
    assert.ok(list.includes('index.md') && list.includes('log.md'));
    assert.equal(r.bytes, fs.statSync(r.file).size);
    execFileSync('unzip', ['-tq', r.file]);
  } finally {
    done();
  }
});

test('exportWiki({kind})：只包含该类型页面，以及 index.md 和 log.md；重名加序号', async () => {
  const { db, assetsDir, tmpDir, done } = setup();
  try {
    put(db, [pg('c1', '概念一', '内容'), pg('c2', '概念一', '同名'), pg('e1', '实体一', '内容', 'entity'), pg('o', '总览', '内容', 'overview')]);
    const r = await exportWiki(db, { kind: 'concept' }, { assetsDir, tmpDir });
    assert.deepEqual(names(r.file).sort(), ['index.md', 'log.md', '概念/概念一 (2).md', '概念/概念一.md'].sort());
    const idx = entry(r.file, 'index.md');
    assert.ok(idx.includes('[[概念一]]') && idx.includes('[[概念一 (2)]]') && idx.includes('概念一摘要'), idx);
    assert.ok(!idx.includes('实体一'));
    assert.ok(entry(r.file, 'log.md').includes('编辑'));
  } finally {
    done();
  }
});

test('exportWiki({folder})：目录及子目录资料的 source 页，加上直接链接的实体、概念、对比页', async () => {
  const { db, assetsDir, tmpDir, done } = setup();
  try {
    const top = createFolder(db, '项目', null);
    const sub = createFolder(db, '子目录', top);
    const other = createFolder(db, '其他', null);
    const d1 = createDoc(db, { kind: 'note', title: '资料一', body: '## a\nx', folderId: top });
    const d2 = createDoc(db, { kind: 'note', title: '资料二', body: '## a\ny', folderId: sub });
    const d3 = createDoc(db, { kind: 'note', title: '资料三', body: '## a\nz', folderId: other });
    put(db, [
      pg('ent', '实体甲', '内容', 'entity'),
      pg('con', '概念乙', '内容', 'concept'),
      pg('cmp', '对比丙', '内容', 'compare'),
      pg('ans', '问答丁', '内容', 'answer'),
      pg('lone', '无关概念', '内容', 'concept'),
      pg('src-1', '资料一', '提到 [[ent]] 与 [[ans]]', 'source', d1),
      pg('src-2', '资料二', '提到 [[con]] 与 [[cmp]]', 'source', d2),
      pg('src-3', '资料三', '提到 [[lone]]', 'source', d3),
    ]);
    const r = await exportWiki(db, { folder: top }, { assetsDir, tmpDir });
    assert.deepEqual(names(r.file).sort(), ['index.md', 'log.md', '实体/实体甲.md', '概念/概念乙.md', '对比/对比丙.md', '资料摘要/项目/资料一.md', '资料摘要/项目/子目录/资料二.md'].sort());
    await assert.rejects(exportWiki(db, { folder: 9999 }, { assetsDir, tmpDir }), (e) => e instanceof WikiError && e.status === 404);
  } finally {
    done();
  }
});

test('exportWiki：含图片的页面转为 .docx；转换失败改为 .md 并带 .assets/ 目录，log.md 记一行', async () => {
  const { db, assetsDir, tmpDir, done } = setup();
  try {
    put(db, [pg('pic', '带图', '前文\n\n![示意](asset:1)'), pg('plain', '无图', '正文')]);
    addAsset(db, assetsDir, 'pic');
    const htmls: string[] = [];
    const ok = await exportWiki(db, { all: true }, { assetsDir, tmpDir, convert: async (h) => (htmls.push(h), Buffer.from('DOCX')) });
    assert.ok(names(ok.file).includes('概念/带图.docx'));
    assert.ok(names(ok.file).includes('概念/无图.md'));
    assert.equal(entry(ok.file, '概念/带图.docx'), 'DOCX');
    assert.equal(htmls.length, 1);
    assert.ok(htmls[0].includes('data:image/png;base64,'));

    const bad = await exportWiki(db, { all: true }, { assetsDir, tmpDir, convert: async () => Promise.reject(new Error('boom')) });
    const list = names(bad.file);
    assert.ok(list.includes('概念/带图.md') && list.includes('概念/带图.assets/1.png'), list.join(','));
    assert.ok(!list.includes('概念/带图.docx'));
    assert.ok(entry(bad.file, '概念/带图.md').includes('![示意](<带图.assets/1.png>)'));
    assert.deepEqual(execFileSync('unzip', ['-p', bad.file, '概念/带图.assets/1.png']), PNG);
    assert.ok(entry(bad.file, 'log.md').includes('带图'), entry(bad.file, 'log.md'));
  } finally {
    done();
  }
});

test('exportWiki：超过 exportMax 抛 413，临时文件已删除', async () => {
  const { db, assetsDir, tmpDir, done } = setup();
  try {
    put(db, [pg('big', '大页', crypto.randomBytes(3000).toString('base64'))]);
    await assert.rejects(exportWiki(db, { all: true }, { assetsDir, tmpDir, exportMax: 1024 }), (e) => e instanceof WikiError && e.status === 413 && e.message === '导出内容超过 200MB，请按目录导出');
    assert.deepEqual(fs.readdirSync(tmpDir), []);
  } finally {
    done();
  }
});
