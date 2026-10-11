#!/usr/bin/env node
// 控制带：读 docs/reports/metrics.jsonl，计算每个指标今天偏离过去 N 天均值多少个 σ。
// 用法：node scripts/checks/bands.mjs [--file 路径]（产品运行指标在本机 ~/.opc/metrics.jsonl，研发指标在 ops-data 分支）
// 输出 JSON：[{id, value, mean, sd, level:0|1|2|3, why}]；nightly 工作流据此开 Issue。
import { readFileSync, existsSync } from 'node:fs';
const fi = process.argv.indexOf('--file'); const FILE = fi > 0 ? process.argv[fi + 1] : 'docs/reports/metrics.jsonl';
const cfg = JSON.parse(readFileSync('policy/bands.json', 'utf8'));
const rows = existsSync(FILE) ? readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const out = [];
for (const [id, m] of Object.entries(cfg.metrics)) {
  const s = rows.filter((r) => r.id === id).sort((a, b) => a.date.localeCompare(b.date));
  if (!s.length) continue;
  const cur = s[s.length - 1], hist = s.slice(-cfg.window - 1, -1).map((r) => r.value);
  let level = 0, why = '';
  if (m.hardMin !== undefined && cur.value < m.hardMin) { level = 3; why = `低于硬下限 ${m.hardMin}`; }
  if (m.hardMax !== undefined && cur.value > m.hardMax) { level = 3; why = `高于硬上限 ${m.hardMax}`; }
  let mean = null, sd = null;
  if (hist.length >= cfg.minHistory) {
    mean = hist.reduce((a, b) => a + b, 0) / hist.length;
    sd = Math.sqrt(hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length) || 1e-9;
    const z = (cur.value - mean) / sd;
    const bad = m.direction === 'both' ? Math.abs(z) : m.direction === 'up' ? z : -z;
    const l = bad >= 3 ? 3 : bad >= 2 ? 2 : bad >= 1 ? 1 : 0;
    if (l > level) { level = l; why = `偏离 ${z.toFixed(1)}σ（均值 ${mean.toFixed(2)}）`; }
  }
  out.push({ id, desc: m.desc, date: cur.date, value: cur.value, mean, sd, level, why });
}
console.log(JSON.stringify(out, null, 1));
