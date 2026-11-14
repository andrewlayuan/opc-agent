import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { buildZip } from './zip.ts';
import { ExtractError, clampText, decodeText, decodeXml, detectType, extractDocx, extractOffice, extractPdf, extractPptx, extractXlsx } from './extract.ts';
import type { ExecFn } from './extract.ts';

const HEADS: Record<string, Buffer> = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]),
  gif: Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBPVP8 ')]),
  pdf: Buffer.from('%PDF-1.4\n%\xe2\xe3\n', 'latin1'),
};

const status = (fn: () => unknown): number => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ExtractError, String(e));
    return e.status;
  }
  return 0;
};
const message = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return '';
};

test('detectType：按文件头识别图片和 PDF，扩展名不影响', () => {
  for (const [fmt, buf] of Object.entries(HEADS)) {
    const d = detectType(buf, 'x.png');
    assert.equal(d.format, fmt);
    assert.equal(d.kind, fmt === 'pdf' ? 'doc' : 'image');
  }
  assert.equal(detectType(HEADS.jpeg, 'x.png').mime, 'image/jpeg');
  assert.equal(detectType(HEADS.pdf, 'a.txt').mime, 'application/pdf');
});

test('detectType：docx/xlsx/pptx 按包内条目识别', () => {
  const docx = detectType(buildZip({ 'word/document.xml': '<w:document/>' }), 'a.zip');
  assert.deepEqual([docx.format, docx.kind, docx.mime], ['docx', 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
  assert.equal(detectType(buildZip({ 'xl/workbook.xml': '<workbook/>' }), 'a').format, 'xlsx');
  assert.equal(detectType(buildZip({ 'ppt/presentation.xml': '<p/>' }), 'a').format, 'pptx');
  assert.equal(status(() => detectType(buildZip({ 'a.txt': 'x' }), 'a.docx')), 415);
});

test('detectType：旧版 Office、svg、html、无扩展名文本、含 NUL 的 .txt 都抛 415', () => {
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  assert.equal(status(() => detectType(ole, 'a.doc')), 415);
  assert.equal(message(() => detectType(ole, 'a.doc')), '旧版 Office 文件请另存为 docx / xlsx / pptx');
  for (const [buf, name] of [
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'a.svg'],
    [Buffer.from('<html></html>'), 'a.html'],
    [Buffer.from('hello'), 'README'],
  ] as const) {
    assert.equal(status(() => detectType(buf, name)), 415);
    assert.equal(message(() => detectType(buf, name)), '不支持的文件类型');
  }
  assert.equal(message(() => detectType(Buffer.from([0x61, 0, 0x62]), 'a.txt')), '请另存为 UTF-8 文本');
  for (const n of ['a.TXT', 'b.md', 'c.markdown', 'd.csv', 'e.json']) assert.deepEqual(detectType(Buffer.from('ok'), n).format, 'text');
});

test('decodeText：去 BOM；GBK 字节抛 415', () => {
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('你好')])), '你好');
  assert.equal(status(() => decodeText(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]))), 415);
  assert.equal(message(() => decodeText(Buffer.from([0x61, 0, 0x62]))), '请另存为 UTF-8 文本');
});

test('decodeXml：命名与数字实体', () => {
  assert.equal(decodeXml('&lt;a&gt; &amp; &quot;&apos; &#20320;&#x597D;'), '<a> & "\' 你好');
  assert.equal(decodeXml('&#xFFFFFFF;&#0;'), '��');
  assert.equal(decodeXml('&amp;lt;'), '&lt;');
});

const W = (body: string) => `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`;
const P = (...runs: string[]) => `<w:p><w:pPr/>${runs.join('')}</w:p>`;
const R = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const TC = (t: string) => `<w:tc><w:tcPr/>${P(R(t))}</w:tc>`;

test('extractDocx：段落、tab、换行、表格行', () => {
  const xml = W(
    P(R('第一'), R('段')) +
      P(R('甲'), '<w:r><w:tab/></w:r>', R('乙')) +
      P() +
      `<w:tbl><w:tr>${TC('A1')}${TC('B1')}</w:tr><w:tr>${TC('A2')}${TC('B2')}</w:tr></w:tbl>` +
      P(R('x &amp; y'), '<w:r><w:br/></w:r>', R('z')),
  );
  assert.equal(extractDocx(buildZip({ 'word/document.xml': xml })), '第一段\n甲\t乙\nA1 | B1\nA2 | B2\nx & y\nz');
});

