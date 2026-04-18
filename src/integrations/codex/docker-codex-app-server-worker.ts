import type { Env } from "../../config/env.js";
import type { CodexEvent } from "../../domain/types.js";
import { CodexAppServerWorker } from "./app-server-worker.js";
import type { CodexInterruptContext, CodexTurnContext, CodexWorker } from "./codex-worker.js";
import {
  buildDockerExecutionRunArgs,
  DockerCommandRunner,
  type LoggerLike
} from "./docker-runtime.js";

function parseDockerHostPort(listenUrl: string): string {
  const url = new URL(listenUrl);
  if (!url.port) {
    throw new Error(`DOCKER_EXECUTION_LISTEN_URL 缺少端口：${listenUrl}`);
  }
  return url.port;
}

export class DockerCodexAppServerWorker implements CodexWorker {
  private readonly delegateEnv: Env;
  private readonly docker: DockerCommandRunner;
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
    this.docker = new DockerCommandRunner(env, logger);
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

  async interruptTurn(context: CodexInterruptContext): Promise<void> {
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
    await this.docker.ensureImage();
    await this.ensureContainerRunning();
    await this.createDelegate().start?.();
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

      await this.docker.run(["start", this.env.DOCKER_EXECUTION_CONTAINER_NAME]);
      return;
    }

    const hostPort = parseDockerHostPort(this.env.DOCKER_EXECUTION_LISTEN_URL);
    const dockerArgs = buildDockerExecutionRunArgs(this.env, {
      containerName: this.env.DOCKER_EXECUTION_CONTAINER_NAME,
      detach: true,
      publishPorts: [`127.0.0.1:${hostPort}:4500`],
      extraEnv: {
        CODEX_APP_SERVER_LISTEN_URL: "ws://0.0.0.0:4500",
        FEISHU_APP_ID: process.env.FEISHU_APP_ID ?? "",
        FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET ?? "",
        FEISHU_DOMAIN: process.env.FEISHU_DOMAIN ?? this.env.FEISHU_DOMAIN,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? ""
      },
      command: ["start-codex-app-server"]
    });
    await this.docker.run(dockerArgs);
  }

  private async stopContainer(): Promise<void> {
    await this.docker.run(["rm", "-f", this.env.DOCKER_EXECUTION_CONTAINER_NAME], {
      allowFailure: true,
      timeoutMs: 2_000
    });
  }
}
