ARG HOST_RUNTIME_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/ubuntu:24.04
ARG BUILD_NODE_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:22-bookworm-slim
ARG PNPM_VERSION=10.33.0

FROM ${BUILD_NODE_IMAGE} AS build
ARG PNPM_VERSION=10.33.0

WORKDIR /app

RUN corepack enable \
  && corepack prepare "pnpm@${PNPM_VERSION}" --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm config set fetch-retries 5 \
  && pnpm config set fetch-retry-factor 2 \
  && pnpm config set fetch-retry-maxtimeout 60000 \
  && pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

RUN pnpm build
RUN pnpm prune --prod

FROM ${HOST_RUNTIME_IMAGE} AS runtime

ARG NODE_VERSION=24.14.0

WORKDIR /app

ENV NODE_ENV=production
ENV HOME=/root
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    openssh-client \
    procps \
    python3 \
    make \
    g++ \
    ripgrep \
    wget \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
  && mkdir -p /usr/local/lib/nodejs \
  && tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs \
  && ln -sf "/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-x64/bin/node" /usr/local/bin/node \
  && ln -sf "/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-x64/bin/npm" /usr/local/bin/npm \
  && ln -sf "/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-x64/bin/npx" /usr/local/bin/npx \
  && ln -sf "/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-x64/bin/corepack" /usr/local/bin/corepack \
  && rm -f /tmp/node.tar.xz

ARG CODEX_CLI_VERSION=0.133.0
ARG PI_CLI_VERSION=0.73.1

RUN npm install -g "@openai/codex@${CODEX_CLI_VERSION}" \
  && ln -sf "/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-x64/bin/codex" /usr/local/bin/codex

RUN npm install -g "@mariozechner/pi-coding-agent@${PI_CLI_VERSION}" \
  && ln -sf "/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-x64/bin/pi" /usr/local/bin/pi

COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY scripts/feishu-bridge.mjs ./scripts/feishu-bridge.mjs
COPY scripts/start-codex-app-server.sh /usr/local/bin/start-codex-app-server
COPY scripts/feishu-bridge.mjs /opt/codex-tools/feishu-bridge.mjs

RUN chmod +x /usr/local/bin/start-codex-app-server

CMD ["node", "dist/index.js"]

FROM runtime AS quantdev-runtime

ENV SLOCK_SERVER_URL=https://api.slock.ai

COPY scripts/quantdev-session-entrypoint.sh /usr/local/bin/quantdev-session-entrypoint
RUN chmod +x /usr/local/bin/quantdev-session-entrypoint

ENTRYPOINT ["quantdev-session-entrypoint"]
CMD ["sleep", "infinity"]
