#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.real}"

if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
fi

HOST_HOME="${QUANTDEV_HOST_HOME:-${HOME}}"
MOUNT_ROOT="${QUANTDEV_DOCKER_MOUNT_ROOT:-${DOCKER_EXECUTION_MOUNT_ROOT:-/home}}"
IMAGE="${QUANTDEV_DOCKER_IMAGE:-${DOCKER_EXECUTION_IMAGE:-codex-feishu-bot-quantdev-session:local}}"
CONTAINER_NAME="${QUANTDEV_DOCKER_CONTAINER_NAME:-${DOCKER_EXECUTION_CONTAINER_NAME:-codex-feishu-bot-quantdev-session-pool}}"
LISTEN_URL="${DOCKER_EXECUTION_LISTEN_URL:-ws://127.0.0.1:4510}"
MEMORY="${DOCKER_EXECUTION_MEMORY:-half}"
GPU_MODE="${QUANTDEV_DOCKER_GPU:-${DOCKER_EXECUTION_GPU:-auto}}"
SLOCK_SERVER_URL="${SLOCK_SERVER_URL:-https://api.slock.ai}"
WS_TOKEN_FILE="${DOCKER_EXECUTION_WS_TOKEN_FILE:-${HOST_HOME}/.codex-feishu-bot/docker-codex-app-server.ws-token}"

HOST_PORT="$(printf '%s\n' "${LISTEN_URL}" | sed -n 's#.*:\([0-9][0-9]*\)\(/.*\)\{0,1\}$#\1#p')"
if [ -z "${HOST_PORT}" ]; then
  echo "无法从 DOCKER_EXECUTION_LISTEN_URL 解析端口：${LISTEN_URL}" >&2
  exit 1
fi

cpu_limit() {
  local cpus
  cpus="$(nproc 2>/dev/null || printf '2')"
  awk -v cpus="${cpus}" 'BEGIN { half=cpus/2; if (half < 1) half=1; printf "%.2f", half }' \
    | sed 's/\.00$//;s/0$//'
}

memory_limit() {
  case "$(printf '%s' "${MEMORY}" | tr '[:upper:]' '[:lower:]')" in
    auto|half|50%)
      awk '/MemTotal:/ { limit=int($2 / 2048); if (limit < 512) limit=512; printf "%dm", limit }' /proc/meminfo
      ;;
    *)
      printf '%s' "${MEMORY}"
      ;;
  esac
}

normalize_gpu_mode() {
  printf '%s' "${GPU_MODE}" | tr '[:upper:]' '[:lower:]'
}

gpu_mode_disabled() {
  case "$(normalize_gpu_mode)" in
    ""|0|false|no|off|none|disabled)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

docker_has_nvidia_runtime() {
  docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"nvidia"'
}

GPU_ENABLED=false
GPU_LD_LIBRARY_PATH=""
GPU_PATH_PREFIX=""

configure_gpu_args() {
  local mode
  mode="$(normalize_gpu_mode)"

  if gpu_mode_disabled; then
    return
  fi

  if [ "${mode}" = "wsl" ] || {
    [ "${mode}" = "auto" ] &&
      [ -e /dev/dxg ] &&
      [ -d /usr/lib/wsl ] &&
      [ -x /usr/lib/wsl/lib/nvidia-smi ]
  }; then
    if [ ! -e /dev/dxg ] || [ ! -d /usr/lib/wsl ] || [ ! -x /usr/lib/wsl/lib/nvidia-smi ]; then
      echo "请求启用 WSL GPU，但缺少 /dev/dxg 或 /usr/lib/wsl/lib/nvidia-smi。" >&2
      exit 1
    fi

    args+=(--device /dev/dxg -v /usr/lib/wsl:/usr/lib/wsl:ro)
    GPU_ENABLED=true
    GPU_LD_LIBRARY_PATH="/usr/lib/wsl/lib"
    GPU_PATH_PREFIX="/usr/lib/wsl/lib:"
    return
  fi

  if [ "${mode}" = "nvidia" ] || [ "${mode}" = "all" ] || [ "${mode}" = "cuda" ] || {
    [ "${mode}" = "auto" ] && docker_has_nvidia_runtime
  }; then
    args+=(--gpus all)
    GPU_ENABLED=true
    return
  fi

  if [ "${mode}" != "auto" ]; then
    echo "请求启用 GPU，但当前 Docker 未检测到可用的 WSL GPU 或 nvidia runtime。" >&2
    exit 1
  fi
}

ensure_ws_token_file() {
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
}

ensure_ws_token_file

args=(
  run
  --rm
  --init
  --name "${CONTAINER_NAME}"
  --cpus "$(cpu_limit)"
  --memory "$(memory_limit)"
  -p "127.0.0.1:${HOST_PORT}:4500"
  -v /etc/passwd:/etc/passwd:ro
  -v /etc/group:/etc/group:ro
)

configure_gpu_args

