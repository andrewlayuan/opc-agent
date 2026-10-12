#!/usr/bin/env node
// 产品评估：逐个运行 packs/*/evals/run.mjs（每个能力包自己实现，返回 {pass,total,metrics}）。
// 结果追加到 docs/reports/metrics.jsonl，供控制带使用。
import { existsSync, readdirSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
let pass = 0, total = 0; const today = new Date().toISOString().slice(0, 10);
const packs = existsSync('packs') ? readdirSync('packs') : [];
mkdirSync('docs/reports', { recursive: true });
for (const p of packs) {
  const f = path.resolve('packs', p, 'evals/run.mjs');
  if (!existsSync(f)) continue;
  const r = await (await import(pathToFileURL(f))).default();
  pass += r.pass; total += r.total;
  console.log(`  ${p}: ${r.pass}/${r.total}`);
  for (const [id, value] of Object.entries(r.metrics || {})) if (process.env.OPC_RECORD) appendFileSync('docs/reports/metrics.jsonl', JSON.stringify({ date: today, id, value }) + '\n');
}
console.log(`product evals: ${pass}/${total}`);
if (pass < total) process.exit(1);