const SHEET = (rows: string) => `<worksheet><sheetData>${rows}</sheetData></worksheet>`;
function xlsx(sheets: { name: string; target: string; xml: string }[], shared: string[], order = sheets): Buffer {
  return buildZip({
    'xl/workbook.xml': `<workbook xmlns:r="r"><sheets>${order.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${sheets.indexOf(s) + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships>${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="ws" Target="${s.target}"/>`).join('')}</Relationships>`,
    'xl/sharedStrings.xml': `<sst>${shared.map((s) => `<si><r><t>${s.slice(0, 1)}</t></r><r><t>${s.slice(1)}</t></r></si>`).join('')}</sst>`,
    ...Object.fromEntries(sheets.map((s) => [`xl/${s.target.replace(/^\/xl\//, '')}`, s.xml])),
  });
}

test('extractXlsx：按 workbook 顺序输出多个工作表，共享字符串与数字，空列补位，超限截断', () => {
  const s1 = { name: '明细', target: 'worksheets/sheet1.xml', xml: SHEET('<row r="1"><c r="A1" t="inlineStr"><is><t>x&lt;y</t></is></c></row>') };
  const s2 = {
    name: '汇总',
    target: '/xl/worksheets/sheet2.xml',
    xml: SHEET('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>100</v></c><c r="D1"/></row><row r="2"><c r="B2" t="b"><v>1</v></c></row>'),
  };
  const out = extractXlsx(xlsx([s1, s2], ['名称'], [s2, s1]));
  assert.ok(out.startsWith('## 汇总\n'), out);
  assert.ok(out.includes('名称 |  | 100\n | 1'), out);
  assert.ok(out.indexOf('## 明细\nx<y') > out.indexOf('## 汇总'), out);

  const rows = Array.from({ length: 600 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i + 1}</v></c></row>`).join('');
  const big = extractXlsx(xlsx([{ name: '大表', target: 'worksheets/sheet1.xml', xml: SHEET(rows) }], []));
  const lines = big.split('\n');
  assert.equal(lines.filter((l) => /^\d+$/.test(l)).length, 500);
  assert.ok(big.endsWith('（已截断）'), big.slice(-20));
  const wide = SHEET(`<row r="1">${Array.from({ length: 60 }, (_, i) => `<c r="${i < 26 ? String.fromCharCode(65 + i) : 'A' + String.fromCharCode(65 + i - 26)}1"><v>${i}</v></c>`).join('')}</row>`);
  const w = extractXlsx(xlsx([{ name: '宽表', target: 'worksheets/sheet1.xml', xml: wide }], []));
  assert.equal(w.split('\n')[1].split(' | ').length, 50);
  assert.ok(w.includes('（已截断）'));
});

test('extractXlsx：主命名空间带前缀（OpenXML SDK 生成的 x: 前缀）也能读出', () => {
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const buf = buildZip({
    'xl/workbook.xml': `\uFEFF<x:workbook xmlns:x="${NS}"><x:sheets><x:sheet name="付费设备分析" sheetId="1" r:id="R1" xmlns:r="r" /></x:sheets></x:workbook>`,
    'xl/_rels/workbook.xml.rels': '\uFEFF<Relationships><Relationship Type="ws" Target="/xl/worksheets/sheet1.xml" Id="R1" /></Relationships>',
    'xl/sharedStrings.xml': `<x:sst xmlns:x="${NS}"><x:si><x:t>设备</x:t></x:si></x:sst>`,
    'xl/worksheets/sheet1.xml': `<x:worksheet xmlns:x="${NS}"><x:sheetData><x:row r="1"><x:c r="A1" s="2" /><x:c r="B1" s="2" /></x:row><x:row r="2"><x:c r="A2" t="str"><x:v>23台付费设备</x:v></x:c><x:c r="B2" t="s"><x:v>0</x:v></x:c><x:c r="C2" t="n"><x:v>0.35</x:v></x:c></x:row><x:row r="3"><x:c r="B3" t="inlineStr"><x:is><x:t>行内</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>`,
  });
  assert.equal(extractXlsx(buf), '## 付费设备分析\n23台付费设备 | 设备 | 0.35\n | 行内');
});

test('extractXlsx：日期格式的数字单元格转成日期（自定义格式、内置格式、带时间、1904 纪年）', () => {
  const styles = (numFmts: string, xfIds: number[]) =>
    `<styleSheet><numFmts>${numFmts}</numFmts><cellStyleXfs><xf numFmtId="14"/></cellStyleXfs><cellXfs>${xfIds.map((id) => `<xf numFmtId="${id}" xfId="0"><alignment/></xf>`).join('')}</cellXfs></styleSheet>`;
  const book = (wbPr: string, cells: string) =>
    buildZip({
      'xl/workbook.xml': `<workbook xmlns:r="r">${wbPr}<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/styles.xml': styles('<numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="0.0&quot;天&quot;"/><numFmt numFmtId="166" formatCode="[h]:mm"/>', [0, 164, 14, 22, 10, 165, 166, 21]),
      'xl/worksheets/sheet1.xml': SHEET(`<row r="1">${cells}</row>`),
    });
  const cells =
    '<c r="A1" s="1"><v>46337</v></c><c r="B1" s="2"><v>46337</v></c><c r="C1" s="3"><v>46337.5</v></c><c r="D1" s="4"><v>0.35</v></c>' +
    '<c r="E1" s="0"><v>46337</v></c><c r="F1" s="1" t="str"><v>待定</v></c><c r="G1" s="5"><v>3</v></c><c r="H1" s="6"><v>1.5</v></c><c r="I1" s="7"><v>0.75</v></c>';
  assert.equal(extractXlsx(book('', cells)), '## S\n2026-11-11 | 2026-11-11 | 2026-11-11 12:00 | 0.35 | 46337 | 待定 | 3 | 1.5 | 18:00');
  assert.equal(extractXlsx(book('<workbookPr date1904="1"/>', '<c r="A1" s="1"><v>0</v></c>')), '## S\n1904-01-01');
});

