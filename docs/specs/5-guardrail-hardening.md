---
issue: 5
intent: docs/intent/5-guardrail-hardening.md
---
# 规格：加固本地钩子，并修复钩子自身的缺陷

范围按 intent 中"调研后的修订"：这次不动本机 gh 登录。Agent 独立身份、服务端 G3、CI 校验标签操作人都放到 #6。
本次只做两件事：本地钩子尽量拦住已知写法；修复钩子自身的缺陷。

## 已实测的现状（构建前）
- 规则文件损坏时，`guard.mjs` 以退出码 1 退出。CodeBuddy 把它当作非阻塞错误，结果是**放行**，连读密钥也不拦（临时副本实测）。
- CodeBuddy IDE 对改文件类的"询问"**不弹框，直接放行**（负责人确认：10 月 12 日追加测试时没有弹框）。这意味着现在 Agent 用编辑工具改护栏文件、改已有测试，实际上不受限制。
- 对命令类的"询问"，IDE 会弹框（10 月 13 日一条只读命令因为文本里含推送命令而弹框，最后超时）。
- 误拦：查看批准脚本源码、往测试里追加同时含计划目录和"已批准"字样的用例、列出标签后用 grep 查找，这三种都被拦过。

## 需求

| 编号 | 需求（必须可验证） | 怎么验证 | 优先级 |
|---|---|---|---|
| R1 | **出错即拦截**：规则引擎或规则文件加载失败时，pre / read / shell 事件一律拦截（CodeBuddy 退出码 2，Cursor 返回 deny），提示"护栏脚本出错"；session / stop 事件不受影响，退出码 0 | 测试：把钩子脚本复制到临时目录，配一份损坏的规则文件，分别跑各事件 | 必须 |
| R2 | **拦截原因写到 stdout 和 stderr**：CodeBuddy 退出码 2 时，两个输出都要有拦截原因（IDE 文档说读 stderr，CLI 文档说优先读 stdout） | 测试：断言 stderr 里有原因 | 必须 |
| R3 | **工具名兼容**：`execute_command`、`run_command` 按命令规则处理；`read_file` 按读规则处理；不区分大小写 | 测试 | 必须 |
| R4 | **改文件类的"询问"降级为拦截**：CodeBuddy 下，改护栏文件、改已有测试这类原本返回"询问"的写入，改为拦截，提示里写明"需要你本人确认"（和 Cursor 一致）。命令类的"询问"保持不变 | 测试：改护栏文件、改已有测试 → 退出码 2，提示含"本人确认"；推送到功能分支仍返回 ask。另在 IDE 里实测一次改护栏文件被拦 | 必须 |
| R5 | **命令里出现密钥路径就拦**：只要命令里有任一路径命中 `secretPaths`（相对路径、绝对路径、引号内、重定向、`=` 赋值都算），不管用什么命令，一律拦截 | 表驱动测试：sed、grep、awk、python、node、重定向、cp、base64、绝对路径、引号内各一例，都要拦；`cat .gitignore`、`ls docs`、`git status` 要放行。另在 IDE 里用假密钥文件实测一次 | 必须 |
| R6 | **不打印凭据**：拦 `gh auth token`，拦读取 gh 配置目录（`.config/gh/`） | 测试 | 必须 |
| R7 | **合并、推 main、改保护设置**：以下操作都要拦：<br>• 推送目标是 main / master 的各种写法（`-u origin main`、`x:main`、`refs/heads/main`）<br>• 当前分支是 main / master 时，不带目标的 `git push`、`git push origin HEAD`<br>• 用 GraphQL 合并（`mergePullRequest`、`enablePullRequestAutoMerge`）<br>• 用 `gh api` 写分支保护或 rulesets（读取放行）<br>• 执行 `scripts/ci/setup-github.sh`<br>推送到功能分支仍返回 ask | 测试 | 必须 |
| R8 | **受控标签**：`guardrail-ok`、`agent/build` 两个标签，通过以下方式添加都要拦：`gh pr` / `gh issue` 的 `create`、`edit` 加 `--label`、`--add-label`；`gh api` 写 labels；`gh label create`、`edit`、`delete`、`clone`；GraphQL `addLabelsToLabelable`。<br>`gh label list`（包括后面接 grep 查这两个名字）要放行；Issue 或 PR 正文里提到这两个名字也要放行 | 测试 | 必须 |
| R9 | **修复三处误拦，不放松原有拦截**：<br>• 查看批准脚本源码（cat、sed、grep 这个文件）放行；执行它（`npm run approve`、`node scripts/ci/approve.mjs`、直接执行该路径）仍然拦<br>• 命令同时出现计划目录和"已批准"字样，但不写计划文件时，放行。用重定向、tee、`sed -i`、cp、mv 写入 `docs/plans/` 且内容含"已批准"，或者用解释器内联代码同时涉及这两者时，仍然拦<br>• `gh label list \| grep guardrail-ok` 放行（同 R8） | 测试：每类放行一例、拦截多例 | 必须 |
| R10 | **拦 `sudo`**（`.codebuddy/settings.json` 的 deny 里有，规则文件里没有） | 测试 | 应该 |
| R11 | **AI 审查评论只含报告**：<br>• `review.md` 提示词要求只输出报告<br>• 新增 `scripts/ci/review-body.mjs`，去掉第一个 `## ` 标题之前的内容；如果结果为空，输出一句"AI 审查没有产出内容，见 Actions 日志"，评论步骤不再因为内容为空而失败<br>• `agent-review.yml` 改用这个脚本 | `tests/review-body.test.mjs` | 必须 |
| R12 | **不回归**：原有 15 个钩子测试，除 R4 需要改的 1 个外，其余不改并且全部通过；`npm run verify` 全绿；本地模拟 CI guardrails 时，带上 `guardrail-ok` 能通过 | `npm run verify`；`PR_LABELS=guardrail-ok node scripts/checks/guardrails.mjs origin/main` | 必须 |

## 关注点（冲突点或取舍，标出由谁拍板）
- **只能拦已知写法**：命令规则是"尽量拦住常见写法"，挡不住刻意混淆，比如变量拼接、通配符、编码后执行。10 月 13 日我自己就写过拼接字符串的命令（已停止这么做）。真正的防线是 #6 的独立身份和文件权限隔离。由负责人决定先做本次、#6 待办（已拍板）。
- **误拦**：R5 会拦掉 `ls .env.example`、`git check-ignore .env` 这类无害命令。负责人已接受，需要时本人执行。
- **R4 之后 Agent 不能再改护栏文件和已有测试**：用编辑工具改会被拦，只能请负责人本人改，或者负责人明确授权。这也包括本 PR 在 R4 落地之后的修改。所以构建顺序必须把 R4 放在最后（见计划）。
- **修改 1 个已有测试**：`tests/guard.test.mjs` 里的"CodeBuddy：改护栏文件 → ask"，按 R4 改为断言拦截，并提示"本人确认"。这是负责人在 G1 决定 3 确认的行为变化，不是"改测试凑通过"，PR 里会单独说明。
- 隐私：不新增外发地址 ｜ 成本：无 ｜ 许可证：不新增依赖

## 不在本次范围
- Agent 独立身份、服务端 G3、CI 校验标签操作人、PR 改 workflow 让检查自己通过、密钥文件权限隔离：都在 #6
- 用命令写护栏文件或代码路径：本地不拦，靠 CI guardrails 兜底（护栏文件要 `guardrail-ok`，R8 让 Agent 加不了；代码路径要已批准的计划，R9 让 Agent 写不了）
- 新增 `evals/agent` 用例
