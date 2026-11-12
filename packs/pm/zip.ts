/** 只读、只进内存的 ZIP 解析：用于从 docx/xlsx/pptx 中取 XML，带条目数与解压上限（防压缩炸弹） */
import zlib from 'node:zlib';

export class ZipError extends Error {}

export interface Zip {
  names: string[];
  has(name: string): boolean;
  read(name: string): Buffer;
}

interface Entry {
  method: number;
  compSize: number;
  size: number;
  offset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const BROKEN = '文件损坏或结构不支持';

function u16(b: Buffer, at: number): number {
  if (at < 0 || at + 2 > b.length) throw new ZipError(BROKEN);
  return b.readUInt16LE(at);
}
function u32(b: Buffer, at: number): number {
  if (at < 0 || at + 4 > b.length) throw new ZipError(BROKEN);
  return b.readUInt32LE(at);
}

function badName(name: string): boolean {
  return name.startsWith('/') || name.startsWith('\\') || name.split(/[\\/]/).some((p) => p === '..');
}

export function openZip(buf: Buffer, limits: { maxEntries?: number; entryMax?: number; totalMax?: number } = {}): Zip {
  const maxEntries = limits.maxEntries ?? 2000;
  const entryMax = limits.entryMax ?? 20 * 1024 * 1024;
  const totalMax = limits.totalMax ?? 50 * 1024 * 1024;

  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError(BROKEN);
  const count = u16(buf, eocd + 10);
  const cdOffset = u32(buf, eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('不支持 ZIP64');
  if (count > maxEntries) throw new ZipError('压缩包条目过多');

  const entries = new Map<string, Entry>();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (u32(buf, p) !== SIG_CEN) throw new ZipError(BROKEN);
    const flags = u16(buf, p + 8);
    const method = u16(buf, p + 10);
    const compSize = u32(buf, p + 20);
    const size = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const offset = u32(buf, p + 42);
    if (p + 46 + nameLen > buf.length) throw new ZipError(BROKEN);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (flags & 1) throw new ZipError('不支持加密的文件');
    if (method !== 0 && method !== 8) throw new ZipError(BROKEN);
    if (badName(name)) throw new ZipError(BROKEN);
    if (compSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw new ZipError('不支持 ZIP64');
    entries.set(name, { method, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  let used = 0;
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read(name) {
      const e = entries.get(name);
      if (!e) throw new ZipError(`缺少条目 ${name}`);
      if (u32(buf, e.offset) !== SIG_LOC) throw new ZipError(BROKEN);
      const start = e.offset + 30 + u16(buf, e.offset + 26) + u16(buf, e.offset + 28);
      if (start + e.compSize > buf.length) throw new ZipError(BROKEN);
      const data = buf.subarray(start, start + e.compSize);
      const limit = Math.min(entryMax, totalMax - used);
      let out: Buffer;
      if (e.method === 0) {
        if (data.length > limit) throw new ZipError('解压后内容过大');
        out = Buffer.from(data);
      } else {
        try {
          out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, limit) });
        } catch {
          throw new ZipError(limit <= 0 ? '解压后内容过大' : BROKEN);
        }
        if (out.length > limit) throw new ZipError('解压后内容过大');
      }
      used += out.length;
      return out;
    },
  };
}

/** 测试辅助：生成标准 ZIP（本地头 + 中央目录 + EOCD） */
export function buildZip(files: Record<string, string | Buffer>, opts: { store?: boolean; flags?: number } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = typeof content === 'string' ? Buffer.from(content) : content;
    const method = opts.store ? 0 : 8;
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32(raw);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(SIG_LOC, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(opts.flags ?? 0, 6);
    loc.writeUInt16LE(method, 8);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(data.length, 18);
    loc.writeUInt32LE(raw.length, 22);
    loc.writeUInt16LE(nameBuf.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(SIG_CEN, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(opts.flags ?? 0, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    locals.push(loc, nameBuf, data);
    centrals.push(cen, nameBuf);
    offset += loc.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  const n = Object.keys(files).length;
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(n, 8);
  eocd.writeUInt16LE(n, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
