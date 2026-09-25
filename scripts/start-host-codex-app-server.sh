#!/bin/sh

set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.real}"

if ! command -v codex >/dev/null 2>&1; then
  if [ -s "${HOME}/.nvm/nvm.sh" ]; then
    set +u
    # shellcheck disable=SC1090
    . "${HOME}/.nvm/nvm.sh"
    set -u
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

# Only the Codex process receives the outbound proxy.
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY no_proxy NO_PROXY
if [ -n "${CODEX_PROXY_URL:-}" ]; then
  export http_proxy="${CODEX_PROXY_URL}" https_proxy="${CODEX_PROXY_URL}"
  export HTTP_PROXY="${CODEX_PROXY_URL}" HTTPS_PROXY="${CODEX_PROXY_URL}"
  export no_proxy="localhost,127.0.0.1,::1" NO_PROXY="localhost,127.0.0.1,::1"
fi

LISTEN_URL="${CODEX_APP_SERVER_LISTEN_URL:-ws://127.0.0.1:4500}"
WS_TOKEN_FILE="${CODEX_APP_SERVER_WS_TOKEN_FILE:-}"

if [ -n "${WS_TOKEN_FILE}" ]; then
  mkdir -p "$(dirname "${WS_TOKEN_FILE}")"
  if [ ! -s "${WS_TOKEN_FILE}" ]; then
    umask 077
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -base64 32 | tr -d '\n' >"${WS_TOKEN_FILE}"
    elif command -v python3 >/dev/null 2>&1; then
      python3 -c 'import secrets; print(secrets.token_urlsafe(32), end="")' >"${WS_TOKEN_FILE}"
    else
      node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' >"${WS_TOKEN_FILE}"
    fi
  fi
  chmod 600 "${WS_TOKEN_FILE}" 2>/dev/null || true
  exec codex app-server \
    --listen "${LISTEN_URL}" \
    --ws-auth capability-token \
    --ws-token-file "${WS_TOKEN_FILE}"
fi

exec codex app-server --listen "${LISTEN_URL}"