RUNTIME_ENV_FILE="${QUANTDEV_DOCKER_ENV_FILE:-${XDG_RUNTIME_DIR:-/tmp}/codex-feishu-bot-quantdev-docker.env}"
mkdir -p "$(dirname "${RUNTIME_ENV_FILE}")"
umask 077
{
  printf 'HOME=%s\n' "${HOST_HOME}"
  printf 'CODEX_HOME_DIR=%s\n' "${HOST_HOME}/.codex"
  printf 'PATH=%s\n' "${GPU_PATH_PREFIX}/tmp/quantdev-bin:${HOST_HOME}/.local/bin:${PATH}"
  if [ -n "${GPU_LD_LIBRARY_PATH}" ]; then
    printf 'LD_LIBRARY_PATH=%s\n' "${GPU_LD_LIBRARY_PATH}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
  fi
  if [ "${GPU_ENABLED}" = "true" ]; then
    printf 'NVIDIA_VISIBLE_DEVICES=all\n'
    printf 'NVIDIA_DRIVER_CAPABILITIES=compute,utility\n'
  fi
  printf 'CODEX_APP_SERVER_LISTEN_URL=ws://0.0.0.0:4500\n'
  printf 'CODEX_APP_SERVER_WS_TOKEN_FILE=%s\n' "${WS_TOKEN_FILE}"
  printf 'SLOCK_SERVER_URL=%s\n' "${SLOCK_SERVER_URL}"
  printf 'SLOCK_HOST_HOSTNAME=%s\n' "$(hostname)"
  printf 'KIMI_CLI_COMMAND=%s\n' "${KIMI_CLI_COMMAND:-kimi}"
  printf 'PI_CLI_COMMAND=%s\n' "${PI_CLI_COMMAND:-pi}"
  printf 'PI_CLI_PROVIDER=%s\n' "${PI_CLI_PROVIDER:-openrouter}"
  printf 'PI_CLI_MODEL=%s\n' "${PI_CLI_MODEL:-deepseek-v4-pro}"
  printf 'PI_CLI_THINKING=%s\n' "${PI_CLI_THINKING:-xhigh}"
} >"${RUNTIME_ENV_FILE}"

for key in HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY OPENAI_API_KEY FEISHU_APP_ID FEISHU_APP_SECRET FEISHU_DOMAIN SLOCK_API_KEY SLOCK_DAEMON_ENABLED MOONSHOT_API_KEY KIMI_API_KEY ANTHROPIC_API_KEY GOOGLE_API_KEY GEMINI_API_KEY XAI_API_KEY ZAI_API_KEY MISTRAL_API_KEY GROQ_API_KEY CEREBRAS_API_KEY CLOUDFLARE_API_KEY FIREWORKS_API_KEY MINIMAX_API_KEY; do
  value="${!key:-}"
  if [ -n "${value}" ]; then
    printf '%s=%s\n' "${key}" "${value}" >>"${RUNTIME_ENV_FILE}"
  fi
done

args+=(--env-file "${RUNTIME_ENV_FILE}")

if [ -n "${SSH_AUTH_SOCK:-}" ] && [ -S "${SSH_AUTH_SOCK}" ]; then
  args+=(-v "${SSH_AUTH_SOCK}:${SSH_AUTH_SOCK}")
  printf 'SSH_AUTH_SOCK=%s\n' "${SSH_AUTH_SOCK}" >>"${RUNTIME_ENV_FILE}"
fi

if [ -n "${XDG_RUNTIME_DIR:-}" ]; then
  printf 'XDG_RUNTIME_DIR=%s\n' "${XDG_RUNTIME_DIR}" >>"${RUNTIME_ENV_FILE}"
fi

if command -v id >/dev/null 2>&1; then
  args+=(--user "$(id -u):$(id -g)")
fi

add_mount() {
  local source="$1"
  local target="$2"
  local mode="$3"
  local required="${4:-optional}"

  if [ -e "${source}" ]; then
    args+=(-v "${source}:${target}:${mode}")
    return
  fi

  if [ "${required}" = "required" ]; then
    echo "缺少必需挂载源：${source}" >&2
    exit 1
  fi
}

add_mount_spec() {
  local spec="$1"
  local source target mode extra

  IFS=: read -r source target mode extra <<<"${spec}"
  if [ -z "${source:-}" ] || [ -z "${target:-}" ] || [ -n "${extra:-}" ]; then
    echo "挂载配置格式错误：${spec}，应为 host_path:container_path[:ro|rw]" >&2
    exit 1
  fi
  mode="${mode:-rw}"
  if [ "${mode}" != "ro" ] && [ "${mode}" != "rw" ]; then
    echo "挂载配置 mode 只支持 ro/rw：${spec}" >&2
    exit 1
  fi
  if [ ! -e "${source}" ]; then
    echo "缺少挂载源：${source}" >&2
    exit 1
  fi
  args+=(-v "${source}:${target}:${mode}")
}

mounts="${QUANTDEV_DOCKER_MOUNTS:-${DOCKER_EXECUTION_MOUNTS:-}}"
if [ -n "${mounts}" ]; then
  IFS=,
  for spec in ${mounts}; do
    if [ -n "${spec}" ]; then
      add_mount_spec "${spec}"
    fi
  done
  unset IFS
else
  mkdir -p "${HOST_HOME}/.slock"

  add_mount "${MOUNT_ROOT}" "${MOUNT_ROOT}" rw required
  add_mount "${HOST_HOME}/QuantFS/common_data" "${HOST_HOME}/QuantFS/common_data" ro required
  add_mount "${HOST_HOME}/QuantFS/prod" "${HOST_HOME}/QuantFS/prod" ro required
fi

docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
exec docker "${args[@]}" "${IMAGE}" start-codex-app-server
