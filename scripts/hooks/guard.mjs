#!/usr/bin/env node
// 统一钩子入口：CodeBuddy 和 Cursor 都调用这一个脚本，内部翻译两家的输入/输出格式。
// 用法：node scripts/hooks/guard.mjs <cb|cursor> <pre|read|shell|stop|session>
//   CodeBuddy：退出码 2 = 阻止；JSON 用 hookSpecificOutput.permissionDecision（支持 ask）
//   Cursor   ：输出 {"permission":"allow|deny|ask"}；preToolUse 不执行 ask，所以 ask 降级为 deny 并提示找你本人
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
// 注意：脚本自身出错时按"拦截"处理（fail-closed），见文件末尾的 catch
import { checkWrite, checkRead, checkShell, currentBranch, issueOf, planOf, ROOT } from '../lib/policy.mjs';

const [, , tool = 'cb', ev = 'pre'] = process.argv;
try {

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* 空输入 */ }
const out = (o) => process.stdout.write(JSON.stringify(o));

function decide() {
  if (ev === 'shell') return checkShell(input.command || input.tool_input?.command || '');
  if (ev === 'read') return checkRead(input.file_path || input.tool_input?.file_path || '');
  const ti = input.tool_input || {};
  const name = input.tool_name || '';
  if (/Bash|Shell/.test(name)) return checkShell(ti.command || '');
  if (/^Read$/.test(name)) return checkRead(ti.file_path || ti.path || '');
  const file = ti.file_path || ti.path || ti.target_file || input.file_path || '';
  const content = ti.content ?? ti.new_string ?? (Array.isArray(ti.edits) ? ti.edits.map((e) => e.new_string).join('\n') : '');
  return checkWrite(file, content);
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
if (decision === 'deny') { process.stdout.write(reason); process.exit(2); }
out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason || 'ok' } });
process.exit(0);

} catch (e) {
  // 规则脚本坏了就拦下（宁可多问一次，也不放过）
  const msg = '护栏脚本出错，已按拦截处理：' + String(e?.message || e).slice(0, 200);
  if (ev === 'session' || ev === 'stop') process.exit(0);
  if (tool === 'cursor') { process.stdout.write(JSON.stringify({ permission: 'deny', user_message: msg, agent_message: msg })); process.exit(0); }
  process.stdout.write(msg); process.exit(2);
}
