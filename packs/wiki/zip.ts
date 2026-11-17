// 最小 zip 写入器：边写边落盘，deflate 压缩，文件名按 UTF-8 标记；不支持 zip64（导出上限远小于 4GB）
import fs from 'node:fs';
import zlib from 'node:zlib';

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const UTF8_FLAG = 0x0800;
const MAX_U32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

/** 条目名只能是程序拼出的相对路径：不能为空、不能以 / 开头、不能含 \ 、空段或 .. 段 */
function assertName(name: string): void {
  if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0')) throw new Error(`zip 条目名不合法：${name}`);
  for (const seg of name.split('/')) if (seg === '' || seg === '.' || seg === '..') throw new Error(`zip 条目名不合法：${name}`);
}

function dosTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

interface Central {
  name: Buffer;
  crc: number;
  comp: number;
  size: number;
  method: number;
  offset: number;
}

export class ZipWriter {
  private fd: number | null;
  private offset = 0;
  private entries: Central[] = [];
  private names = new Set<string>();
  private readonly stamp = dosTime(new Date());

  constructor(file: string) {
    this.fd = fs.openSync(file, 'wx', 0o600);
  }

  /** 已写入的字节数 */
  get size(): number {
    return this.offset;
  }

  private write(b: Buffer): void {
    if (this.fd == null) throw new Error('zip 已关闭');
    let at = 0;
    while (at < b.length) at += fs.writeSync(this.fd, b, at, b.length - at);
    this.offset += b.length;
  }

  add(name: string, data: Buffer): void {
    assertName(name);
    if (this.names.has(name)) throw new Error(`zip 条目重复：${name}`);
    if (this.entries.length >= MAX_ENTRIES) throw new Error('zip 条目过多');
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(data);
    if (this.offset + 30 + nameBuf.length + body.length > MAX_U32) throw new Error('zip 超过 4GB');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(UTF8_FLAG, 6);
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(this.stamp.time, 10);
    h.writeUInt16LE(this.stamp.date, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(0, 28);
    const offset = this.offset;
    this.write(h);
    this.write(nameBuf);
    this.write(body);
    this.names.add(name);
    this.entries.push({ name: nameBuf, crc, comp: body.length, size: data.length, method, offset });
  }

  /** 写入中央目录并关闭文件，返回总字节数 */
  close(): number {
    const start = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(0x0314, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(UTF8_FLAG, 8);
      c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(this.stamp.time, 12);
      c.writeUInt16LE(this.stamp.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.comp, 20);
      c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.name.length, 28);
      c.writeUInt16LE(0, 30);
      c.writeUInt16LE(0, 32);
      c.writeUInt16LE(0, 34);
      c.writeUInt16LE(0, 36);
      c.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      c.writeUInt32LE(e.offset, 42);
      this.write(c);
      this.write(e.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    this.write(end);
    fs.closeSync(this.fd!);
    this.fd = null;
    return this.offset;
  }

  /** 放弃写入：只关闭文件句柄，删除由调用方负责 */
  abort(): void {
    if (this.fd == null) return;
    try {
      fs.closeSync(this.fd);
    } catch {
      // 句柄已失效
    }
    this.fd = null;
  }
}
