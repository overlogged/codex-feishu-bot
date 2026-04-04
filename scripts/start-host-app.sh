#!/bin/sh

set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.real}"

if ! command -v node >/dev/null 2>&1; then
  if [ -s "${HOME}/.nvm/nvm.sh" ]; then
    set +u
    # shellcheck disable=SC1090
    . "${HOME}/.nvm/nvm.sh"
    set -u
    nvm use default >/dev/null 2>&1 || true
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node 不在 PATH 中，且未能从 ~/.nvm/nvm.sh 恢复运行环境" >&2
  exit 1
fi

if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
fi

cd "${ROOT_DIR}"
exec node dist/index.js
