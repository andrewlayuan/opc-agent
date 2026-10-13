# opc-agent
开源沉淀"一人公司"经营全生命周期能力（战略/市场/产品/注册/营销/法务/财务…），只说目标，自动编排 Agent·Skill·MCP 端到端交付。全本地运行、隐私优先、社区共建。

## 开发方式

本仓库按 L3 流程开发：AI Agent（CodeBuddy / Cursor）跑全程，负责人只守三道关——G1 意图、G2 计划批准（`npm run approve -- <n>`）、G3 合并。

- Agent 工作说明与红线：[AGENTS.md](AGENTS.md)
- 全量验证：`npm run verify`（健康输出最后一行为 `verify: ALL GREEN`）
- 路线图：[docs/playbook/roadmap.md](docs/playbook/roadmap.md)

## 本地运行

**环境**：Node.js >= 22.18（见 `package.json` 的 `engines`），以及 git。

```bash
npm install            # 安装依赖
npm run sync           # 把 .agents/ 同步到 .codebuddy/ 和 .cursor/（只改 .agents/，改完运行它）
npm run verify         # 全量验证，最后一行应为 verify: ALL GREEN
npm run approve -- <n> # G2：批准 docs/plans/<n>-*.md，只能由负责人本人在自己的终端执行
```

`npm run approve` 会以 `git config user.name` 记录批准人并提交一次，运行前请先设置 git 的 `user.name` 和 `user.email`。

**钩子**：用 CodeBuddy 或 Cursor 打开仓库根目录即可加载，配置分别在 `.codebuddy/settings.json` 和 `.cursor/hooks.json`。新会话开头出现 `[opc] 当前分支：…` 就说明钩子已生效。

**常见问题**

| 现象 | 原因 | 处理 |
|---|---|---|
| `npm run verify` 报 `Could not find '…/tests/**/*.test.mjs'` | Node 版本过低（实测 Node 20 的 `node --test` 不展开通配符） | 升级到 Node >= 22.18 |
| 会话开头显示 `当前分支：未知`，改代码时提示"分支名 不符合约定" | git 无法工作，常见原因是仓库目录属主与当前用户不一致（git 报 dubious ownership） | 让仓库目录属主与当前用户一致后，重开会话 |
