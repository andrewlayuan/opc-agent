---
issue: 5
status: draft        # 只能由你本人执行 npm run approve -- 5 改为批准（G2）
---
# 计划：加固本地钩子，并修复钩子自身的缺陷

规格：`docs/specs/5-guardrail-hardening.md`（R1–R12，其中 R4 已取消）。通道 C，分支 `chore/5-guardrail-hardening`。

## 修订记录
- **第 2 版（2026-10-13，构建中）**：取消 R4。负责人确认构建第 2 步修改已有测试时，IDE 弹了"询问"框，G1 决定 3 的降级前提不成立。随之改动：
  - `tests/guard.test.mjs` 恢复原样，不再修改任何已有测试
  - 原第 8b 步删除，不再有"最后一处改动"的顺序约束
  - 新测试里 R4 的两个降级用例改为"询问保持不变"的回归用例
  - 已完成的第 1 步（失败测试）保留，提交 6806c59。第 2 步的改动在本版中撤回
- 第 1 版：负责人于 2026-10-13 08:35 批准

## 改哪些文件（按顺序）
1. `tests/guard-hardening.test.mjs`（新增，**已完成**）：R1–R3、R5–R10 的用例，外加"询问保持不变"的回归用例。命令规则类直接导入 `checkShell` 做表驱动测试；钩子行为类用子进程调用 `guard.mjs`。在现有实现下的失败清单见提交 6806c59 和下方"证据"。
2. `tests/review-body.test.mjs`（新增，已写好，尚未提交）+ `scripts/ci/review-body.mjs`（新增）：先写测试再写实现（R11）。
3. `.github/prompts/review.md`：加一句"只输出报告本身，第一行就是 `## 🔴 必须改`"（R11）。
4. `.github/workflows/agent-review.yml`：评论前先经 `review-body.mjs` 处理（R11）。
5. `policy/opc.policy.json`：新增和收窄命令规则（R6、R7、R8、R9、R10）：
   - 收窄"执行批准脚本"的规则：只匹配执行，不匹配查看
   - 收窄"计划写成已批准"的规则：只匹配写入 `docs/plans/`，或解释器内联代码
   - 收窄 `gh label` 的规则：只匹配 `create`、`edit`、`delete`、`clone`
   - 新增：推 main 的各种写法、GraphQL 合并、写分支保护或 rulesets、执行 setup 脚本、各种加受控标签的方式、`gh auth token`、gh 配置目录、`sudo`
6. `scripts/lib/policy.mjs`：`checkShell` 增加两项：把命令拆成词，逐个按 `secretPaths` 匹配（R5）；当前分支是 main 时，拦不带目标的推送（R7）。
7. `scripts/hooks/guard.mjs`：在 `try` 里用动态 `import` 加载规则引擎（R1）；拦截原因同时写 stdout 和 stderr（R2）；工具名兼容（R3）。

第 3–7 步改的都是护栏文件，每次用编辑工具写入，IDE 都会弹"询问"框，**请看清文件名再点允许**。每一步做完都跑 `npm run verify:fast`。

## 每条需求怎么证明
| R | 证据 |
|---|---|
| R1–R3、R5–R10 | `node --test tests/guard-hardening.test.mjs`：第 1 步写完时的失败清单，加上全部完成后全部通过的输出 |
| R5（端到端） | 完成后在 IDE 里实测：用命令读一个内容为 `dummy` 的假密钥文件 `hooktest-dummy.pem` 被拦。测完删掉假文件 |
| R11 | `node --test tests/review-body.test.mjs`；PR 上 agent-review 的评论第一行是 `## 🔴 必须改` |
| R12 | `npm run verify` 最后 20 行；`git diff origin/main -- tests/guard.test.mjs` 为空；`PR_LABELS=guardrail-ok node scripts/checks/guardrails.mjs origin/main` 通过 |

## 风险与回退
- **风险：钩子写错，导致什么都被拦**（R1 让出错一律拦截，R5 的拆词逻辑可能误伤），Agent 自己就没法修了 → 对策：第 7 步放在最后；改之前确认第 5、6 步的测试全部通过；R1 的拦截只针对加载失败，不扩展到其他异常
- **风险：误拦正常工作** → 对策：R5、R9 的放行用例写进测试；合并后遇到误拦，原样报给你，不绕过
- **回退**：在 GitHub 网页上 Revert 这个 PR；钩子坏到 Agent 无法工作时，你在终端执行 `git revert`，或者临时删掉 `.codebuddy/settings.json` 里的 hooks 段。不涉及数据迁移

## 预计
- 改动约 300 行（测试约 180 行，规则与实现约 120 行）；新依赖：无
- 改的全是护栏文件和测试，PR 需要你本人加 `guardrail-ok`
