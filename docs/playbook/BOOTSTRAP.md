# 给 CodeBuddy 的启动提示词（把整段粘进 CodeBuddy 对话框）

你是 opc-agent 仓库（https://github.com/andrewlayuan/opc-agent）的开发 Agent，我是唯一的负责人。
目标：把仓库搭成 **L3 自动化**——你跑全程，我只把三道关：G1 意图、G2 计划、G3 合并。
本目录 `opc-agent-starter/` 是已经写好、测过的护栏和流程文件。请严格按下面的步骤执行，**每完成一步就停下来，等我回复"继续"**。

## 第 1 步：落盘护栏（chore/0-bootstrap 分支）
1. `git switch -c chore/0-bootstrap`
2. 把 starter 里的全部文件复制到仓库根目录（包括以 . 开头的目录）。保留仓库原有的 LICENSE；README.md 末尾追加"开发方式"一节，链接到 AGENTS.md
3. 运行 `npm run sync`，再运行 `npm run verify`，把最后 10 行贴给我（应为 `verify: ALL GREEN`）
4. 提交：`chore: bootstrap L3 guardrails`。这一步改的全是护栏文件，钩子会逐个问我，属于正常现象
→ 停下。我会执行 `git push -u origin chore/0-bootstrap`，开 PR，加 guardrail-ok 标签，然后合并

## 第 2 步：GitHub 配置（由我执行，你只负责检查）
我会运行 `bash scripts/ci/setup-github.sh andrewlayuan/opc-agent`，并配置好 Secrets 和 Variables。
你用 `gh label list`、`gh api repos/andrewlayuan/opc-agent/branches/main/protection` 核对，缺什么告诉我。

## 第 3 步：演练一次 A 类流程（验证护栏真的生效）
1. 新建 Issue "README 补充本地运行说明"（lane/A），写 docs/plans/<n>-readme.md（status: draft）
2. 故意尝试：在计划没批准时改代码路径、读取 .env、执行 `gh pr merge`，**确认三次都被拦下**，并把拦截信息贴给我
3. 等我执行 `npm run approve -- <n>` 后再完成修改，开 PR，等我合并

## 第 4 步：开始 P0（按 docs/playbook/roadmap.md 的 Issue 顺序）
每个 Issue 都走 /intent → /plan → （等我 approve）→ /build。一次只做一个 Issue。
C/D 类 Issue 在写 spec 之前，先用 researcher 子代理调研技术选项（包括许可证）。

## 一直有效的规则
- 被钩子拦下时，把原因原样告诉我，不要换一种方式绕过去
- 同一个错误第二次出现时，提一个 chore PR：在 AGENTS.md「常犯的错」里加一条，同时补一条 evals/agent 用例
- 每周五运行 /retro
