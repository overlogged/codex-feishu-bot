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

IMAGE="${QUANTDEV_DOCKER_IMAGE:-${DOCKER_EXECUTION_IMAGE:-codex-feishu-bot-quantdev-session:local}}"
TARGET="${QUANTDEV_DOCKER_BUILD_TARGET:-${DOCKER_EXECUTION_BUILD_TARGET:-quantdev-runtime}}"
HOST_RUNTIME_IMAGE="${HOST_RUNTIME_IMAGE:-swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/ubuntu:24.04}"
BUILD_NODE_IMAGE="${BUILD_NODE_IMAGE:-swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:22-bookworm-slim}"
PNPM_VERSION="${PNPM_VERSION:-10.33.0}"
NODE_VERSION="${NODE_VERSION:-24.14.0}"
CODEX_CLI_VERSION="${CODEX_CLI_VERSION:-0.133.0}"
PI_CLI_VERSION="${PI_CLI_VERSION:-0.73.1}"

if [ "${1:-}" = "--if-missing" ] && docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  exit 0
fi

docker build \
  --build-arg "HOST_RUNTIME_IMAGE=${HOST_RUNTIME_IMAGE}" \
  --build-arg "BUILD_NODE_IMAGE=${BUILD_NODE_IMAGE}" \
  --build-arg "PNPM_VERSION=${PNPM_VERSION}" \
  --build-arg "NODE_VERSION=${NODE_VERSION}" \
  --build-arg "CODEX_CLI_VERSION=${CODEX_CLI_VERSION}" \
  --build-arg "PI_CLI_VERSION=${PI_CLI_VERSION}" \
  --target "${TARGET}" \
  -t "${IMAGE}" \
  "${ROOT_DIR}"
