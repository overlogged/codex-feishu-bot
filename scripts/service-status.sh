#!/bin/sh

set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl 不在 PATH 中，无法使用 service 模式" >&2
  exit 1
fi

systemctl --user --no-pager --full status \
  codex-feishu-bot-codex.service \
  codex-feishu-bot-app.service || true

echo
"${ROOT_DIR}/scripts/host-smoke.sh" || true
