# opc-agent · Agent 工作说明（CodeBuddy 和 Cursor 共用，控制在一页内）

## 这是什么
opc-agent 是一个开源的"一人公司经营 Agent"。它在本地运行、隐私优先，用 Agent、Skill 和 MCP 自动编排，端到端交付结果。
当前阶段是 **P0 情报雷达**：收集 AI 领域的产品、技术、市场信息，然后去重、总结、分析，输出日报和周报。
后续会以「能力包」的形式扩展到战略、市场、产品、注册、营销、法务、财务。

## 怎么跑（一条命令验证）
- 安装依赖：`npm install`
- 全量验证：`npm run verify`（等于 lint + 单元测试 + 护栏检查 + 评估）。健康输出的最后一行是 `verify: ALL GREEN`
- 快速验证：`npm run verify:fast`（结束任务前，钩子会自动跑这一项）
- 同步 Agent 配置：`npm run sync`（只改 `.agents/` 里的源文件，然后运行它生成两家工具的副本）

## 去哪找
- 架构与分层：`docs/architecture.md`。核心是 `packages/core`，能力包放在 `packs/<域>`，入口在 `apps/cli`，自有 MCP 服务放在 `mcp/`
- 一个需求对应三份文件：`docs/intent/<n>-*.md` → `docs/specs/<n>-*.md` → `docs/plans/<n>-*.md`，模板在 `docs/templates/`
- 技术决策：`docs/decisions/`；路线图：`docs/playbook/roadmap.md`

## 工作流程（L3：AI 跑全程，人只把三道关）
1. `/intent` 写意图 → **G1：用户确认要不要做**
2. `/spec` 写规格（R1、R2…），`/plan` 写计划，计划里保持 `status: draft` → **G2：用户本人执行 `npm run approve -- <n>`**
3. 在 `feat|fix|chore/<n>-<短名>` 分支上构建 → 自检 → 提交 PR（PR 描述里填验收包）→ **G3：用户本人合并**
- CI 失败时最多自动修 2 次，修不好就停下来，在 PR 里写清楚卡在哪里

## 红线（钩子和 CI 会强制执行，违反就停下来问用户）
- 没有已批准的计划就不改 `apps/ packages/ packs/ mcp/`；不在 main 上直接改
- **修缺陷不改已有测试**；测试错了就在 PR 里说明，由用户改
- 不读、不写、不打印密钥（`.env*`、`secrets/`、`*.pem`）；不把用户数据发到白名单以外的地址
- 不改护栏文件（`policy/ scripts/hooks|lib|checks|ci/ .github/workflows/ evals/agent/`），要改就请用户本人确认
- 不合并 PR、不发布、不强推、不加 `guardrail-ok` / `agent/build` 标签
- 法务、财务、注册类能力（`packs/legal|finance|registration`）属于 D 类：输出必须带"仅供参考，需专业人士复核"，并且必须人工审代码

## 代码约定
- TypeScript（Node ≥ 22，ESM）。测试用 `node --test`，测试文件和被测文件放在一起，命名为 `*.test.ts`
- 默认用本地模型（Ollama），云端模型只能通过 `packages/core/llm` 的 Provider 接入，并且需要用户在配置里显式开启
- 每个能力包都必须有 `pack.json`、`skills/`、`evals/`，分析结论必须附上来源链接

## Agent 常犯的错（同一个错出现第二次，就在这里加一条）
- 给信息源写抓取代码时忘了限速和缓存 → 统一用 `packages/core/fetch` 的 `politeFetch`
- 总结里编造出处 → 只能引用 `items` 表里已有的 URL