test('extractXlsx：所有工作表都没有内容时返回空串', () => {
  assert.equal(extractXlsx(xlsx([{ name: '空表', target: 'worksheets/sheet1.xml', xml: SHEET('<row r="1"><c r="A1" s="1"/></row>') }], [])), '');
});

test('extractPptx：按页号数字排序（slide10 在 slide2 之后）', () => {
  const slide = (t: string) => `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r><a:r><a:t>!</a:t></a:r></a:p><a:p><a:r><a:t>次行</a:t></a:r></a:p></p:sld>`;
  const out = extractPptx(
    buildZip({ 'ppt/presentation.xml': '<p/>', 'ppt/slides/slide10.xml': slide('十'), 'ppt/slides/slide2.xml': slide('二'), 'ppt/slides/slide1.xml': slide('一'), 'ppt/slides/_rels/slide1.xml.rels': '<x/>' }),
  );
  assert.equal(out, '## 第 1 页\n一!\n次行\n\n## 第 2 页\n二!\n次行\n\n## 第 10 页\n十!\n次行');
});

test('extractDocx：损坏的 zip 抛 ExtractError(422)', () => {
  assert.equal(status(() => extractDocx(Buffer.from('PK\x03\x04garbage'))), 422);
  assert.equal(status(() => extractDocx(buildZip({ 'x.xml': '<x/>' }))), 422);
  assert.equal(message(() => extractXlsx(Buffer.alloc(0))), '文件损坏或结构不支持');
});

test('clampText：超过 2 万字截取并记录原长', () => {
  assert.deepEqual(clampText('字'.repeat(20001)), { text: '字'.repeat(20000), origChars: 20001 });
  assert.deepEqual(clampText('  短  '), { text: '短', origChars: null });
  assert.deepEqual(clampText('😀😀😀', 2), { text: '😀😀', origChars: 3 });
});

// ---------------- PDF ----------------
type ExecCall = { file: string; args: string[]; opts: unknown };
const fakeExec = (impl: () => Promise<{ stdout: string; stderr: string }>, calls: ExecCall[] = []): ExecFn => async (file, args, opts) => {
  calls.push({ file, args, opts });
  return impl();
};
const rejectWith = (props: Record<string, unknown>) => () => Promise.reject(Object.assign(new Error(String(props.message ?? 'x')), props));
async function pdfMsg(exec: ExecFn): Promise<string> {
  try {
    await extractPdf('/x/a', exec);
  } catch (e) {
    assert.ok(e instanceof ExtractError);
    assert.equal(e.status, 422);
    return e.message;
  }
  return '';
}

