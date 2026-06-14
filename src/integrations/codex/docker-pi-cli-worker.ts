import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import type { Env } from "../../config/env.js";
import type { CodexTurnContext } from "./codex-worker.js";
import {
  buildDockerExecutionRunArgs,
  buildShellCommand,
  DockerCommandRunner,
  resolveDockerCommandInvocation,
  type LoggerLike
} from "./docker-runtime.js";
import {
  PiCliWorker,
  type PiCliProcessHandle,
  type PiCliRuntime
} from "./pi-cli-worker.js";

const PI_DOCKER_ENV_PREFIXES = ["PI_"] as const;

function sanitizeContainerName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
}

function parseDockerHostPort(listenUrl: string): string {
  const url = new URL(listenUrl);
  if (!url.port) {
    throw new Error(`DOCKER_EXECUTION_LISTEN_URL 缺少端口：${listenUrl}`);
  }
  return url.port;
}

function appendExecEnvPrefixes(args: string[], prefixes: readonly string[]): void {
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || seen.has(key) || !prefixes.some((prefix) => key.startsWith(prefix))) {
      continue;
    }

    seen.add(key);
    args.push("-e", `${key}=${value}`);
  }
}

function turnPidFile(turnId: string): string {
  return `/tmp/codex-feishu-bot-pi-${sanitizeContainerName(turnId)}.pid`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildDockerPiExecArgs(
  env: Env,
  options: {
    turnId: string;
    context: Pick<CodexTurnContext, "workspaceId">;
    args: string[];
  }
): {
  dockerArgs: string[];
  pidFile: string;
} {
  const pidFile = turnPidFile(options.turnId);
  const execScript = [
    `pidfile=${shellSingleQuote(pidFile)}`,
    'rm -f "$pidfile"',
    'echo "$$" > "$pidfile"',
    'exec "$@"'
  ].join("\n");
  const dockerArgs = ["exec", "-i", "-w", options.context.workspaceId];
  appendExecEnvPrefixes(dockerArgs, PI_DOCKER_ENV_PREFIXES);
  dockerArgs.push(
    env.DOCKER_EXECUTION_CONTAINER_NAME,
    "sh",
    "-lc",
    execScript,
    "sh",
    env.PI_CLI_COMMAND,
    ...options.args
  );

  return {
    dockerArgs,
    pidFile
  };
}

async function terminateDockerRunProcess(
  child: ChildProcessByStdio<null, Readable, Readable>
): Promise<void> {
  if (child.killed) {
    return;
  }

  const closed = new Promise<void>((resolve) => {
    child.once("close", () => {
      resolve();
    });
  });

  child.kill("SIGTERM");
  const forceKillTimer = setTimeout(() => {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  }, 2_000);
  forceKillTimer.unref();

  await Promise.race([
    closed,
    new Promise<void>((resolve) => {
      setTimeout(resolve, 2_500).unref();
    })
  ]).finally(() => {
    clearTimeout(forceKillTimer);
  });
}

class DockerPiCliRuntime implements PiCliRuntime {
  private readonly docker: DockerCommandRunner;
  private preparePromise: Promise<void> | undefined;

  constructor(
    private readonly env: Env,
    private readonly logger?: LoggerLike
  ) {
    this.docker = new DockerCommandRunner(env, logger);
  }

  async prepare(): Promise<void> {
    if (!this.preparePromise) {
      this.preparePromise = (async () => {
        await this.docker.ensureImage();
        await this.ensureContainerRunning();
      })();
    }

    await this.preparePromise;
  }

  spawnProcess(options: {
    turnId: string;
    context: CodexTurnContext;
    args: string[];
  }): PiCliProcessHandle {
    const { dockerArgs, pidFile } = buildDockerPiExecArgs(this.env, options);
    const invocation = resolveDockerCommandInvocation(dockerArgs);
    this.logger?.info(
      {
        containerName: this.env.DOCKER_EXECUTION_CONTAINER_NAME,
        command: buildShellCommand([
          invocation.command,
          "exec",
          "-i",
          "-w",
          options.context.workspaceId,
          this.env.DOCKER_EXECUTION_CONTAINER_NAME,
          "..."
        ]),
        workspaceId: options.context.workspaceId
      },
      "在常驻 docker 执行池中开始 Pi CLI turn"
    );

    const child = spawn(invocation.command, invocation.args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stopPromise: Promise<void> | undefined;
    return {
      child,
      stop: async () => {
        if (!stopPromise) {
          stopPromise = (async () => {
            await this.docker.run(
              [
                "exec",
                this.env.DOCKER_EXECUTION_CONTAINER_NAME,
                "sh",
                "-lc",
                `if [ -f ${pidFile} ]; then kill -TERM "$(cat ${pidFile})" 2>/dev/null || true; fi`
              ],
              {
                allowFailure: true,
                timeoutMs: 2_000
              }
            );
            await terminateDockerRunProcess(child);
          })();
        }

        await stopPromise;
      }
    };
  }

  private async ensureContainerRunning(): Promise<void> {
    const inspectResult = await this.docker.run(
      ["inspect", "-f", "{{.State.Running}}", this.env.DOCKER_EXECUTION_CONTAINER_NAME],
      {
        allowFailure: true
      }
    );

    if (inspectResult.exitCode === 0) {
      if (inspectResult.stdout.trim() === "true") {
        return;
      }

      if (this.env.DOCKER_EXECUTION_EXTERNAL) {
        throw new Error(
          `docker 执行池容器 ${this.env.DOCKER_EXECUTION_CONTAINER_NAME} 已存在但没有运行，请启动 codex-feishu-bot-quantdev-docker.service。`
        );
      }

      await this.docker.run(["start", this.env.DOCKER_EXECUTION_CONTAINER_NAME]);
      return;
    }

    if (this.env.DOCKER_EXECUTION_EXTERNAL) {
      throw new Error(
        `docker 执行池容器 ${this.env.DOCKER_EXECUTION_CONTAINER_NAME} 不存在，请启动 codex-feishu-bot-quantdev-docker.service。`
      );
    }

    const hostPort = parseDockerHostPort(this.env.DOCKER_EXECUTION_LISTEN_URL);
    const dockerArgs = buildDockerExecutionRunArgs(this.env, {
      containerName: this.env.DOCKER_EXECUTION_CONTAINER_NAME,
      detach: true,
      publishPorts: [`127.0.0.1:${hostPort}:4500`],
      extraEnv: {
        CODEX_APP_SERVER_LISTEN_URL: "ws://0.0.0.0:4500",
        CODEX_APP_SERVER_WS_TOKEN_FILE: this.env.DOCKER_EXECUTION_WS_TOKEN_FILE,
        FEISHU_APP_ID: process.env.FEISHU_APP_ID ?? "",
        FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET ?? "",
        FEISHU_DOMAIN: process.env.FEISHU_DOMAIN ?? this.env.FEISHU_DOMAIN,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? ""
      },
      passthroughEnvPrefixes: PI_DOCKER_ENV_PREFIXES,
      command: ["start-codex-app-server"]
    });
    await this.docker.run(dockerArgs);
  }
}

export class DockerPiCliWorker extends PiCliWorker {
  constructor(env: Env, logger?: LoggerLike) {
    super(env, logger, new DockerPiCliRuntime(env, logger));
  }
}
