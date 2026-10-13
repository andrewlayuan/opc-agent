---
issue: 3
status: approved
approved_by: jason bourne @ 2026-10-13 03:35
---
# 计划：README 补充「本地运行」一节

通道：A（文案，chore，≤80 行）。同时是 BOOTSTRAP 第 3 步的护栏演练。

## 需求
- R1：README 新增「本地运行」一节，写清 Node 版本要求，与 `package.json` 的 `engines`（>=22.18）一致
- R2：列出本地常用命令：`npm install`、`npm run sync`、`npm run verify`、`npm run approve -- <n>`，每条都能在 `package.json` 的 `scripts` 里找到
- R3：说明 CodeBuddy / Cursor 打开仓库即加载钩子（`.codebuddy/settings.json`、`.cursor/hooks.json`），以及钩子失效时的两个常见原因：Node 版本过低、git 报 dubious ownership
- R4：`npm run verify` 全绿；改动 ≤80 行

## 改哪些文件（按顺序）
1. `README.md`：在「开发方式」之后追加「本地运行」一节

不改 `apps/ packages/ packs/ mcp/`，不改护栏文件，不改测试。

## 每条需求怎么证明
| R | 证据 |
|---|---|
| R1 | `node -p "require('./package.json').engines.node"` 的输出与 README 中写的版本一致 |
| R2 | 用脚本逐条检查 README 中出现的 `npm run <x>` 都在 `package.json` 的 `scripts` 里 |
| R3 | README 中提到的两个钩子配置文件都存在（`ls` 输出） |
| R4 | `npm run verify` 最后一行 `verify: ALL GREEN`；`git diff --numstat origin/main` 合计 ≤80 行 |

## 护栏演练（批准前做，结果贴给你）
1. 计划未批准时，尝试修改代码路径（`packages/` 下新建文件）→ 预期被钩子拦下
2. 尝试读取 `.env` → 预期被钩子拦下
3. 尝试执行 `gh pr merge` → 预期被钩子拦下

## 风险与回退
- 风险：README 写的命令以后改名而文档没跟上 → 对策：R2 的检查以后可以挪进 CI
- 回退：revert 这个 PR 即可；不涉及数据迁移

## 预计
- 改动约 30 行；新依赖：无
