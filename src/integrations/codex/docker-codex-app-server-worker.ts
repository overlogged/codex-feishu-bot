import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";

import type { Env } from "../../config/env.js";
import type { CodexEvent } from "../../domain/types.js";
import { CodexAppServerWorker } from "./app-server-worker.js";
import type { CodexTurnContext, CodexWorker } from "./codex-worker.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function formatCpuLimit(): string {
  const halfCpus = Math.max(1, availableParallelism() / 2);
  const rounded = Math.round(halfCpus * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function shellCommandPreview(args: string[]): string {
  return ["docker", ...args]
    .map((part) => (/^[A-Za-z0-9_./:=+-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

function parseDockerHostPort(listenUrl: string): string {
  const url = new URL(listenUrl);
  if (!url.port) {
    throw new Error(`DOCKER_EXECUTION_LISTEN_URL 缺少端口：${listenUrl}`);
  }
  return url.port;
}

export class DockerCodexAppServerWorker implements CodexWorker {
  private readonly delegateEnv: Env;
  private readonly ensureServerPromiseByMode = new Map<string, Promise<void>>();

  constructor(
    private readonly env: Env,
    private readonly logger?: LoggerLike
  ) {
    this.delegateEnv = {
      ...env,
      CODEX_APP_SERVER_MANAGED: false,
      CODEX_APP_SERVER_LISTEN_URL: env.DOCKER_EXECUTION_LISTEN_URL
    };
  }

  async close(): Promise<void> {
    await this.stopContainer().catch((error) => {
      this.logger?.warn(
        {
          containerName: this.env.DOCKER_EXECUTION_CONTAINER_NAME,
          error: error instanceof Error ? error.message : String(error)
        },
        "停止 docker 执行池失败"
      );
    });
  }

  supportsSteer(): boolean {
    return true;
  }

  async ensureThread(context: CodexTurnContext): Promise<string> {
    await this.ensureServerReady();
    return this.createDelegate().ensureThread(context);
  }

  async steerTurn(context: CodexTurnContext & { threadId: string; turnId: string }): Promise<void> {
    await this.ensureServerReady();
    const delegate = this.createDelegate();
    if (!delegate.steerTurn) {
      throw new Error("docker codex worker 不支持 steerTurn");
    }
    return delegate.steerTurn(context);
  }

  async interruptTurn(context: CodexTurnContext & { threadId: string; turnId: string }): Promise<void> {
    await this.ensureServerReady();
    const delegate = this.createDelegate();
    if (!delegate.interruptTurn) {
      throw new Error("docker codex worker 不支持 interruptTurn");
    }
    return delegate.interruptTurn(context);
  }

  async *runTurn(context: CodexTurnContext & { threadId: string }): AsyncGenerator<CodexEvent> {
    await this.ensureServerReady();
    yield* this.createDelegate().runTurn(context);
  }

  private createDelegate(): CodexWorker {
    return new CodexAppServerWorker(this.delegateEnv, this.logger);
  }

  private async ensureServerReady(): Promise<void> {
    const key = "docker";
    const existing = this.ensureServerPromiseByMode.get(key);
    if (existing) {
      await existing;
      return;
    }

    const promise = this.doEnsureServerReady().finally(() => {
      this.ensureServerPromiseByMode.delete(key);
    });
    this.ensureServerPromiseByMode.set(key, promise);
    await promise;
  }

  private async doEnsureServerReady(): Promise<void> {
    await this.ensureImage();
    await this.ensureContainerRunning();
    await this.createDelegate().start?.();
  }

  private async ensureImage(): Promise<void> {
    const inspectResult = await this.runDockerCommand(["image", "inspect", this.env.DOCKER_EXECUTION_IMAGE], {
      allowFailure: true
    });
    if (inspectResult.exitCode === 0) {
      return;
    }

    this.logger?.info(
      {
        image: this.env.DOCKER_EXECUTION_IMAGE
      },
      "docker 执行池镜像不存在，准备本地构建"
    );
    await this.runDockerCommand([
      "build",
      "--target",
      "runtime",
      "-t",
      this.env.DOCKER_EXECUTION_IMAGE,
      process.cwd()
    ]);
  }

  private async ensureContainerRunning(): Promise<void> {
    const inspectResult = await this.runDockerCommand(
      ["inspect", "-f", "{{.State.Running}}", this.env.DOCKER_EXECUTION_CONTAINER_NAME],
      {
        allowFailure: true
      }
    );

    if (inspectResult.exitCode === 0) {
      if (inspectResult.stdout.trim() === "true") {
        return;
      }

      await this.runDockerCommand(["start", this.env.DOCKER_EXECUTION_CONTAINER_NAME]);
      return;
    }

    const hostPort = parseDockerHostPort(this.env.DOCKER_EXECUTION_LISTEN_URL);
    const dockerArgs = [
      "run",
      "-d",
      "--init",
      "--name",
      this.env.DOCKER_EXECUTION_CONTAINER_NAME,
      "--cpus",
      formatCpuLimit(),
      "--memory",
      this.env.DOCKER_EXECUTION_MEMORY,
      "-p",
      `127.0.0.1:${hostPort}:4500`,
      "-v",
      `${this.env.DOCKER_EXECUTION_MOUNT_ROOT}:${this.env.DOCKER_EXECUTION_MOUNT_ROOT}`,
      "-e",
      `HOME=${process.env.HOME ?? "/home/overlogged"}`,
      "-e",
      `CODEX_HOME_DIR=${process.env.HOME ?? "/home/overlogged"}/.codex`,
      "-e",
      "CODEX_APP_SERVER_LISTEN_URL=ws://0.0.0.0:4500",
      "-e",
      `FEISHU_APP_ID=${process.env.FEISHU_APP_ID ?? ""}`,
      "-e",
      `FEISHU_APP_SECRET=${process.env.FEISHU_APP_SECRET ?? ""}`,
      "-e",
      `FEISHU_DOMAIN=${process.env.FEISHU_DOMAIN ?? this.env.FEISHU_DOMAIN}`,
      "-e",
      `OPENAI_API_KEY=${process.env.OPENAI_API_KEY ?? ""}`
    ];

    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"] as const) {
      if (process.env[key]) {
        dockerArgs.push("-e", `${key}=${process.env[key]}`);
      }
    }

    if (typeof process.getuid === "function" && typeof process.getgid === "function") {
      dockerArgs.push("--user", `${process.getuid()}:${process.getgid()}`);
    }

    dockerArgs.push(this.env.DOCKER_EXECUTION_IMAGE, "start-codex-app-server");
    await this.runDockerCommand(dockerArgs);
  }

  private async stopContainer(): Promise<void> {
    await this.runDockerCommand(["rm", "-f", this.env.DOCKER_EXECUTION_CONTAINER_NAME], {
      allowFailure: true
    });
  }

  private async runDockerCommand(
    args: string[],
    options?: {
      allowFailure?: boolean;
    }
  ): Promise<CommandResult> {
    this.logger?.info(
      {
        command: shellCommandPreview(args)
      },
      "执行 docker 命令"
    );

    const result = await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn("docker", args, {
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (exitCode) => {
        resolve({
          stdout,
          stderr,
          exitCode: exitCode ?? 1
        });
      });
    }).catch((error) => ({
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 1
    }));

    if (result.exitCode !== 0 && !options?.allowFailure) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "docker 命令执行失败");
    }

    return result;
  }
}
