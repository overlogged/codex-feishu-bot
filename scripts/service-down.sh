#!/bin/sh

set -eu

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl 不在 PATH 中，无法使用 service 模式" >&2
  exit 1
fi

systemctl --user stop codex-feishu-bot-app.service || true
systemctl --user stop codex-feishu-bot-codex.service || true

echo "stopped:"
echo "  codex-feishu-bot-app.service"
echo "  codex-feishu-bot-codex.service"