test('extractPdf：参数固定、不经 shell', async () => {
  const calls: ExecCall[] = [];
  const out = await extractPdf('/x/a', fakeExec(async () => ({ stdout: '第一页的文字内容足够长了吧\f第二页的内容也要有一些文字', stderr: '' }), calls));
  assert.deepEqual(calls, [{ file: 'pdftotext', args: ['-enc', 'UTF-8', '-l', '200', '/x/a', '-'], opts: { timeout: 20000, maxBuffer: 2097152, killSignal: 'SIGKILL' } }]);
  assert.equal(out, '第一页的文字内容足够长了吧\n\n第二页的内容也要有一些文字');
});

test('extractPdf：ENOENT、超时、密码、损坏分别给出 spec 文案', async () => {
  assert.equal(await pdfMsg(fakeExec(rejectWith({ code: 'ENOENT' }))), '服务器未安装 PDF 解析工具（poppler-utils）');
  assert.equal(await pdfMsg(fakeExec(rejectWith({ killed: true, signal: 'SIGKILL' }))), 'PDF 解析超时');
  assert.equal(await pdfMsg(fakeExec(rejectWith({ code: 1, stderr: 'Command Line Error: Incorrect password' }))), 'PDF 有密码保护');
  assert.equal(await pdfMsg(fakeExec(rejectWith({ code: 1, stderr: 'Syntax Error: broken' }))), '文件损坏或结构不支持');
});

/** 按命令分派的假 exec：pdftotext 返回空文字层；pdftoppm 在输出前缀处写出 pages 个页面图；tesseract 按图片名返回 ocr(页码) */
function scanExec(pages: number, ocr: (page: number) => Promise<string> | string, calls: ExecCall[] = []): ExecFn {
  return async (file, args, opts) => {
    calls.push({ file, args, opts });
    if (file === 'pdftotext') return { stdout: ' \n\f ', stderr: '' };
    if (file === 'pdftoppm') {
      const prefix = args.at(-1)!;
      const width = String(pages).length;
      for (let i = 1; i <= pages; i++) fs.writeFileSync(`${prefix}-${String(i).padStart(width, '0')}.png`, 'x');
      return { stdout: '', stderr: '' };
    }
    if (file === 'tesseract') {
      const page = Number(/-(\d+)\.png$/.exec(args[0])![1]);
      return { stdout: await ocr(page), stderr: '' };
    }
    throw new Error(`unexpected ${file}`);
  };
}

test('extractPdf：文字层为空时渲染前 20 页做 OCR，按页码顺序拼接并标注来源', async () => {
  const calls: ExecCall[] = [];
  const out = await extractPdf('/x/a', scanExec(12, (p) => `第 ${p} 页 识别 出来 的 文字 内容\n`, calls));
  const ppm = calls.find((c) => c.file === 'pdftoppm')!;
  assert.deepEqual(ppm.args.slice(0, -2), ['-r', '200', '-gray', '-png', '-l', '20']);
  assert.equal(ppm.args.at(-2), '/x/a');
  const tess = calls.filter((c) => c.file === 'tesseract');
  assert.equal(tess.length, 12);
  assert.deepEqual(tess[0].args.slice(1), ['-', '-l', 'chi_sim+eng', '--psm', '4']);
  assert.ok(out.startsWith('（以下内容由 OCR 从扫描页识别，可能有错字）\n\n第 1 页识别出来的文字内容'), out);
  assert.ok(out.indexOf('第 2 页') < out.indexOf('第 10 页'), '按页码数字排序，不按字符串');
  assert.ok(!fs.existsSync(path.dirname(ppm.args.at(-1)!)), '临时目录已删除');
});

