import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CONVERT_TIMEOUT_MS, LO_FAILED, LO_MISSING, LO_TIMEOUT, PROFILE_XCU, TARGET, convertHtmlToDocx, convertLegacy, realRun } from './convert.ts';
import type { RunFn } from './convert.ts';
import { ExtractError, MIME, detectType } from './extract.ts';
import type { LegacyFormat } from './extract.ts';
import { extractFileText } from './ingest.ts';
import type { LlmPort } from './ingest.ts';
import { buildZip } from './zip.ts';

const llm = { enabled: false, chat: async () => '' } as unknown as LlmPort;
const DOCX = buildZip({ 'word/document.xml': '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>转换后的正文</w:t></w:r></w:p></w:body></w:document>' });

function sandbox(): { root: string; src: string; done: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-conv-test-'));
  const src = path.join(root, 'src');
  fs.writeFileSync(src, 'DOC');
  return { root, src, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const leftovers = (root: string) => fs.readdirSync(root).filter((n) => n.startsWith('opc-lo-'));

/** 假的 soffice：在 --outdir 写出 in.<目标格式> */
const writeOut = (buf: Buffer): RunFn => async (_cmd, args) => {
  fs.writeFileSync(path.join(args[10], `in.${args[8]}`), buf);
  return { code: 0, timedOut: false, stderr: '' };
};

test('convertLegacy：参数固定、不经 shell，最小环境变量，一次性配置目录写入安全选项，结束后删除临时目录', async () => {
  const { root, src, done } = sandbox();
  try {
    const calls: { cmd: string; args: string[]; opts: Parameters<RunFn>[2]; xcu: string; input: string }[] = [];
    const run: RunFn = async (cmd, args, opts) => {
      const profile = new URL(args[6].slice('-env:UserInstallation='.length)).pathname;
      calls.push({ cmd, args, opts, xcu: fs.readFileSync(path.join(profile, 'user', 'registrymodifications.xcu'), 'utf8'), input: fs.readFileSync(args[11], 'utf8') });
      return writeOut(DOCX)(cmd, args, opts);
    };
    const r = await convertLegacy(src, 'doc', { run, tmpRoot: root });
    assert.equal(r.format, 'docx');
    assert.deepEqual(r.buf, DOCX);
    const [c] = calls;
    const dir = c.opts.cwd;
    assert.equal(c.cmd, 'soffice');
    assert.deepEqual(c.args, ['--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo', '--invisible', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', 'docx', '--outdir', `${dir}/out`, `${dir}/in.doc`]);
    assert.deepEqual(c.opts.env, { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: dir, LANG: 'C.UTF-8' });
    assert.equal(c.opts.timeoutMs, CONVERT_TIMEOUT_MS);
    assert.equal(c.input, 'DOC');
    assert.equal(c.xcu, PROFILE_XCU);
    for (const k of ['DisableMacrosExecution" oor:op="fuse"><value>true', 'MacroSecurityLevel" oor:op="fuse"><value>3', 'OOXMLRecalcMode" oor:op="fuse"><value>1']) assert.ok(PROFILE_XCU.includes(k), k);
    assert.ok(dir.startsWith(root));
    assert.deepEqual(leftovers(root), []);
  } finally {
    done();
  }
});

test('convertLegacy：各格式的转换目标', async () => {
  const { root, src, done } = sandbox();
  try {
    const want: Record<LegacyFormat, string> = { doc: 'docx', rtf: 'docx', odt: 'docx', xls: 'xlsx', ods: 'xlsx', ppt: 'pptx', odp: 'pptx' };
    assert.deepEqual(TARGET, want);
    for (const f of Object.keys(want) as LegacyFormat[]) assert.equal((await convertLegacy(src, f, { run: writeOut(DOCX), tmpRoot: root })).format, want[f]);
  } finally {
    done();
  }
});

test('convertLegacy：未安装、超时、没有输出、输出为空分别报 422，临时目录都删除', async () => {
  const { root, src, done } = sandbox();
  try {
    const cases: [RunFn, string][] = [
      [async () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' })), LO_MISSING],
      [async () => Promise.reject(new Error('spawn failed')), LO_FAILED],
      [async () => ({ code: null, timedOut: true, stderr: '' }), LO_TIMEOUT],
      [async () => ({ code: 0, timedOut: false, stderr: 'Error: source file could not be loaded' }), LO_FAILED],
      [writeOut(Buffer.alloc(0)), LO_FAILED],
    ];
    for (const [run, msg] of cases) {
      await assert.rejects(convertLegacy(src, 'xls', { run, tmpRoot: root }), (e) => e instanceof ExtractError && e.status === 422 && e.message === msg);
    }
    assert.deepEqual(leftovers(root), []);
  } finally {
    done();
  }
});

test('convertLegacy：同一时间只转换一个文件，失败不影响后面的任务', async () => {
  const { root, src, done } = sandbox();
  try {
    let active = 0;
    let peak = 0;
    const slow = (fail: boolean): RunFn => async (cmd, args, opts) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      if (fail) throw new Error('boom');
      return writeOut(DOCX)(cmd, args, opts);
    };
    const rs = await Promise.allSettled([true, false, false].map((f) => convertLegacy(src, 'doc', { run: slow(f), tmpRoot: root })));
    assert.deepEqual(rs.map((r) => r.status), ['rejected', 'fulfilled', 'fulfilled']);
    assert.equal(peak, 1);
  } finally {
    done();
  }
});

test('realRun：超时后整个进程组被强杀，后台子进程也不会拖住；命令不存在时 ENOENT', async () => {
  const t0 = Date.now();
  const r = await realRun('sh', ['-c', 'sleep 30 & sleep 30'], { cwd: os.tmpdir(), env: { PATH: '/usr/bin:/bin' }, timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 5000, `耗时 ${Date.now() - t0}ms`);
  await assert.rejects(realRun('/nonexistent/soffice', [], { cwd: os.tmpdir(), env: {}, timeoutMs: 1000 }), (e) => (e as { code?: string }).code === 'ENOENT');
});

test('extractFileText：旧格式经转换后按 Office 提取；HTML 在 worker 中提取', async () => {
  const { src, done } = sandbox();
  try {
    assert.equal(await extractFileText(src, MIME.doc, 'doc', { llm, run: writeOut(DOCX) }), '转换后的正文');
    fs.writeFileSync(src, '<h1>网页</h1><p>内容</p><script>x()</script>');
    assert.equal(await extractFileText(src, MIME.html, 'doc', { llm }), '# 网页\n\n内容');
  } finally {
    done();
  }
});

const hasSoffice = spawnSync('soffice', ['--version'], { timeout: 30000 }).status === 0;
const NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
].join(' ');
const flat = (kind: string, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><office:document ${NS} office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.${kind}"><office:body>${body}</office:body></office:document>`;
const SOURCES: Record<string, string> = {
  'a.fodt': flat('text', '<office:text><text:h text:outline-level="1">文档标题</text:h><text:p>正文内容 Legacy Writer</text:p></office:text>'),
  'b.fods': flat(
    'spreadsheet',
    '<office:spreadsheet><table:table table:name="销售"><table:table-row><table:table-cell office:value-type="string"><text:p>产品</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="42"><text:p>42</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet>',
  ),
  'c.fodp': flat(
    'presentation',
    '<office:presentation><draw:page draw:name="p1"><draw:frame svg:x="1cm" svg:y="1cm" svg:width="10cm" svg:height="3cm"><draw:text-box><text:p>幻灯片文字</text:p></draw:text-box></draw:frame></draw:page></office:presentation>',
  ),
};

test('真实 LibreOffice：doc / rtf / odt / xls / ods / ppt / odp 识别与提取全流程（未安装则跳过）', { skip: !hasSoffice, timeout: 240000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-lo-real-'));
  try {
    for (const [n, x] of Object.entries(SOURCES)) fs.writeFileSync(path.join(dir, n), x);
    const gen = (to: string, src: string) => {
      const args = ['--headless', '--norestore', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', to, '--outdir', path.join(dir, 'gen'), path.join(dir, src)];
      const r = spawnSync('soffice', args, { timeout: 60000, env: { PATH: '/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8' } });
      assert.equal(r.status, 0, String(r.stderr));
      return path.join(dir, 'gen', `${src.split('.')[0]}.${to}`);
    };
    const cases: [string, string, RegExp][] = [
      ['doc', 'a.fodt', /文档标题[\s\S]*正文内容 Legacy Writer/],
      ['rtf', 'a.fodt', /正文内容 Legacy Writer/],
      ['odt', 'a.fodt', /正文内容 Legacy Writer/],
      ['xls', 'b.fods', /## 销售\n产品 \| 42/],
      ['ods', 'b.fods', /## 销售\n产品 \| 42/],
      ['ppt', 'c.fodp', /## 第 1 页\n幻灯片文字/],
      ['odp', 'c.fodp', /## 第 1 页\n幻灯片文字/],
    ];
    for (const [to, src, re] of cases) {
      const file = gen(to, src);
      const det = detectType(fs.readFileSync(file), 'upload.bin');
      assert.equal(det.format, to);
      assert.match(await extractFileText(file, det.mime, 'doc', { llm }), re, to);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('convertHtmlToDocx：参数数组含 HTML 导入过滤器和 Word 导出过滤器，不经 shell，最小环境，结束后删除临时目录', async () => {
  const { root, done } = sandbox();
  try {
    const calls: { cmd: string; args: string[]; opts: Parameters<RunFn>[2]; input: string; xcu: string }[] = [];
    const run: RunFn = async (cmd, args, opts) => {
      const profile = new URL(args[6].slice('-env:UserInstallation='.length)).pathname;
      calls.push({ cmd, args, opts, input: fs.readFileSync(args[args.length - 1], 'utf8'), xcu: fs.readFileSync(path.join(profile, 'user', 'registrymodifications.xcu'), 'utf8') });
      fs.writeFileSync(path.join(args[args.indexOf('--outdir') + 1], 'in.docx'), DOCX);
      return { code: 0, timedOut: false, stderr: '' };
    };
    const html = '<html><body><p>正文 $(rm -rf /) `x`</p></body></html>';
    const buf = await convertHtmlToDocx(html, { run, tmpRoot: root });
    assert.deepEqual(buf, DOCX);
    const [c] = calls;
    const dir = c.opts.cwd;
    assert.equal(c.cmd, 'soffice');
    assert.deepEqual(c.args, ['--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo', '--invisible', `-env:UserInstallation=file://${dir}/profile`, '--infilter=HTML (StarWriter)', '--convert-to', 'docx:MS Word 2007 XML', '--outdir', `${dir}/out`, `${dir}/in.html`]);
    assert.deepEqual(c.opts.env, { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: dir, LANG: 'C.UTF-8' });
    assert.equal(c.opts.timeoutMs, CONVERT_TIMEOUT_MS);
    assert.equal(c.input, html);
    assert.equal(c.xcu, PROFILE_XCU);
    assert.deepEqual(leftovers(root), []);
    await assert.rejects(convertHtmlToDocx(html, { run: async () => ({ code: null, timedOut: true, stderr: '' }), tmpRoot: root }), (e) => e instanceof ExtractError && e.message === LO_TIMEOUT);
    await assert.rejects(convertHtmlToDocx(html, { run: async () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' })), tmpRoot: root }), (e) => e instanceof ExtractError && e.message === LO_MISSING);
    await assert.rejects(convertHtmlToDocx(html, { run: async () => ({ code: 0, timedOut: false, stderr: '' }), tmpRoot: root }), (e) => e instanceof ExtractError && e.message === LO_FAILED);
    assert.deepEqual(leftovers(root), []);
  } finally {
    done();
  }
});
