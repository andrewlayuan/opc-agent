# opc-agent 架构（给 Agent 和你自己看的一页纸）

## 分层
```
apps/cli            opc 命令行：opc radar run | opc report daily | opc ask "…"
apps/desktop        （P2 再做）本地 Web 界面，127.0.0.1 only
packages/core       运行时内核：编排器、能力包加载器、LLM Provider、politeFetch、存储、事件总线、审计日志
packs/<域>          能力包 = 技能(SKILL.md) + 工具函数 + MCP 连接 + 评估；P0 只有 radar
mcp/<名>            自有 MCP 服务（把 opc 的数据和工具暴露给 CodeBuddy / Cursor / 其他 Agent 使用）
```
依赖方向：apps → packages/core ← packs。**包与包之间不能互相 import**，只能通过 core 的事件和数据表交互。

## 运行时（本地优先、隐私优先）
- 数据：`~/.opc/opc.db`（SQLite），表 `sources / items / clusters / insights / reports / audit`
- 模型：默认 Ollama（`localhost:11434`），可选云端（OpenAI 兼容接口 / 混元 / DeepSeek），需要在 `~/.opc/config.json` 里显式开启，并逐个能力包授权
- 外发网络：只允许 `policy/egress.allowlist` 里的地址；每次外发都写审计日志
- 密钥：只放在系统钥匙串或 `~/.opc/credentials`（权限 600），不进仓库，也不进日志

## P0 情报雷达流水线
```
采集 sources/*  →  标准化 RawItem  →  去重聚类（URL 规范化 + 标题相似度 + 向量）
  →  打标签（产品 / 技术 / 市场 + 公司 + 主题）  →  打分（新颖度 × 相关度 × 来源权重）
  →  总结（insight-report 技能：结论 → 要点 → 对 OPC 的影响，全部带引用）
  →  输出：Markdown 日报/周报 + 竞品卡片 + MCP 查询接口
```

## 能力包契约 pack.json
```json
{ "id": "radar", "version": "0.1.0", "lane": "C",
  "skills": ["skills/daily-brief", "skills/competitor-card"],
  "tools": ["src/tools.ts"], "mcp": [], "dataScopes": ["items:rw", "reports:rw"],
  "egress": ["api.github.com", "export.arxiv.org"] }
```
加载器启动时会校验：`egress` ⊆ 白名单、`dataScopes` 不越权、D 类包的输出必须带免责声明。
