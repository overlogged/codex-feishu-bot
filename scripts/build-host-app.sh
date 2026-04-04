#!/bin/sh

set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"

if ! command -v pnpm >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
  if [ -s "${HOME}/.nvm/nvm.sh" ]; then
    set +u
    # shellcheck disable=SC1090
    . "${HOME}/.nvm/nvm.sh"
    set -u
    nvm use default >/dev/null 2>&1 || true
  fi
fi

if ! command -v pnpm >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
  echo "pnpm / node 不在 PATH 中，且未能从 ~/.nvm/nvm.sh 恢复运行环境" >&2
  exit 1
fi

cd "${ROOT_DIR}"
exec pnpm build
