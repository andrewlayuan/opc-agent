#!/bin/sh
# 启动 DeepSeek Harness Web UI（默认 127.0.0.1:3080），并挂载 OPC Radar MCP 工具
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 注意：dsh 自身选项（--patch）必须写在 web 应用参数（--no-open 等）之前
exec "$ROOT/bin/dsh" web --patch "$ROOT/integrations/dsh/opc-radar.cordis.yml" --no-open "$@"
