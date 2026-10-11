# opc-agent L3 Starter Kit

这是一套可以直接放进 opc-agent 仓库的 **L3 开发护栏和流程文件**，CodeBuddy 和 Cursor 都能用。

## 怎么用
1. 把本目录交给 CodeBuddy，粘贴 `docs/playbook/BOOTSTRAP.md` 里的提示词
2. 或者手动操作：把全部文件复制到仓库根目录 → 运行 `npm run sync && npm run verify` → 推到 `chore/0-bootstrap` 分支并开 PR

## 文件一览
| 位置 | 作用 |
|---|---|
| AGENTS.md / CODEBUDDY.md | 唯一的 Agent 说明。CodeBuddy 通过 `@AGENTS.md` 导入，Cursor 原生读取 |
| .agents/ | 技能、子代理、命令的**唯一源**。运行 `npm run sync` 生成 .codebuddy/ 和 .cursor/ 下的副本 |
| policy/ | 硬规则（opc.policy.json）、外发白名单、控制带 |
| scripts/hooks/guard.mjs | 两家工具共用的钩子，兼容两家的输入输出格式 |
| scripts/checks/guardrails.mjs | CI 必需检查，和钩子用同一份规则 |
| scripts/ci/approve.mjs | G2：只有你本人能在终端里批准计划 |
| .github/workflows/ | ci / agent-build / agent-autofix / agent-review / nightly / mirror-gitee / release |
| evals/agent/ | Agent 配置回归评估 |
| docs/ | 模板、架构、路线图、启动提示词 |
