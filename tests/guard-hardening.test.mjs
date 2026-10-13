// #5 护栏加固（docs/specs/5-guardrail-hardening.md 的 R1–R10，R4 已取消）。
// 钩子行为（R1–R3）用子进程调用 guard.mjs；命令规则（R5–R10）直接调 checkShell 做表驱动。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { checkShell, ROOT } from '../scripts/lib/policy.mjs';

const GUARD = path.join(ROOT, 'scripts/hooks/guard.mjs');
const run = (tool, ev, input, branch = 'main', guard = GUARD) => {
  const r = spawnSync('node', [guard, tool, ev], { input: JSON.stringify(input), cwd: ROOT, env: { ...process.env, OPC_BRANCH: branch } });
  return { code: r.status, out: r.stdout.toString(), err: r.stderr.toString() };
};
const decisionOf = (r) => JSON.parse(r.out).hookSpecificOutput.permissionDecision;

function withBranch(branch, fn) {
  const old = process.env.OPC_BRANCH;
  process.env.OPC_BRANCH = branch;
  try { return fn(); } finally { if (old === undefined) delete process.env.OPC_BRANCH; else process.env.OPC_BRANCH = old; }
}
function expectAll(cmds, want, branch = 'feat/5-x') {
  const wrong = cmds.map((c) => [c, withBranch(branch, () => checkShell(c).decision)]).filter(([, d]) => d !== want);
  assert.deepEqual(wrong, [], `期望全部为 ${want}（分支 ${branch}）`);
}

