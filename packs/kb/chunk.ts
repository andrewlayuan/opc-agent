// 知识库分块：按 Markdown 标题（# – ###）分节，节内按段落合并到约 800 字；表格按行打包；超长段落切开
import { KB_LIMITS, len } from './types.ts';

export interface Chunk {
  heading: string;
  body: string;
}

interface Unit {
  text: string;
  sep: string;
}

const HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const SENTENCE_END = /[。！？!?；;]|\.(?=\s)/g;

const isTable = (lines: string[]) => lines.length >= 2 && lines.filter((l) => l.includes(' | ')).length * 2 >= lines.length;

/** 把超过上限的文字切成多段：优先在换行处，其次在句末，最后硬切 */
function splitLong(text: string, max: number): string[] {
  const out: string[] = [];
  let cps = [...text];
  while (cps.length > max) {
    const head = cps.slice(0, max).join('');
    const min = Math.floor(max / 3);
    let cut = head.lastIndexOf('\n') + 1;
    if (cut < min) {
      cut = 0;
      for (const m of head.matchAll(SENTENCE_END)) cut = m.index + m[0].length;
    }
    // index 按 UTF-16 计，转回码点数
    let n = cut >= min ? [...head.slice(0, cut)].length : max;
    if (n < min) n = max;
    out.push(cps.slice(0, n).join(''));
    cps = cps.slice(n);
  }
  if (cps.length) out.push(cps.join(''));
  return out;
}

function unitsOf(para: string[]): Unit[] {
  const max = KB_LIMITS.chunkMax;
  if (isTable(para)) {
    return para.flatMap((line, i) => splitLong(line, max).map((t, j) => ({ text: t, sep: j ? '' : i ? '\n' : '\n\n' })));
  }
  const text = para.join('\n');
  return splitLong(text, max).map((t, j) => ({ text: t, sep: j ? '' : '\n\n' }));
}

export function chunkMarkdown(text: string): { chunks: Chunk[]; truncated: boolean } {
  const chunks: Chunk[] = [];
  let truncated = false;
  const stack: string[] = [];
  let heading = '';
  let units: Unit[] = [];
  let para: string[] = [];
  let inFence = false;

  const endPara = () => {
    if (para.some((l) => l.trim())) units.push(...unitsOf(para));
    para = [];
  };
  const flush = () => {
    endPara();
    let cur = '';
    for (const u of units) {
      if (!cur) cur = u.text;
      else if (len(cur) + len(u.sep) + len(u.text) <= KB_LIMITS.chunkTarget) cur += u.sep + u.text;
      else {
        chunks.push({ heading, body: cur });
        cur = u.text;
      }
    }
    if (cur.trim()) chunks.push({ heading, body: cur });
    units = [];
  };

  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      para.push(raw);
      continue;
    }
    if (!inFence) {
      const m = HEADING.exec(raw);
      if (m) {
        flush();
        const level = m[1].length;
        stack.length = level - 1;
        stack[level - 1] = m[2].trim();
        heading = stack.filter(Boolean).join(' › ');
        continue;
      }
      if (!raw.trim()) {
        endPara();
        continue;
      }
    }
    para.push(raw);
  }
  flush();

  const out = chunks.map((c) => ({ heading: c.heading, body: c.body.trim() })).filter((c) => c.body);
  if (out.length > KB_LIMITS.chunksPerDoc) {
    truncated = true;
    out.length = KB_LIMITS.chunksPerDoc;
  }
  return { chunks: out, truncated };
}
