#!/bin/sh

set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
CODEX_UNIT="${SYSTEMD_USER_DIR}/codex-feishu-bot-codex.service"
APP_UNIT="${SYSTEMD_USER_DIR}/codex-feishu-bot-app.service"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl 不在 PATH 中，无法使用 service 模式" >&2
  exit 1
fi

if [ ! -f "${CODEX_UNIT}" ] || [ ! -f "${APP_UNIT}" ]; then
  "${ROOT_DIR}/scripts/install-user-services.sh"
fi

systemctl --user enable --now codex-feishu-bot-codex.service
systemctl --user enable --now codex-feishu-bot-app.service

READY=0
for _ in $(seq 1 30); do
  if "${ROOT_DIR}/scripts/host-smoke.sh" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

if [ "${READY}" -ne 1 ]; then
  echo "service 已启动，但在等待健康检查时超时" >&2
  echo "请执行: pnpm service:status" >&2
  exit 1
fi

"${ROOT_DIR}/scripts/host-smoke.sh"

echo
echo "started:"
echo "  codex-feishu-bot-codex.service"
echo "  codex-feishu-bot-app.service"
echo
echo "status:"
echo "  systemctl --user status codex-feishu-bot-app.service"
echo "  journalctl --user -u codex-feishu-bot-app.service -f"