// —— R1：规则引擎或规则文件加载失败时一律拦截 ——
test('R1 规则文件损坏：pre / read / shell 一律拦截，session / stop 不受影响', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opc-guard-'));
  try {
    mkdirSync(path.join(dir, 'scripts/hooks'), { recursive: true });
    mkdirSync(path.join(dir, 'scripts/lib'), { recursive: true });
    mkdirSync(path.join(dir, 'policy'));
    copyFileSync(GUARD, path.join(dir, 'scripts/hooks/guard.mjs'));
    copyFileSync(path.join(ROOT, 'scripts/lib/policy.mjs'), path.join(dir, 'scripts/lib/policy.mjs'));
    writeFileSync(path.join(dir, 'policy/opc.policy.json'), '{ broken json');
    const g = path.join(dir, 'scripts/hooks/guard.mjs');
    for (const input of [
      { tool_name: 'Read', tool_input: { file_path: 'secrets/a.json' } },
      { tool_name: 'Bash', tool_input: { command: 'ls' } },
      { tool_name: 'Write', tool_input: { file_path: 'docs/a.md', content: 'x' } },
    ]) {
      const r = run('cb', 'pre', input, 'main', g);
      assert.equal(r.code, 2, `CodeBuddy ${input.tool_name}`);
      assert.match(r.out + r.err, /护栏脚本出错/);
    }
    for (const ev of ['pre', 'read', 'shell']) {
      const r = run('cursor', ev, { tool_name: 'Write', tool_input: { file_path: 'a' }, file_path: 'a', command: 'ls' }, 'main', g);
      assert.equal(r.code, 0, `Cursor ${ev} 退出码`);
      assert.equal(JSON.parse(r.out).permission, 'deny', `Cursor ${ev}`);
    }
    for (const [tool, ev] of [['cb', 'session'], ['cb', 'stop'], ['cursor', 'session'], ['cursor', 'stop']])
      assert.equal(run(tool, ev, {}, 'main', g).code, 0, `${tool} ${ev}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// —— R2：拦截原因同时写 stdout 和 stderr ——
test('R2 CodeBuddy 拦截时 stdout 和 stderr 都有原因', () => {
  const r = run('cb', 'pre', { tool_name: 'Read', tool_input: { filePath: '.env.local' } });
  assert.equal(r.code, 2);
  assert.match(r.out, /密钥/);
  assert.match(r.err, /密钥/);
});

// —— R3：工具名兼容 ——
test('R3 execute_command / run_command 按命令规则处理，不区分大小写', () => {
  const merge = run('cb', 'pre', { tool_name: 'execute_command', tool_input: { command: 'gh pr merge 1' } });
  assert.equal(merge.code, 2); assert.match(merge.out, /G3/);
  for (const name of ['execute_command', 'run_command', 'Execute_Command']) {
    const r = run('cb', 'pre', { tool_name: name, tool_input: { command: 'ls docs' } });
    assert.equal(r.code, 0, name); assert.equal(decisionOf(r), 'allow', name);
  }
});
test('R3 read_file 按读规则处理（读护栏文件放行，不当成写）', () => {
  const r = run('cb', 'pre', { tool_name: 'read_file', tool_input: { filePath: 'policy/opc.policy.json' } });
  assert.equal(r.code, 0); assert.equal(decisionOf(r), 'allow');
  assert.equal(run('cb', 'pre', { tool_name: 'READ_FILE', tool_input: { filePath: '.env' } }).code, 2);
});

// —— 询问保持不变（R4 已取消：负责人确认 IDE 对改文件的询问会弹框）——
test('改护栏文件、改已有测试仍是 ask（camelCase 参数）', () => {
  for (const ti of [{ filePath: 'policy/opc.policy.json', new_str: '{}' }, { filePath: 'tests/guard.test.mjs', new_str: 'x' }]) {
    const r = run('cb', 'pre', { tool_name: 'Edit', tool_input: ti }, 'chore/9-x');
    assert.equal(r.code, 0, ti.filePath); assert.equal(decisionOf(r), 'ask', ti.filePath);
  }
});
test('推送到功能分支仍是 ask', () => {
  const r = run('cb', 'pre', { tool_name: 'Bash', tool_input: { command: 'git push -u origin chore/9-x' } }, 'chore/9-x');
  assert.equal(r.code, 0); assert.equal(decisionOf(r), 'ask');
});

// —— R5：命令里出现密钥路径就拦，不管用什么命令 ——
test('R5 读密钥的各种写法都拦', () => {
  expectAll([
    'sed -n 1p .env',
    'grep TOKEN .env.local',
    'awk 1 config/.env',
    `python3 -c "print(open('.env').read())"`,
    `node -e "console.log(require('fs').readFileSync('.env','utf8'))"`,
    'while read l; do echo "$l"; done < .env',
    'cp .env /tmp/x',
    'base64 secrets/token.json',
    `cat ${path.join(ROOT, '.env')}`,
    'less "secrets/a.json"',
    'X=$(head -c 10 deploy.pem)',
    'git show HEAD:.env',
    'cat .opc/settings.json',
    'xxd ~/.ssh/id_ed25519',
    'tar czf /tmp/s.tgz secrets',
  ], 'deny');
});
test('R5 不含密钥路径的普通命令放行', () => {
  expectAll(['cat .gitignore', 'ls docs', 'git status --short', 'node --test tests/guard.test.mjs', 'grep -n env package.json', 'cat docs/environment.md'], 'allow');
});

// —— R6：不打印凭据 ——
test('R6 打印 gh 令牌、读 gh 配置目录都拦', () => {
  expectAll([
    'gh auth token',
    'gh auth status --show-token',
    'cat ~/.config/gh/hosts.yml',
    `cat ${path.join(homedir(), '.config/gh/hosts.yml')}`,
    'echo host=github.com | gh auth git-credential get',
    'printf "protocol=https\\nhost=github.com\\n" | git credential fill',
  ], 'deny');
  expectAll(['gh auth status', 'gh pr view 4'], 'allow');
});

// —— R7：合并、推 main、改保护设置 ——
test('R7 推送目标是 main / master 的各种写法都拦', () => {
  expectAll([
    'git push -u origin main',
    'git push origin chore/x:main',
    'git push origin HEAD:refs/heads/main',
    'git push --force-with-lease origin main',
    'git push origin +master',
    'git -C /tmp/x push origin main',
    'cd repo && git push origin main 2>&1 | tail -3',
    'git push --all origin',
  ], 'deny');
});
test('R7 当前在 main 上时，不写目标的推送也拦', () => {
  expectAll(['git push', 'git push origin HEAD', 'git push -u origin'], 'deny', 'main');
  expectAll(['git push', 'git push origin HEAD'], 'deny', 'master');
});
test('R7 推到功能分支仍是 ask（包括分支名里含 main）', () => {
  expectAll(['git push -u origin chore/5-guardrail-hardening', 'git push origin feat/main-menu', 'git push', 'git push origin HEAD'], 'ask');
});
test('R7 GraphQL 合并、写分支保护或 rulesets、执行 setup 脚本都拦', () => {
  expectAll([
    `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`,
    `gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: "x"}) { clientMutationId } }'`,
    'gh api -X PUT repos/o/r/branches/main/protection --input p.json',
    'gh api --method DELETE repos/o/r/branches/main/protection',
    'gh api repos/o/r/branches/main/protection/enforce_admins -X DELETE',
    'gh api repos/o/r/rulesets -f name=x',
    'bash scripts/ci/setup-github.sh o/r',
    './scripts/ci/setup-github.sh',
  ], 'deny');
});
test('R7 读取分支保护、查看 setup 脚本放行', () => {
  expectAll(['gh api repos/o/r/branches/main/protection --jq .required_status_checks', 'gh api repos/o/r/rulesets', 'cat scripts/ci/setup-github.sh'], 'allow');
});

