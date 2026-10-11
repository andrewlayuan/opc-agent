#!/usr/bin/env node
// CI 必需检查：用和本地钩子同一份规则，复查整个 PR 的改动，兜住"绕过钩子"进入分支的改动。
// 用法：node scripts/checks/guardrails.mjs [基准分支，默认 origin/main]
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { policy, match, issueOf, planOf } from '../lib/policy.mjs';
const base = process.argv[2] || 'origin/main';
const sh = (c) => execSync(c).toString().trim();
const branch = process.env.GITHUB_HEAD_REF || sh('git rev-parse --abbrev-ref HEAD');
const labels = (process.env.PR_LABELS || '').split(',');
const lines = sh(`git diff --name-status ${base}...HEAD`).split('\n').filter(Boolean);
const errs = [], warns = [];
const iss = issueOf(branch);
const files = lines.map((l) => { const [st, ...r] = l.split('\t'); return { st: st[0], p: r[r.length - 1] }; });
const codeTouched = files.some((f) => match(f.p, policy.codePaths));

// 1. 密钥文件
for (const f of files) if (match(f.p, policy.secretPaths)) errs.push(`提交了密钥文件：${f.p}`);
// 2. 有代码改动必须有已批准的计划
if (codeTouched) {
  if (!iss) errs.push(`分支名 ${branch} 不符合 feat|fix|chore/<Issue号>-<短名>`);
  else { const pl = planOf(iss.n); if (!pl) errs.push(`缺少 docs/plans/${iss.n}-*.md`); else if (pl.status !== 'approved') errs.push(`${pl.file} 未批准（${pl.status}）`); }
}
// 3. 修缺陷不改已有测试
for (const f of files) if (f.st !== 'A' && match(f.p, policy.testPaths)) {
  if (iss?.kind === 'fix') errs.push(`fix 分支修改了已有测试：${f.p}（修缺陷不改测试）`);
  else warns.push(`修改了已有测试：${f.p}，请在 PR 中说明原因`);
}
// 4. 护栏文件改动需要你本人加标签 guardrail-ok
const guard = files.filter((f) => match(f.p, policy.protectedPaths)).map((f) => f.p);
if (guard.length && !labels.includes('guardrail-ok')) errs.push(`改了护栏文件，需要你本人加标签 guardrail-ok：${guard.join(', ')}`);
// 5. 计划里的 approved 必须由 approve 脚本写入（有 approved_by）
for (const f of files) if (/^docs\/plans\//.test(f.p) && f.st !== 'D' && existsSync(f.p)) {
  const t = readFileSync(f.p, 'utf8');
  if (/^status:\s*approved/m.test(t) && !/^approved_by:/m.test(t)) errs.push(`${f.p} 的 approved 不是用 npm run approve 写入的`);
}
// 6. D 类路径必须有标签 lane/D
if (files.some((f) => match(f.p, policy.laneDPaths)) && !labels.includes('lane/D')) errs.push('改动了 D 类路径（法务/财务/注册/安全），PR 必须标 lane/D，并逐行人工审');
// 7. AGENTS.md 行数
if (existsSync('AGENTS.md')) { const n = readFileSync('AGENTS.md', 'utf8').split('\n').length; if (n > policy.maxAgentsMdLines) errs.push(`AGENTS.md ${n} 行，超过 ${policy.maxAgentsMdLines} 行上限，请把细节下沉到技能`); }

warns.forEach((w) => console.log('⚠️  ' + w));
if (errs.length) { errs.forEach((e) => console.log('❌ ' + e)); process.exit(1); }
console.log(`guardrails: OK（${files.length} 个文件）`);
