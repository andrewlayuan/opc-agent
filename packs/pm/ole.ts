/** 只读 OLE 复合文档（CFB）的根目录条目名，用来区分 doc / xls / ppt；不解析流内容。结构异常时返回 null */

const FREE = 0xffffffff;
const END = 0xfffffffe;
const MAX_REG = 0xfffffffa;
const NOSTREAM = 0xffffffff;
const MAX_ENTRIES = 50000;

export function oleRootNames(buf: Buffer): string[] | null {
  try {
    return read(buf);
  } catch {
    return null;
  }
}

function read(buf: Buffer): string[] | null {
  if (buf.length < 512) return null;
  const shift = buf.readUInt16LE(0x1e);
  if (shift !== 9 && shift !== 12) return null;
  const ss = 1 << shift;
  const sectors = Math.floor(buf.length / ss);
  const off = (sid: number) => (sid + 1) * ss;
  const valid = (sid: number) => sid <= MAX_REG && off(sid) + ss <= buf.length;
  const per = ss / 4;

  const fatSids: number[] = [];
  for (let i = 0; i < 109; i++) {
    const sid = buf.readUInt32LE(0x4c + i * 4);
    if (sid === FREE || sid === END) break;
    if (!valid(sid)) return null;
    fatSids.push(sid);
  }
  let difat = buf.readUInt32LE(0x44);
  const seen = new Set<number>();
  while (difat !== END && difat !== FREE) {
    if (!valid(difat) || seen.has(difat) || seen.size > sectors) return null;
    seen.add(difat);
    const base = off(difat);
    for (let i = 0; i < per - 1; i++) {
      const sid = buf.readUInt32LE(base + i * 4);
      if (sid === FREE || sid === END) continue;
      if (!valid(sid)) return null;
      fatSids.push(sid);
    }
    difat = buf.readUInt32LE(base + (per - 1) * 4);
  }

  const next = (sid: number): number => {
    const fat = fatSids[Math.floor(sid / per)];
    return fat === undefined ? END : buf.readUInt32LE(off(fat) + (sid % per) * 4);
  };

  const dir: Buffer[] = [];
  const visited = new Set<number>();
  for (let sid = buf.readUInt32LE(0x30); sid !== END; sid = next(sid)) {
    if (!valid(sid) || visited.has(sid) || visited.size > sectors) return null;
    visited.add(sid);
    for (let p = off(sid); p < off(sid) + ss; p += 128) {
      if (dir.length >= MAX_ENTRIES) return null;
      dir.push(buf.subarray(p, p + 128));
    }
  }
  if (!dir.length || dir[0][66] !== 5) return null;

  const name = (e: Buffer) => {
    const n = e.readUInt16LE(64);
    return n >= 2 && n <= 64 && n % 2 === 0 ? e.subarray(0, n - 2).toString('utf16le') : '';
  };
  // 根条目的子节点构成一棵红黑树（左右兄弟指针），遍历整棵树得到根目录下的全部条目
  const out: string[] = [];
  const stack = [dir[0].readUInt32LE(76)];
  const done = new Set<number>();
  while (stack.length) {
    const id = stack.pop()!;
    if (id === NOSTREAM) continue;
    if (id >= dir.length || done.has(id)) return null;
    done.add(id);
    const e = dir[id];
    if (e[66] === 1 || e[66] === 2) out.push(name(e));
    stack.push(e.readUInt32LE(68), e.readUInt32LE(72));
  }
  return out;
}
