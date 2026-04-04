#!/bin/sh

set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
CODEX_UNIT="${SYSTEMD_USER_DIR}/codex-feishu-bot-codex.service"
APP_UNIT="${SYSTEMD_USER_DIR}/codex-feishu-bot-app.service"

NODE_BIN_DIR=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN_DIR="$(dirname "$(command -v node)")"
fi
PATH_VALUE="${NODE_BIN_DIR}:${HOME}/.local/bin:${HOME}/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

mkdir -p "${SYSTEMD_USER_DIR}"

cat > "${CODEX_UNIT}" <<EOF
[Unit]
Description=Codex Feishu Bot external codex app-server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT_DIR}
ExecStart=${ROOT_DIR}/scripts/start-host-codex-app-server.sh
Restart=always
RestartSec=3
EnvironmentFile=-${ROOT_DIR}/.env.real
Environment=HOME=%h
Environment=PATH=${PATH_VALUE}

[Install]
WantedBy=default.target
EOF

cat > "${APP_UNIT}" <<EOF
[Unit]
Description=Codex Feishu Bot app
After=network-online.target codex-feishu-bot-codex.service
Wants=network-online.target
Requires=codex-feishu-bot-codex.service

[Service]
Type=simple
WorkingDirectory=${ROOT_DIR}
ExecStartPre=${ROOT_DIR}/scripts/build-host-app.sh
ExecStart=${ROOT_DIR}/scripts/start-host-app.sh
Restart=always
RestartSec=3
EnvironmentFile=-${ROOT_DIR}/.env.real
Environment=HOME=%h
Environment=PATH=${PATH_VALUE}

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload

echo "installed:"
echo "  ${CODEX_UNIT}"
echo "  ${APP_UNIT}"
echo
echo "next:"
echo "  systemctl --user enable --now codex-feishu-bot-codex.service"
echo "  systemctl --user enable --now codex-feishu-bot-app.service"
echo "  systemctl --user status codex-feishu-bot-app.service"
echo "  journalctl --user -u codex-feishu-bot-app.service -f"
echo
echo "optional:"
echo "  loginctl enable-linger ${USER}"
