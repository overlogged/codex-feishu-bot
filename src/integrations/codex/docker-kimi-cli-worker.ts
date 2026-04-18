import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

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
  KimiCliWorker,
  type KimiCliProcessHandle,
  type KimiCliRuntime
} from "./kimi-cli-worker.js";

function sanitizeContainerName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
}

async function terminateDockerRunProcess(
  child: ChildProcessByStdio<Writable, Readable, Readable>
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

class DockerKimiCliRuntime implements KimiCliRuntime {
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
        await this.cleanupOrphanKimiContainers();
      })();
    }

    await this.preparePromise;
  }

  spawnProcess(options: {
    turnId: string;
    context: CodexTurnContext;
    args: string[];
  }): KimiCliProcessHandle {
    const containerName = sanitizeContainerName(
      `${this.env.DOCKER_EXECUTION_CONTAINER_NAME}-kimi-${options.turnId}`
    );
    const dockerArgs = buildDockerExecutionRunArgs(this.env, {
      containerName,
      interactive: true,
      remove: true,
      workdir: options.context.workspaceId,
      passthroughEnvPrefixes: ["KIMI_", "MOONSHOT_"],
      command: [this.env.KIMI_CLI_COMMAND, ...options.args]
    });
    const invocation = resolveDockerCommandInvocation(dockerArgs);
    this.logger?.info(
      {
        containerName,
        command: buildShellCommand([invocation.command, ...invocation.args]),
        workspaceId: options.context.workspaceId
      },
      "开始执行 docker Kimi Wire turn"
    );

    const child = spawn(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stopPromise: Promise<void> | undefined;
    return {
      child,
      stop: async () => {
        if (!stopPromise) {
          stopPromise = (async () => {
            await this.docker.run(["rm", "-f", containerName], {
              allowFailure: true,
              timeoutMs: 2_000
            });
            await terminateDockerRunProcess(child);
          })();
        }

        await stopPromise;
      }
    };
  }

  private async cleanupOrphanKimiContainers(): Promise<void> {
    const namePrefix = `${this.env.DOCKER_EXECUTION_CONTAINER_NAME}-kimi-`;
    const listed = await this.docker.run(
      ["ps", "-aq", "--filter", `name=${namePrefix}`],
      {
        allowFailure: true,
        timeoutMs: 2_000
      }
    );
    const containerIds = listed.stdout
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean);

    if (containerIds.length === 0) {
      return;
    }

    this.logger?.warn(
      {
        containerIds,
        namePrefix
      },
      "清理遗留的 docker Kimi Wire 容器"
    );
    await this.docker.run(["rm", "-f", ...containerIds], {
      allowFailure: true,
      timeoutMs: 5_000
    });
  }
}

export class DockerKimiCliWorker extends KimiCliWorker {
  constructor(env: Env, logger?: LoggerLike) {
    super(env, logger, new DockerKimiCliRuntime(env, logger));
  }
}
