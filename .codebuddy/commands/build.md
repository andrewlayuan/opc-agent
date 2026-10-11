---
description: 按已批准的计划构建、自检并提交 PR
argument-hint: <Issue 号>
---
<!-- 由 npm run sync 从 .agents/ 生成，请勿直接修改 -->
确认 docs/plans/$ARGUMENTS-*.md 是 status: approved，否则停下。按 opc-flow 第 3、4 步：建分支 → 测试先行 → 实现 → `npm run verify` → verifier 子代理验收 → reviewer 子代理自审并修复 🔴 项 → `gh pr create`。然后停下，等我 G3。