test('extractPdf：OCR 也没有文字、未安装 tesseract、渲染超时分别给出文案', async () => {
  assert.equal(await pdfMsg(scanExec(2, () => '  \n')), '未识别到文字，可能是扫描件不清晰或页面没有文字');
  assert.equal(await pdfMsg(scanExec(1, () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' })))), '未提取到文字，可能是扫描件；服务器未安装 OCR 工具（tesseract）');
  const slow: ExecFn = async (file) => {
    if (file === 'pdftotext') return { stdout: '', stderr: '' };
    throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' });
  };
  assert.equal(await pdfMsg(slow), 'PDF 解析超时');
});

test('extractPdf：单页 OCR 失败跳过该页，总时长超出预算时停止并注明', async () => {
  const out = await extractPdf('/x/a', scanExec(3, (p) => (p === 2 ? Promise.reject(Object.assign(new Error('x'), { killed: true })) : `第${p}页的文字内容足够长足够长`)));
  assert.match(out, /第1页/);
  assert.match(out, /第3页/);
  assert.doesNotMatch(out, /第2页/);
  let t = 0;
  const budgeted = await extractPdf('/x/a', scanExec(5, (p) => ((t += 70_000), `第${p}页的文字内容足够长足够长`)), { now: () => t });
  assert.match(budgeted, /第2页/);
  assert.doesNotMatch(budgeted, /第3页/);
  assert.match(budgeted, /OCR 超时，只识别了前 2 页/);
});

test('extractPdf：maxBuffer 超限时用已读到的内容', async () => {
  const stdout = '前面的内容……足够长的文字内容超过二十个字了吧应该是的';
  const out = await extractPdf('/x/a', fakeExec(rejectWith({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout })));
  assert.ok(out.startsWith('前面的内容'));
});

/** 手写最小 PDF：一页、Helvetica、一行文字；xref 偏移按实际字节计算 */
function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
const hasPdftotext = spawnSync('pdftotext', ['-v']).error == null;

test('extractPdf：真实 pdftotext（未安装则跳过）', { skip: !hasPdftotext }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-pdf-'));
  const file = path.join(dir, 'a');
  fs.writeFileSync(file, minimalPdf('Hello OPC attachments test'));
  try {
    assert.match(await extractPdf(file), /Hello OPC attachments test/);
    assert.equal(detectType(fs.readFileSync(file), 'x').format, 'pdf');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 用 pdftoppm 把文字 PDF 渲染成灰度图，再包成只有图片的 PDF，模拟扫描件 */
function scannedPdf(dir: string, text: string): string {
  const src = path.join(dir, 'src.pdf');
  fs.writeFileSync(src, minimalPdf(text));
  spawnSync('pdftoppm', ['-r', '150', '-gray', '-singlefile', src, path.join(dir, 'img')]);
  const pgm = fs.readFileSync(path.join(dir, 'img.pgm'));
  const [, size, , ] = pgm.subarray(0, 64).toString('latin1').split('\n');
  const [w, h] = size.split(' ').map(Number);
  const px = pgm.subarray(pgm.length - w * h);
  const img = zlib.deflateSync(px);
  const content = 'q 612 0 0 792 0 0 cm /Im1 Do Q';
  const objs: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>'),
    Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.length} >>\nstream\n`), img, Buffer.from('\nendstream')]),
  ];
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  let len = parts[0].length;
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(len);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
    parts.push(b);
    len += b.length;
  });
  parts.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`));
  const out = path.join(dir, 'scan.pdf');
  fs.writeFileSync(out, Buffer.concat(parts));
  return out;
}
const hasTesseract = spawnSync('tesseract', ['--version']).error == null;

test('extractPdf：真实扫描件走 OCR（未安装 tesseract 则跳过）', { skip: !hasPdftotext || !hasTesseract }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-pdf-'));
  try {
    const file = scannedPdf(dir, 'Scanned pricing memo for OCR test');
    assert.equal(spawnSync('pdftotext', [file, '-']).stdout.toString().trim(), '', '模拟扫描件没有文字层');
    const out = await extractPdf(file);
    assert.match(out, /^（以下内容由 OCR/);
    assert.match(out, /pricing memo for OCR/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extractOffice：在 worker 中提取，结果与同步版一致', async () => {
  const buf = buildZip({ 'word/document.xml': W(P(R('第一段')) + P(R('第二段'))) });
  assert.equal(await extractOffice('docx', buf), extractDocx(buf));
  await assert.rejects(extractOffice('docx', buildZip({ 'x.xml': '<x/>' })), (e) => e instanceof ExtractError && e.status === 422);
});

test('extractOffice：构造的未闭合标签（正则回溯平方级）在超时后终止，报 422', async () => {
  const xml = W('<w:p>'.repeat(200000));
  const t0 = Date.now();
  await assert.rejects(extractOffice('docx', buildZip({ 'word/document.xml': xml }), 500), (e) => e instanceof ExtractError && e.status === 422 && e.message === '文件损坏或结构不支持');
  assert.ok(Date.now() - t0 < 5000, `耗时 ${Date.now() - t0}ms`);
});
