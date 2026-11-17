// 基于最长公共子序列的逐行差异；超长文本只比较前后各 200 行

export type DiffLine = { t: ' ' | '+' | '-'; s: string };

const MAX_LINES = 2000;
const EDGE = 200;

const split = (s: string): string[] => (s === '' ? [] : s.replace(/\r\n?/g, '\n').split('\n'));

function lcs(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: ' ', s: a[i] });
      i++;
      j++;
    } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) {
      out.push({ t: '-', s: a[i++] });
    } else {
      out.push({ t: '+', s: b[j++] });
    }
  }
  while (i < n) out.push({ t: '-', s: a[i++] });
  while (j < m) out.push({ t: '+', s: b[j++] });
  return out;
}

export function lineDiff(a: string, b: string): { lines: DiffLine[]; clipped: boolean } {
  const la = split(a);
  const lb = split(b);
  if (la.length <= MAX_LINES && lb.length <= MAX_LINES) return { lines: lcs(la, lb), clipped: false };
  const head = lcs(la.slice(0, EDGE), lb.slice(0, EDGE));
  const tail = lcs(la.slice(Math.max(EDGE, la.length - EDGE)), lb.slice(Math.max(EDGE, lb.length - EDGE)));
  return { lines: [...head, { t: ' ', s: '…（中间部分过长，未比较）…' }, ...tail], clipped: true };
}
