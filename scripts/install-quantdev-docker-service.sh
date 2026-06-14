#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
UNIT="${SYSTEMD_USER_DIR}/codex-feishu-bot-quantdev-docker.service"

mkdir -p "${SYSTEMD_USER_DIR}"

cat >"${UNIT}" <<EOF
[Unit]
Description=Codex Feishu Bot QuantDev protected docker session pool
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT_DIR}
ExecStartPre=${ROOT_DIR}/scripts/build-quantdev-image.sh --if-missing
ExecStart=${ROOT_DIR}/scripts/start-quantdev-docker.sh
Restart=always
RestartSec=3
EnvironmentFile=-${ROOT_DIR}/.env.real
Environment=HOME=%h

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload

echo "installed:"
echo "  ${UNIT}"
echo
echo "next:"
echo "  systemctl --user enable --now codex-feishu-bot-quantdev-docker.service"
echo "  systemctl --user status codex-feishu-bot-quantdev-docker.service"
echo "  journalctl --user -u codex-feishu-bot-quantdev-docker.service -f"
