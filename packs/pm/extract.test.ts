import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildZip } from './zip.ts';
import { ExtractError, clampText, decodeText, decodeXml, detectType, extractDocx, extractPptx, extractXlsx } from './extract.ts';

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
