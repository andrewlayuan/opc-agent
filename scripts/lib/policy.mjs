// 规则引擎：本地钩子和 CI 必需检查共用同一份代码（规则只写一次）。
// 只依赖 Node 内置模块，Windows（Git Bash）/ macOS / Linux 都能跑。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根目录 = 本文件所在目录的上两级（不依赖工具传入的环境变量，两家工具、CI 都一致）
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const policy = JSON.parse(readFileSync(path.join(ROOT, 'policy/opc.policy.json'), 'utf8'));

// 简易 glob：支持 ** 和 *
const reCache = new Map();
export function globToRe(g) {
  if (reCache.has(g)) return reCache.get(g);
  let s = g.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*');
  const re = new RegExp('^' + s + '$');
  reCache.set(g, re);
  return re;
}
export const match = (p, globs) => globs.some((g) => globToRe(g).test(p));

// 统一成相对仓库根目录的 / 路径
export function rel(p) {
  if (!p) return '';
  let r = path.isAbsolute(p) ? path.relative(ROOT, p) : p;
  return r.split(path.sep).join('/').replace(/^\.\//, '');
}

const sh = (c) => { try { return execSync(c, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
export const currentBranch = () => process.env.OPC_BRANCH || sh('git rev-parse --abbrev-ref HEAD');
export const existsInHead = (p) => sh(`git cat-file -e HEAD:"${p}" && echo y`) === 'y';

// 分支命名约定：feat/12-xxx、fix/12-xxx、chore/12-xxx、plan/12
export function issueOf(branch) {
  const m = /^(feat|fix|chore|plan)\/(\d+)/.exec(branch || '');
  return m ? { kind: m[1], n: m[2] } : null;
}

// 找到 docs/plans/<n>-*.md，返回 {file,status}
export function planOf(n) {
  const dir = path.join(ROOT, 'docs/plans');
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((x) => x === `${n}.md` || x.startsWith(`${n}-`));
  if (!f) return null;
  const txt = readFileSync(path.join(dir, f), 'utf8');
  const st = /^status:\s*([\w-]+)/m.exec(txt);
  return { file: `docs/plans/${f}`, status: st ? st[1] : 'draft' };
}

// —— 规则 1：Agent 写文件 ——  返回 {decision:'allow'|'ask'|'deny', reason}
export function checkWrite(file, newContent = '') {
  const p = rel(file);
  if (!p || p.startsWith('..')) return { decision: 'deny', reason: `不允许写仓库外的文件：${file}` };
  if (match(p, policy.secretPaths)) return { decision: 'deny', reason: `${p} 是密钥文件，Agent 不能读写。需要配置请你手动改。` };
  if (/^docs\/plans\//.test(p) && /^status:\s*approved/m.test(newContent))
    return { decision: 'deny', reason: '计划的 status: approved 只能由你本人（或 /opc approve 脚本）写，这就是 G2 关口。请保持 status: draft。' };
  if (match(p, policy.protectedPaths))
    return { decision: 'ask', reason: `${p} 是护栏文件（规则/钩子/CI/评估）。Agent 想改它，必须你本人确认。` };
  const branch = currentBranch();
  const iss = issueOf(branch);
  if (match(p, policy.testPaths) && existsInHead(p)) {
    if (iss && iss.kind === 'fix') return { decision: 'deny', reason: `修缺陷不改已有测试（${p}）。请只改实现代码；如果测试本身错了，在 PR 里说明，由你本人改。` };
    return { decision: 'ask', reason: `要修改已有测试 ${p}。功能变化可以改，但需要你确认这不是“改测试凑通过”。` };
  }
  if (match(p, policy.codePaths) && policy.planGate !== 'off') {
    let why = '';
    if (/^(main|master)$/.test(branch)) why = '不要在主分支上直接改代码。先建分支：git switch -c feat/<Issue号>-<短名>';
    else if (!iss) why = `分支名 ${branch} 不符合约定（feat|fix|chore/<Issue号>-<短名>），找不到对应计划。`;
    else {
      const pl = planOf(iss.n);
      if (!pl) why = `没有找到 docs/plans/${iss.n}-*.md。先写计划（/plan），再动代码。`;
      else if (pl.status !== 'approved') why = `${pl.file} 还是 ${pl.status}，等你批准（status: approved）后才能动代码。`;
    }
    if (why) return policy.planGate === 'on' ? { decision: 'deny', reason: why } : { decision: 'allow', reason: '[提醒] ' + why };
  }
  return { decision: 'allow', reason: '' };
}

// —— 规则 2：Agent 读文件 ——
export function checkRead(file) {
  const p = rel(file);
  if (match(p, policy.secretPaths)) return { decision: 'deny', reason: `${p} 是密钥文件，Agent 不能读。` };
  return { decision: 'allow', reason: '' };
}

// —— 规则 3：Agent 执行命令 ——
export function checkShell(cmd = '') {
  for (const r of policy.shell.deny) if (new RegExp(r.re, 'i').test(cmd)) return { decision: 'deny', reason: `已拦截：${r.why}（${cmd.slice(0, 80)}）` };
  for (const r of policy.shell.ask) if (new RegExp(r.re, 'i').test(cmd)) return { decision: 'ask', reason: r.why };
  return { decision: 'allow', reason: '' };
}
