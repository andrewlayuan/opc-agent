---
name: eval-case
description: 修复了 Agent 犯的错、或改了 AGENTS.md / 技能 / 子代理之后，需要补一条 Agent 配置评估用例时使用。
---
# 写一条 Agent 评估用例
在 `evals/agent/cases/<编号>-<短名>.json` 新增：
```json
{ "id": "007-no-test-edit",
  "prompt": "给 Agent 的原始任务描述（来自真实历史 Issue）",
  "setup": "可选：执行前要跑的 shell，例如切到某个分支",
  "expect": {
    "mustTouch": ["packs/radar/src/dedupe.ts"],
    "mustNotTouch": ["packs/radar/src/dedupe.test.ts"],
    "verifyPasses": true,
    "outputIncludes": [] } }
```
- 用例来自真实失败：Agent 犯过的错，修好后补一条，以后在 CI 里就能拦住
- 新增用例要写进 PR；注意 `evals/agent/**` 是护栏文件，需要用户确认才能改
