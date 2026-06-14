#!/bin/sh
set -eu

CODEX_HOME_DIR="${CODEX_HOME_DIR:-/root/.codex}"
LISTEN_URL="${CODEX_APP_SERVER_LISTEN_URL:-ws://0.0.0.0:4500}"
WS_TOKEN_FILE="${CODEX_APP_SERVER_WS_TOKEN_FILE:-}"

mkdir -p "${CODEX_HOME_DIR}"

ensure_ws_token_file() {
  token_file="$1"
  mkdir -p "$(dirname "${token_file}")"
  if [ ! -s "${token_file}" ]; then
    umask 077
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -base64 32 | tr -d '\n' >"${token_file}"
    elif command -v python3 >/dev/null 2>&1; then
      python3 -c 'import secrets; print(secrets.token_urlsafe(32), end="")' >"${token_file}"
    else
      node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' >"${token_file}"
    fi
  fi
  chmod 600 "${token_file}" 2>/dev/null || true
}

if [ ! -f "${CODEX_HOME_DIR}/auth.json" ]; then
  if [ -n "${OPENAI_API_KEY:-}" ]; then
    printf '%s' "${OPENAI_API_KEY}" | codex login --with-api-key
  else
    echo "Missing Codex auth. Mount ${CODEX_HOME_DIR} with auth.json or set OPENAI_API_KEY." >&2
    exit 1
  fi
fi

if [ "$#" -gt 0 ]; then
  if [ "$1" = "app-server" ] && [ -n "${WS_TOKEN_FILE}" ]; then
    ensure_ws_token_file "${WS_TOKEN_FILE}"
    exec codex "$@" --ws-auth capability-token --ws-token-file "${WS_TOKEN_FILE}"
  fi
  exec codex "$@"
fi

if [ -n "${WS_TOKEN_FILE}" ]; then
  ensure_ws_token_file "${WS_TOKEN_FILE}"
  exec codex app-server \
    --listen "${LISTEN_URL}" \
    --ws-auth capability-token \
    --ws-token-file "${WS_TOKEN_FILE}"
fi

exec codex app-server --listen "${LISTEN_URL}"
