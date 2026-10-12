CI 失败了，请修复。规则：
- 只改实现代码；**不修改任何已有测试、不修改护栏文件（policy/ scripts/ .github/ evals/agent/）**。
- 先复现：运行 npm run verify，确认和日志一致。
- 修好后 npm run verify 必须全绿；不要 git push。
- 如果判断是测试本身错了或需要改护栏，什么都不要改，只输出原因。
