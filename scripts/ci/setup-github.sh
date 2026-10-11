#!/usr/bin/env bash
# 一次性初始化 GitHub 仓库：标签、分支保护、production 环境。需要你本人已执行 gh auth login。
# 用法：bash scripts/ci/setup-github.sh andrewlayuan/opc-agent
set -euo pipefail
R="${1:-andrewlayuan/opc-agent}"
lab() { gh label create "$1" --repo "$R" --color "$2" --description "$3" --force >/dev/null; echo "  label $1"; }
echo "1) 标签"
lab lane/A 2ea44f "快车道：小缺陷/文案/配置"
lab lane/B 1f6feb "标准道：已有能力包小功能"
lab lane/C d29922 "重点道：新能力包/新源类型/跨包"
lab lane/D cf222e "管控道：法务/财务/注册/安全，逐行人工审"
lab agent/build 8250df "你加上它 = 让云端 CodeBuddy 按已批准计划构建"
lab agent 8250df "由 Agent 开的 PR"
lab guardrail-ok b60205 "你本人确认：允许本 PR 修改护栏文件"
lab from-monitor fbca04 "控制带触发的问题"
lab priority/now b60205 "3σ：马上处理"
lab triage ededed "待分诊"
echo "2) 分支保护：main 只能经 PR 合并，必须通过 ci/verify 与 ci/guardrails"
gh api -X PUT "repos/$R/branches/main/protection" --input - >/dev/null <<'J'
{ "required_status_checks": { "strict": true, "contexts": ["verify", "guardrails"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false, "allow_deletions": false,
  "required_conversation_resolution": true }
J
echo "3) production 环境（发布需要你批准）"
uid=$(gh api user -q .id)
gh api -X PUT "repos/$R/environments/production" --input - >/dev/null <<J
{ "reviewers": [ { "type": "User", "id": $uid } ] }
J
echo "4) 提醒：在 Settings → Secrets and variables → Actions 配置："
echo "   Secrets   CODEBUDDY_API_KEY、OPC_BOT_TOKEN（细粒度 PAT：本仓库 contents/pull-requests/issues 读写）、GITEE_SSH_KEY（可选）"
echo "   Variables CODEBUDDY_INTERNET_ENVIRONMENT（中国版填 internal；海外版留空）、GITEE_REPO（可选，如 andrewlayuan/opc-agent）"
echo "完成 ✅"