// —— R8：受控标签 guardrail-ok / agent/build ——
test('R8 各种加受控标签的方式都拦', () => {
  expectAll([
    'gh pr create --title t --label guardrail-ok',
    'gh pr create -t t -l lane/A,guardrail-ok',
    'gh pr edit 4 --add-label guardrail-ok',
    'gh issue edit 6 --add-label "agent/build"',
    'gh issue create -t x --label=agent/build',
    'gh api repos/o/r/issues/4/labels -f "labels[]=guardrail-ok"',
    'gh api -X PUT repos/o/r/issues/4/labels --input l.json',
    'gh label create guardrail-ok --color b60205',
    'gh label edit lane/A --name guardrail-ok',
    'gh label delete agent/build --yes',
    'gh label clone other/repo',
    `gh api graphql -f query='mutation { addLabelsToLabelable(input: {labelableId: "x", labelIds: ["y"]}) { clientMutationId } }'`,
  ], 'deny');
});
test('R8 列标签、查标签、正文里提到受控标签放行', () => {
  expectAll([
    'gh label list',
    "gh label list --json name --jq '.[].name' | grep -x guardrail-ok",
    'gh pr edit 4 --add-label lane/A',
    'gh issue create --title t --body "合并前需要负责人加 guardrail-ok 标签" --label lane/C',
    "gh pr view 4 --json labels --jq '.labels[].name' | grep guardrail-ok",
    'gh api repos/o/r/issues/4/labels',
  ], 'allow');
});

// —— R9：修复三处误拦，不放松原有拦截 ——
test('R9 查看批准脚本放行，执行仍拦', () => {
  expectAll(['cat scripts/ci/approve.mjs', 'sed -n 1,20p scripts/ci/approve.mjs', 'grep -n user scripts/ci/approve.mjs', `cd ${ROOT} && cat scripts/ci/approve.mjs`], 'allow');
  expectAll([
    'npm run approve -- 5',
    'npm run -s approve -- 5',
    'npm run --silent approve -- 5',
    'pnpm approve 5',
    'node scripts/ci/approve.mjs 5',
    `node ${ROOT}/scripts/ci/approve.mjs 5`,
    './scripts/ci/approve.mjs 5',
    'cd x && node ./scripts/ci/approve.mjs 5',
  ], 'deny');
});
test('R9 出现计划目录和 approved 但不写计划文件：放行', () => {
  expectAll([
    'grep -n approved docs/plans/3-readme.md',
    'git log --oneline -- docs/plans/ | grep approved',
    "cat >> tests/x.test.mjs <<'EOF'\nrun({ filePath: 'docs/plans/3-x.md', new_str: 'status: approved' });\nEOF",
  ], 'allow');
});
test('R9 把 approved 写进计划文件：仍拦', () => {
  expectAll([
    'echo "status: approved" >> docs/plans/5-x.md',
    "printf 'approved' | tee docs/plans/5-x.md",
    "sed -i 's/draft/approved/' docs/plans/5-x.md",
    'cp /tmp/approved.md docs/plans/5-x.md',
    "cat > docs/plans/5-x.md <<'EOF'\nstatus: approved\nEOF",
    `echo approved > ${ROOT}/docs/plans/5-x.md`,
    `node -e "require('fs').writeFileSync('docs/plans/5-x.md','status: approved')"`,
    `python3 -c "open('docs/plans/5-x.md','w').write('approved')"`,
    "python3 - <<'EOF'\nopen('docs/plans/5-x.md','w').write('approved')\nEOF",
    "perl -pi -e 's/draft/approved/' docs/plans/5-x.md",
  ], 'deny');
});

// —— R10：sudo ——
test('R10 sudo 被拦', () => {
  expectAll(['sudo ls', 'cd /tmp && sudo rm x'], 'deny');
});
