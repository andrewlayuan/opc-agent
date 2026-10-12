#!/usr/bin/env node
// 把 .agents/ 里的源文件同步给两家工具。只改 .agents/，然后运行 npm run sync。
//   技能  .agents/skills   → .codebuddy/skills（Cursor 原生读取 .agents/skills，不再复制，避免重复加载）
//   子代理 .agents/agents  → .codebuddy/agents（保留 tools）、.cursor/agents（去掉 tools，补 model: inherit）
//   命令  .agents/commands → .codebuddy/commands、.cursor/commands
// --check：只检查副本是否过期（CI 用），过期则退出码 1
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd(), CHECK = process.argv.includes('--check');
let drift = [];
const HEAD = '<!-- 由 npm run sync 从 .agents/ 生成，请勿直接修改 -->\n';
function put(dst, txt) {
  const old = existsSync(dst) ? readFileSync(dst, 'utf8') : null;
  if (old === txt) return;
  if (CHECK) { drift.push(path.relative(ROOT, dst)); return; }
  mkdirSync(path.dirname(dst), { recursive: true }); writeFileSync(dst, txt);
}
const addHead = (t) => t.replace(/^(---\n[\s\S]*?\n---\n)/, `$1${HEAD}`);
function walk(d) { return readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; }); }

// 技能
const S = path.join(ROOT, '.agents/skills');
for (const f of walk(S)) put(path.join(ROOT, '.codebuddy/skills', path.relative(S, f)), f.endsWith('.md') ? addHead(readFileSync(f, 'utf8')) : readFileSync(f, 'utf8'));
// 子代理
const A = path.join(ROOT, '.agents/agents');
for (const f of readdirSync(A)) {
  const t = readFileSync(path.join(A, f), 'utf8');
  put(path.join(ROOT, '.codebuddy/agents', f), addHead(t.replace(/^readonly:.*\n/m, '')));
  put(path.join(ROOT, '.cursor/agents', f), addHead(t.replace(/^tools:.*\n/m, '').replace(/^(description:.*\n)/m, '$1model: inherit\n')));
}
// 命令
const C = path.join(ROOT, '.agents/commands');
for (const f of readdirSync(C)) {
  const t = readFileSync(path.join(C, f), 'utf8');
  put(path.join(ROOT, '.codebuddy/commands', f), addHead(t));
  put(path.join(ROOT, '.cursor/commands', f), HEAD + t.replace(/^---\n[\s\S]*?\n---\n/, ''));
}
if (CHECK && drift.length) { console.error('Agent 配置副本已过期，请运行 npm run sync：\n  ' + drift.join('\n  ')); process.exit(1); }
console.log(CHECK ? 'sync: up to date' : 'sync: done');
