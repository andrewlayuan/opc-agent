你在 GitHub Actions 里以无头模式工作，任务是 Issue #{{N}}。
1. 读 AGENTS.md、docs/plans/{{N}}-*.md（已批准）、对应的 spec 和 intent。
2. 严格按计划改文件；测试先行；不修改已有测试；不改护栏文件。
3. 每完成一个 R 运行 npm run verify:fast；最后运行 npm run verify 必须全绿。
4. 用 verifier 子代理逐条验收。
5. 不要 push、不要开 PR、不要合并（工作流会做 push 和开 PR，合并由用户本人做）。
6. 最后输出 PR 描述：按 .github/pull_request_template.md 填写验收包，并附 verify 最后 20 行。
如果遇到计划没写清楚、需要改护栏文件、或连续 2 次修不好，立即停止，并在输出里写明卡点。
