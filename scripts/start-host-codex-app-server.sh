#!/bin/sh

set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.real}"

if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
fi

LISTEN_URL="${CODEX_APP_SERVER_LISTEN_URL:-ws://127.0.0.1:4500}"

exec codex app-server --listen "${LISTEN_URL}"
