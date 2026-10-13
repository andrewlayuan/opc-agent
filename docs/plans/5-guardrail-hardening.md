---
issue: 5
status: approved
approved_by: jason bourne @ 2026-10-13 08:35
---
# 计划：加固本地钩子，并修复钩子自身的缺陷

规格：`docs/specs/5-guardrail-hardening.md`（R1–R12）。通道 C，分支 `chore/5-guardrail-hardening`。

## 改哪些文件（按顺序，顺序是硬约束）
R4 一落地，Agent 就不能再用编辑工具改护栏文件和已有测试。所以凡是要改这两类文件的步骤，都必须排在 R4 之前；R4 是最后一处改动。

1. `tests/guard-hardening.test.mjs`（新增）：R1–R10 的全部用例。命令规则类的用例直接导入 `checkShell` 做表驱动测试；钩子行为类的用例（R1–R4）用子进程调用 `guard.mjs`。写完先跑一遍，**确认在现有实现下失败**，把失败列表记下来贴进 PR。
2. `tests/guard.test.mjs`：只改"CodeBuddy：改护栏文件 → ask"这 1 个用例，改为断言退出码 2 且提示含"本人确认"（R4）。其余 14 个不动。
3. `tests/review-body.test.mjs`（新增）+ `scripts/ci/review-body.mjs`（新增）：先写测试再写实现（R11）。
4. `.github/prompts/review.md`：加一句"只输出报告本身，第一行就是 `## 🔴 必须改`"（R11）。
5. `.github/workflows/agent-review.yml`：评论前先经 `review-body.mjs` 处理（R11）。
6. `policy/opc.policy.json`：新增和收窄命令规则（R6、R7、R8、R9、R10）：
   - 收窄"执行批准脚本"的规则：只匹配执行，不匹配查看
   - 收窄"计划写成已批准"的规则：只匹配写入 `docs/plans/`，或解释器内联代码
   - 收窄 `gh label` 的规则：只匹配 `create`、`edit`、`delete`、`clone`
   - 新增：推 main 的各种写法、GraphQL 合并、写分支保护或 rulesets、执行 setup 脚本、各种加受控标签的方式、`gh auth token`、gh 配置目录、`sudo`
7. `scripts/lib/policy.mjs`：`checkShell` 增加两项：把命令拆成词，逐个按 `secretPaths` 匹配（R5）；当前分支是 main 时，拦不带目标的推送（R7）。
8. `scripts/hooks/guard.mjs`：分两次改：
   - 8a：在 `try` 里用动态 `import` 加载规则引擎（R1）；拦截原因同时写 stdout 和 stderr（R2）；工具名兼容（R3）
   - 8b（**最后一处改动**）：CodeBuddy 下，改文件类的"询问"降级为拦截（R4）

每一步做完都跑 `npm run verify:fast`。第 8b 步之后，如果还要改护栏文件或已有测试，我会停下来请你本人改，或请你明确授权，**不用命令去改**。

## 每条需求怎么证明
| R | 证据 |
|---|---|
| R1–R10 | `node --test tests/guard-hardening.test.mjs`：第 1 步写完时失败的用例清单，加上全部完成后全部通过的输出 |
| R4、R5（端到端） | 第 8b 步之后在 IDE 里实测：用编辑工具改 `policy/opc.policy.json` 被拦，提示含"本人确认"；用命令读一个内容为 `dummy` 的假密钥文件 `hooktest-dummy.pem` 被拦。测完删掉假文件 |
| R11 | `node --test tests/review-body.test.mjs`；PR 上 agent-review 的评论第一行是 `## 🔴 必须改` |
| R12 | `npm run verify` 最后 20 行；`git diff origin/main -- tests/guard.test.mjs` 只改了 1 个用例；`PR_LABELS=guardrail-ok node scripts/checks/guardrails.mjs origin/main` 通过 |

## 风险与回退
- **风险：钩子写错，导致什么都被拦**（R1 让出错一律拦截，R5 的拆词逻辑可能误伤），Agent 自己就没法修了 → 对策：每步跑 `verify:fast`；第 8 步前确认全部测试通过；R1 的拦截只针对加载失败，不扩展到其他异常
- **风险：误拦正常工作** → 对策：R5、R9 的放行用例写进测试；合并后遇到误拦，原样报给你，不绕过
- **风险：第 8b 步之后发现还要改** → 对策：停下来请你本人改，或请你授权
- **回退**：在 GitHub 网页上 Revert 这个 PR；钩子坏到 Agent 无法工作时，你在终端执行 `git revert`，或者临时删掉 `.codebuddy/settings.json` 里的 hooks 段。不涉及数据迁移

## 预计
- 改动约 300 行（测试约 170 行，规则与实现约 130 行）；新依赖：无
- 改的全是护栏文件和测试，PR 需要你本人加 `guardrail-ok`
