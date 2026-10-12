@AGENTS.md

# CodeBuddy 补充说明（Cursor 不读这个文件）
- 子代理放在 `.codebuddy/agents/`，技能放在 `.codebuddy/skills/`，命令放在 `.codebuddy/commands/`。这三处都是 `npm run sync` 生成的副本，**不要直接改**，要改就去 `.agents/` 改源文件
- 钩子已经配置在 `.codebuddy/settings.json`。被钩子拦下时，要把原因原样告诉用户，不要换一种方式绕过去
- 个人偏好写在 `CODEBUDDY.local.md`（不提交到仓库）
