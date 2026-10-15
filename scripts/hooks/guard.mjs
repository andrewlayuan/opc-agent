#!/usr/bin/env node
// 统一钩子入口：CodeBuddy 和 Cursor 都调用这一个脚本，内部翻译两家的输入/输出格式。
// 用法：node scripts/hooks/guard.mjs <cb|cursor> <pre|read|shell|stop|session>
//   CodeBuddy：退出码 2 = 阻止，原因同时写 stdout 和 stderr；JSON 用 hookSpecificOutput.permissionDecision（支持 ask）
//   Cursor   ：输出 {"permission":"allow|deny|ask"}；preToolUse 不执行 ask，所以 ask 降级为 deny 并提示找你本人
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const [, , tool = 'cb', ev = 'pre'] = process.argv;
// CodeBuddy 拦截：IDE 文档说读 stderr，CLI 文档说优先读 stdout，两边都写
const blockCb = (msg) => { process.stdout.write(msg); process.stderr.write(msg + '\n'); process.exit(2); };

// 注意：脚本自身出错时按"拦截"处理（fail-closed），见文件末尾的 catch。
// 规则引擎在 try 里动态加载：规则文件损坏、引擎语法错误时也能进 catch，而不是以退出码 1 退出（CodeBuddy 会当成放行）
try {
const { checkWrite, checkRead, checkShell, currentBranch, issueOf, planOf, ROOT } = await import('../lib/policy.mjs');

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* 空输入 */ }
const out = (o) => process.stdout.write(JSON.stringify(o));

// 各工具的参数名不统一（file_path / filePath / path / target_file；new_string / new_str），统一在这里取
const PATH_KEYS = ['file_path', 'filePath', 'path', 'target_file', 'targetFile'];
const pickPath = (...objs) => { for (const o of objs) for (const k of PATH_KEYS) if (o && typeof o[k] === 'string' && o[k]) return o[k]; return ''; };
const pickContent = (ti) => [ti.content, ti.new_string, ti.new_str, ti.newString,
  ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e?.new_string ?? e?.new_str ?? e?.newString) : [])]
  .filter((x) => typeof x === 'string').join('\n');
// 识别不出路径时按拦截处理（fail-closed），只列参数名、不列参数值，方便排查
const noPath = (what, o) => ({ decision: 'deny', reason: `没有识别出要${what}的文件路径（参数：${Object.keys(o || {}).join(', ') || '无'}），钩子按拦截处理` });

// 工具名各家不统一（Bash / execute_command / run_command；Read / read_file），不区分大小写
const SHELL_TOOL = /bash|shell|execute_command|run_command/i;
const READ_TOOL = /^(read|read_file)$/i;

function decide() {
  if (ev === 'shell') return checkShell(input.command || input.tool_input?.command || '');
  if (ev === 'read') { const f = pickPath(input, input.tool_input); return f ? checkRead(f) : noPath('读取', input.tool_input || input); }
  const ti = input.tool_input || {};
  const name = input.tool_name || '';
  if (SHELL_TOOL.test(name)) return checkShell(ti.command || '');
  if (READ_TOOL.test(name)) { const f = pickPath(ti); return f ? checkRead(f) : noPath('读取', ti); }
  const file = pickPath(ti, input);
  if (!file) return noPath('写入', ti);
  return checkWrite(file, pickContent(ti));
}

function session() {
  const b = currentBranch(), iss = issueOf(b), pl = iss && planOf(iss.n);
  return [
    `[opc] 当前分支：${b || '未知'}`,
    iss ? `[opc] 对应 Issue #${iss.n}；计划：${pl ? `${pl.file}（${pl.status}）` : '尚未写 docs/plans/' + iss.n + '-*.md'}` : '[opc] 当前不在任务分支上。开始新任务请先 /intent 或 /plan。',
    '[opc] 流程：intent(G1) → spec → plan(G2，你批准) → 构建 → 自检 → PR → 审查 → 合并(G3，你本人)',
  ].join('\n');
}

function stopCheck() {
  // 有未提交的代码改动时，结束前跑一次快速验证；失败就让 Agent 继续修（只拦一次，防止死循环）
  if (input.stop_hook_active || (input.loop_count ?? 0) >= 2) return '';
  let changed = '';
  try { changed = execSync('git status --porcelain', { cwd: ROOT }).toString(); } catch { return ''; }
  if (!/(apps|packages|packs|mcp)\//.test(changed)) return '';
  try { execSync('npm run -s verify:fast', { cwd: ROOT, stdio: 'pipe', timeout: 280000 }); return ''; }
  catch (e) { return '结束前自检失败（npm run verify:fast）。请修复实现代码后再结束；不要修改已有测试。\n' + String(e.stdout || '').slice(-1500); }
}

if (ev === 'session') {
  const ctx = session();
  if (tool === 'cursor') out({ additional_context: ctx }); else process.stdout.write(ctx);
  process.exit(0);
}

if (ev === 'stop') {
  const msg = stopCheck();
  if (!msg) { if (tool === 'cursor') out({}); process.exit(0); }
  if (tool === 'cursor') { out({ followup_message: msg }); process.exit(0); }
  process.stdout.write(msg); process.exit(2); // CodeBuddy：退出码 2 = 阻止结束并把消息交给 Agent
}

const { decision, reason } = decide();
if (tool === 'cursor') {
  // beforeShellExecution 支持 ask；preToolUse 只执行 allow/deny
  const d = decision === 'ask' && ev !== 'shell' ? 'deny' : decision;
  const msg = decision === 'ask' && d === 'deny' ? `需要你本人确认：${reason}。请停下来，在对话里向用户说明原因并等待用户亲自修改或明确同意。` : reason;
  out({ permission: d, user_message: msg || undefined, agent_message: msg || undefined });
  process.exit(0);
}
// CodeBuddy
if (decision === 'deny') blockCb(reason);
out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason || 'ok' } });
process.exit(0);

} catch (e) {
  // 规则脚本坏了就拦下（宁可多问一次，也不放过）
  const msg = '护栏脚本出错，已按拦截处理：' + String(e?.message || e).slice(0, 200);
  if (ev === 'session' || ev === 'stop') process.exit(0);
  if (tool === 'cursor') { process.stdout.write(JSON.stringify({ permission: 'deny', user_message: msg, agent_message: msg })); process.exit(0); }
  blockCb(msg);
}
