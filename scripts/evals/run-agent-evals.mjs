#!/usr/bin/env node
// Agent 配置评估：改了 AGENTS.md / 技能 / 子代理 / 钩子后，用真实历史任务回归一遍，看 Agent 行为有没有变差。
// 每个用例在独立的 git worktree 里用无头模式跑，检查改了哪些文件、自检是否通过。
// 用法：node scripts/evals/run-agent-evals.mjs [--tool codebuddy|cursor] [--only 007]
import { readdirSync, readFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import os from 'node:os'; import path from 'node:path';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const tool = arg('--tool', 'codebuddy'), only = arg('--only', '');
const dir = 'evals/agent/cases';
const cases = readdirSync(dir).filter((f) => f.endsWith('.json') && f.startsWith(only)).map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
const cmd = (p) => tool === 'cursor'
  ? ['agent', ['-p', '--force', '--output-format', 'json', p]]
  : ['codebuddy', ['-p', p, '-y', '--output-format', 'json', '--max-turns', '40']];
let ok = 0; const rows = [];
for (const c of cases) {
  const wt = path.join(os.tmpdir(), `opc-eval-${c.id}-${Date.now()}`);
  execSync(`git worktree add -q --detach "${wt}" HEAD`);
  try {
    if (c.setup) { // 准备现场并提交，避免把准备文件算成 Agent 的改动
      execSync(c.setup, { cwd: wt, stdio: 'ignore', shell: '/bin/bash' });
      execSync('git add -A && git -c user.name=eval -c user.email=eval@local commit -qm eval-setup --allow-empty', { cwd: wt, shell: '/bin/bash' });
    }
    const [bin, args] = cmd(c.prompt);
    const r = spawnSync(bin, args, { cwd: wt, encoding: 'utf8', timeout: 15 * 60e3 });
    const changed = execSync('git status --porcelain', { cwd: wt }).toString().split('\n').filter(Boolean).map((l) => l.slice(3));
    const e = c.expect || {}, fail = [];
    for (const m of e.mustTouch || []) if (!changed.includes(m)) fail.push(`没改 ${m}`);
    for (const m of e.mustNotTouch || []) if (changed.includes(m)) fail.push(`不该改 ${m}`);
    for (const s of e.outputIncludes || []) if (!(r.stdout || '').includes(s)) fail.push(`输出缺少「${s}」`);
    for (const s of c.forbidOutput || []) if ((r.stdout || '').includes(s)) fail.push(`输出泄露了「${s}」`);
    for (const s of e.outputExcludes || []) if ((r.stdout || "").includes(s)) fail.push(`输出泄露了「${s}」`);
    if (e.verifyPasses && spawnSync('npm', ['run', '-s', 'verify:fast'], { cwd: wt }).status !== 0) fail.push('verify:fast 未通过');
    if (!fail.length) ok++;
    rows.push(`| ${c.id} | ${fail.length ? '❌ ' + fail.join('；') : '✅'} |`);
  } finally { execSync(`git worktree remove --force "${wt}"`); }
}
const rate = cases.length ? ok / cases.length : 1;
console.log(`| 用例 | 结果 |\n|---|---|\n${rows.join('\n')}\n\nagent evals (${tool}): ${ok}/${cases.length} = ${(rate * 100).toFixed(0)}%`);
mkdirSync('docs/reports', { recursive: true });
appendFileSync('docs/reports/metrics.jsonl', JSON.stringify({ date: new Date().toISOString().slice(0, 10), id: 'agent_eval_pass_rate', value: rate }) + '\n');
if (rate < 0.85) process.exit(1);
