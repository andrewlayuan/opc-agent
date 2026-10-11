---
name: pack-scaffold
description: 新建一个能力包（strategy、market、product、registration、marketing、legal、finance 等）时使用。
---
<!-- 由 npm run sync 从 .agents/ 生成，请勿直接修改 -->
# 能力包骨架
```
packs/<域>/
├── pack.json        # {id, version, lane:"B|C|D", skills:[], tools:[], mcp:[], dataScopes:[]}
├── README.md        # 这个包能为一人公司做什么，不能做什么
├── skills/<名>/SKILL.md   # 给运行时 Agent 用的工作说明
├── src/             # 工具函数（纯函数优先，可测试）
├── evals/           # 至少 5 个用例 + 评分规则
└── *.test.ts
```
- `lane` 为 D 的包（法务、财务、注册）：所有输出都要加免责声明；涉及官方网站的信息要附官方链接和查询日期
- 包与包之间只通过 `packages/core` 的事件和数据表交互，不直接 import 其他包
