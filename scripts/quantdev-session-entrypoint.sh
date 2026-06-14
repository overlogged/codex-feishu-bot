#!/bin/sh
set -eu

SLOCK_PID=""
MAIN_PID=""

stop_children() {
  if [ -n "${MAIN_PID}" ] && kill -0 "${MAIN_PID}" 2>/dev/null; then
    kill "${MAIN_PID}" 2>/dev/null || true
  fi
  if [ -n "${SLOCK_PID}" ] && kill -0 "${SLOCK_PID}" 2>/dev/null; then
    kill "${SLOCK_PID}" 2>/dev/null || true
  fi
}

start_slock_daemon() {
  if [ "${SLOCK_DAEMON_ENABLED:-true}" = "false" ]; then
    return
  fi

  if [ -z "${SLOCK_API_KEY:-}" ]; then
    echo "SLOCK_API_KEY is not set; slock daemon was not started." >&2
    return
  fi

  SLOCK_SERVER_URL="${SLOCK_SERVER_URL:-https://api.slock.ai}"
  SLOCK_DAEMON_LOG="${SLOCK_DAEMON_LOG:-${HOME}/.slock/daemon.log}"
  NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-/tmp/slock-npm-cache}"
  export NPM_CONFIG_CACHE

  mkdir -p "$(dirname "${SLOCK_DAEMON_LOG}")" "${NPM_CONFIG_CACHE}"
  prune_container_slock_locks

  npx -y @slock-ai/daemon@latest \
    --server-url "${SLOCK_SERVER_URL}" \
    --api-key "${SLOCK_API_KEY}" \
    >>"${SLOCK_DAEMON_LOG}" 2>&1 &
  SLOCK_PID="$!"
}

prepare_host_kimi_cli() {
  KIMI_HOST_COMMAND="${KIMI_HOST_COMMAND:-${HOME}/.local/share/uv/tools/kimi-cli/bin/kimi}"
  KIMI_HOST_CLI_COMMAND="${KIMI_HOST_CLI_COMMAND:-${HOME}/.local/share/uv/tools/kimi-cli/bin/kimi-cli}"
  KIMI_BIN_DIR="${KIMI_BIN_DIR:-/tmp/quantdev-bin}"

  if [ ! -x "${KIMI_HOST_COMMAND}" ]; then
    return
  fi

  mkdir -p "${KIMI_BIN_DIR}"
  ln -sf "${KIMI_HOST_COMMAND}" "${KIMI_BIN_DIR}/kimi"
  if [ -x "${KIMI_HOST_CLI_COMMAND}" ]; then
    ln -sf "${KIMI_HOST_CLI_COMMAND}" "${KIMI_BIN_DIR}/kimi-cli"
  fi

  PATH="${KIMI_BIN_DIR}:${PATH}"
  export PATH
}

prune_container_slock_locks() {
  if [ -z "${SLOCK_HOST_HOSTNAME:-}" ] || ! command -v node >/dev/null 2>&1; then
    return
  fi

  node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const hostHostname = process.env.SLOCK_HOST_HOSTNAME;
const machinesDir = path.join(process.env.HOME || "/home/overlogged", ".slock", "machines");

if (!hostHostname || !fs.existsSync(machinesDir)) {
  process.exit(0);
}

for (const machine of fs.readdirSync(machinesDir)) {
  const lockDir = path.join(machinesDir, machine, "daemon.lock");
  const ownerFile = path.join(lockDir, "owner.json");
  if (!fs.existsSync(ownerFile)) {
    continue;
  }

  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  } catch {
    continue;
  }

  if (owner.hostname && owner.hostname !== hostHostname) {
    fs.rmSync(lockDir, {
      recursive: true,
      force: true
    });
  }
}
NODE
}

trap stop_children INT TERM

prepare_host_kimi_cli
start_slock_daemon

"$@" &
MAIN_PID="$!"
set +e
wait "${MAIN_PID}"
STATUS="$?"
set -e

stop_children
exit "${STATUS}"
