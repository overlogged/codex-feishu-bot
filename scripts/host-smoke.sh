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

PORT_VALUE="${PORT:-${APP_PORT:-3000}}"
APP_BASE_URL="http://127.0.0.1:${PORT_VALUE}"

echo "app: ${APP_BASE_URL}"
curl -fsS "${APP_BASE_URL}/health"
echo
curl -fsS "${APP_BASE_URL}/debug/state"
echo

if command -v python3 >/dev/null 2>&1; then
  HEALTH_URL="$(python3 - <<'PY'
import os
from urllib.parse import urlparse

listen_url = os.environ.get("CODEX_APP_SERVER_LISTEN_URL", "ws://127.0.0.1:4500")
parsed = urlparse(listen_url)
scheme = "https" if parsed.scheme == "wss" else "http"
host = parsed.hostname or "127.0.0.1"
port = parsed.port or (443 if parsed.scheme == "wss" else 80)
print(f"{scheme}://{host}:{port}/healthz")
PY
)"
  echo "codex: ${HEALTH_URL}"
  curl -fsS "${HEALTH_URL}"
  echo
fi
