#!/bin/bash
set -euo pipefail
if [ "${1:-}" != "cli" ]; then
  echo 'Expected the cli subcommand' >&2
  exit 2
fi
shift
PARTNER_FEISHU_SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "${PARTNER_AGENT_PYTHON:-python3}" -I -B "$PARTNER_FEISHU_SCRIPT_DIR/feishu-cli.py" "$@"
