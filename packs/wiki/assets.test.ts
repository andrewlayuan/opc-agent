import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { WikiAssets, sniffImage } from './assets.ts';
import { createOp, finishOp, getPageRow, tx, writePages } from './store.ts';
import { tmpWikiDb } from './testutil.ts';
import { WikiError } from './types.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

function setup() {
  const t = tmpWikiDb();
  tx(t.db, () => {
    const id = createOp(t.db, 'edit', { status: 'running' });
    finishOp(t.db, id, { status: 'done', pages: writePages(t.db, id, [{ slug: 'p', kind: 'concept', title: 'P', summary: '', body: 'x' }]).changes });
  });
  const assets = new WikiAssets(t.db, path.join(t.dir, 'wiki-assets'));
  const pageId = getPageRow(t.db, 'p')!.id;
  const tmpWith = (buf: Buffer) => {
    const f = assets.tmpPath();
    fs.writeFileSync(f, buf, { mode: 0o600 });
    return f;
  };
  return { ...t, assets, pageId, tmpWith };
}

test('sniffImage：按文件头识别 png / jpg / gif / webp，其余为 null', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(sniffImage(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1')), 'image/webp');
  assert.equal(sniffImage(Buffer.from('RIFF\x10\x00\x00\x00WAVEfmt ', 'latin1')), null);
  assert.equal(sniffImage(Buffer.from('<html><script>alert(1)</script>')), null);
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

test('WikiAssets.create：PNG 存成随机文件名（600），目录 700，read 返回文件与类型', () => {
  const { db, dir, assets, pageId, tmpWith, done } = setup();
  try {
    const tmp = tmpWith(PNG);
    const r = assets.create(tmp, pageId);
    assert.equal(r.mime, 'image/png');
    assert.ok(!fs.existsSync(tmp));
    const row = db.prepare('SELECT page_id, mime, size, storage FROM wiki_assets WHERE id = ?').get(r.id) as { page_id: number; mime: string; size: number; storage: string };
    assert.equal(row.page_id, pageId);
    assert.equal(row.size, PNG.length);
    assert.match(row.storage, /^[0-9a-f]{32}\.png$/);
    const f = assets.read(r.id)!;
    assert.equal(f.mime, 'image/png');
    assert.equal(f.file, path.join(dir, 'wiki-assets', row.storage));
    assert.deepEqual(fs.readFileSync(f.file), PNG);
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, 'wiki-assets')).mode & 0o777, 0o700);
    assert.equal(assets.read(9999), null);
  } finally {
    done();
  }
});

test('WikiAssets.create：非图片 415、超过 5MB 413、页面不存在 404，失败时都删除临时文件', () => {
  const { assets, pageId, tmpWith, dir, done } = setup();
  try {
    const cases: [Buffer, number, number][] = [
      [Buffer.from('<html><body>x</body></html>'), pageId, 415],
      [Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]), pageId, 413],
      [PNG, 9999, 404],
    ];
    for (const [buf, pid, status] of cases) {
      const tmp = tmpWith(buf);
      assert.throws(() => assets.create(tmp, pid), (e) => e instanceof WikiError && e.status === status, String(status));
      assert.ok(!fs.existsSync(tmp));
    }
    assert.deepEqual(fs.readdirSync(path.join(dir, 'wiki-assets')), []);
  } finally {
    done();
  }
});
