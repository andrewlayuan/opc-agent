#!/bin/sh
# 获取 pm-skills（https://github.com/phuryn/pm-skills，MIT）并固定到已审阅的提交，
# 再把各技能目录链接到 DSH 项目技能目录 .dsh/skills/（前缀 pm-），供 dsh web/headless 使用。
# OPC Radar 的「产品顾问」直接读取 pm-skills/ 下的 SKILL.md 文本，无需此链接。
# 升级：确认新提交内容后修改 PM_SKILLS_REV 再运行本脚本。
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="https://github.com/phuryn/pm-skills"
PM_SKILLS_REV="9af7bfd0bc47fdad43c2eaa7a43cd13918e7aaef" # v2.3.0
DIR="$ROOT/pm-skills"
SKILLS="$ROOT/.dsh/skills"

if [ ! -d "$DIR/.git" ]; then
  git clone --quiet "$REPO" "$DIR"
fi
if ! git -C "$DIR" cat-file -e "$PM_SKILLS_REV^{commit}" 2>/dev/null; then
  git -C "$DIR" fetch --quiet origin
fi
git -C "$DIR" -c advice.detachedHead=false checkout --quiet "$PM_SKILLS_REV"

mkdir -p "$SKILLS"
# 只清理本脚本建立的 pm-* 链接
for l in "$SKILLS"/pm-*; do
  [ -L "$l" ] && rm -f "$l"
done

n=0
for f in "$DIR"/pm-*/skills/*/SKILL.md; do
  [ -f "$f" ] || continue
  sd="$(dirname "$f")"
  plugin="$(basename "$(dirname "$(dirname "$sd")")")"
  case "$plugin" in
    pm-toolkit|pm-ai-shipping) continue ;; # 法律文书/简历/代码评审，与产品评审无关
  esac
  ln -s "$sd" "$SKILLS/pm-$(basename "$sd")"
  n=$((n + 1))
done
ln -s "$ROOT/integrations/dsh/skills/pm-advisor" "$SKILLS/pm-advisor"

echo "pm-skills @ $(git -C "$DIR" rev-parse --short HEAD)：已链接 $n 个技能 + pm-advisor 到 $SKILLS"
