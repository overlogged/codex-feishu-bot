#!/bin/sh

# 监听 codex-auth 的 active account 变化；一旦切号，重启持有旧账号认证的
# codex app-server，让已有会话在新账号上继续。

set -u

REGISTRY_FILE="${CODEX_ACCOUNTS_REGISTRY:-${HOME}/.codex/accounts/registry.json}"
AUTH_FILE="${CODEX_AUTH_FILE:-${HOME}/.codex/auth.json}"
STATE_FILE="${CODEX_ACCOUNT_STATE_FILE:-${HOME}/.codex-feishu-bot/active-codex-account}"
INTERVAL="${CODEX_ACCOUNT_WATCH_INTERVAL:-10}"
SERVICES="codex-feishu-bot-codex.service"

read_active_key() {
  python3 - "${AUTH_FILE}" "${REGISTRY_FILE}" <<'PY' 2>/dev/null || true
import json
import sys

def read_json(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return None

auth = read_json(sys.argv[1])
account_id = ((auth or {}).get("tokens") or {}).get("account_id")
if account_id:
    print(account_id)
else:
    print((read_json(sys.argv[2]) or {}).get("active_account_key") or "")
PY
}

mkdir -p "$(dirname "${STATE_FILE}")"

echo "开始监听 Codex 账号切换：${AUTH_FILE}（每 ${INTERVAL}s）"

while true; do
  current="$(read_active_key)"
  previous=""
  if [ -f "${STATE_FILE}" ]; then
    previous="$(cat "${STATE_FILE}" 2>/dev/null || true)"
  fi

  if [ -n "${current}" ] && [ "${current}" != "${previous}" ]; then
    if [ -n "${previous}" ]; then
      sleep 5
      confirmed="$(read_active_key)"
      if [ -z "${confirmed}" ] || [ "${confirmed}" = "${previous}" ]; then
        sleep "${INTERVAL}"
        continue
      fi
      current="${confirmed}"
      echo "检测到 Codex 账号已切换，重启 app-server 让会话跟随新账号"
      for service in ${SERVICES}; do
        if systemctl --user cat "${service}" >/dev/null 2>&1; then
          if systemctl --user restart "${service}"; then
            echo "已重启 ${service}"
          else
            echo "重启 ${service} 失败" >&2
          fi
        fi
      done
    fi
    printf '%s' "${current}" >"${STATE_FILE}"
  fi

  sleep "${INTERVAL}"
done
