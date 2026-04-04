#!/bin/sh

set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.real}"

if ! command -v codex >/dev/null 2>&1; then
  if [ -s "${HOME}/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "${HOME}/.nvm/nvm.sh"
    nvm use default >/dev/null 2>&1 || true
  fi
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "codex 不在 PATH 中，且未能从 ~/.nvm/nvm.sh 恢复运行环境" >&2
  exit 1
fi

if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
fi

LISTEN_URL="${CODEX_APP_SERVER_LISTEN_URL:-ws://127.0.0.1:4500}"

exec codex app-server --listen "${LISTEN_URL}"
