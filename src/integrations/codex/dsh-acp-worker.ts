import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { Env } from "../../config/env.js";
import type { CodexEvent } from "../../domain/types.js";
import { AsyncEventQueue } from "./async-event-queue.js";
import { buildCliTurnInput } from "./cli-turn-input.js";
import {
  KimiAcpSession,
  KimiAcpTurnProjector,
  terminateChildProcess,
  type KimiAcpProcessHandle,
  type KimiAcpRuntime
} from "./kimi-acp-worker.js";
import type { CodexInterruptContext, CodexTurnContext, CodexWorker } from "./codex-worker.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

const DSH_LABEL = "DSH ACP";

class HostDshAcpRuntime implements KimiAcpRuntime {
  constructor(
    private readonly env: Pick<Env, "DSH_ACP_COMMAND" | "DSH_ACP_PROFILE">
  ) {}

  spawnProcess(options: {
    context: CodexTurnContext;
    args: string[];
  }): KimiAcpProcessHandle {
    const child = spawn(
      this.env.DSH_ACP_COMMAND,
      ["--profile", this.env.DSH_ACP_PROFILE],
      {
        cwd: options.context.workspaceId,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    return {
      child,
      stop: () => terminateChildProcess(child)
    };
  }
}

interface ActiveDshTurn {
  session: KimiAcpSession;
  interrupted: boolean;
}

/**
 * DeepSeek Harness 后端，通过官方 `dsh --profile acp` 暴露的 ACP v1 stdio 协议接入。
 * 复用 Kimi ACP 的 JSON-RPC 客户端与事件投影，只替换进程启动方式和会话标签。
 * 模型/ provider 由 dsh profile 的配置决定（当前是 openmodel / deepseek-v4.1-flash）。
 */
export class DshAcpWorker implements CodexWorker {
  private readonly sessionsByChatId = new Map<string, KimiAcpSession>();
  private readonly activeTurns = new Map<string, ActiveDshTurn>();
  private readonly runtime: KimiAcpRuntime;

  constructor(
    env: Pick<Env, "DSH_ACP_COMMAND" | "DSH_ACP_PROFILE">,
    private readonly logger?: LoggerLike,
    runtime?: KimiAcpRuntime
  ) {
    this.runtime = runtime ?? new HostDshAcpRuntime(env);
  }

  supportsSteer(): boolean {
    return false;
  }

  async ensureThread(context: CodexTurnContext): Promise<string> {
    return context.session?.threadId ?? `pending:dsh-acp:${randomUUID()}`;
  }

  async interruptTurn(context: CodexInterruptContext): Promise<void> {
    const activeTurn = this.activeTurns.get(context.turnId);
    if (!activeTurn) {
      return;
    }

    activeTurn.interrupted = true;
    activeTurn.session.cancel();
    // 等 in-flight turn 结束，否则紧随其后的新 prompt 会被 ACP 拒绝。
    await activeTurn.session.waitForIdle();
  }

  async *runTurn(
    context: CodexTurnContext & { threadId: string }
  ): AsyncGenerator<CodexEvent> {
    const turnId = randomUUID();

    this.logger?.info(
      {
        cli: "dsh",
        mode: "acp",
        chatId: context.message.chatId,
        messageId: context.message.messageId,
        workspaceId: context.workspaceId,
        threadId: context.threadId
      },
      "开始执行 DSH ACP turn"
    );

    yield {
      kind: "turn_bound",
      turnId
    };
    yield {
      kind: "run_status",
      status: "running"
    };

    const session = await this.getOrCreateSession(context);
    await session.waitForIdle();
    const sessionId = await session.ensureSession(
      context.threadId.startsWith("pending:") ? undefined : context.threadId
    );
    yield {
      kind: "thread_bound",
      threadId: sessionId
    };

    const eventQueue = new AsyncEventQueue<CodexEvent>();
    const projector = new KimiAcpTurnProjector(turnId, DSH_LABEL);
    const activeTurn: ActiveDshTurn = {
      session,
      interrupted: false
    };
    this.activeTurns.set(turnId, activeTurn);

    session.setUpdateHandler((update) => {
      for (const event of projector.ingestUpdate(update)) {
        eventQueue.push(event);
      }
    });

    void (async () => {
      try {
        const result = await session.prompt(buildCliTurnInput(context));
        const cancelled = activeTurn.interrupted || result.stopReason === "cancelled";
        for (const event of projector.finalize({ cancelled })) {
          eventQueue.push(event);
        }
      } catch (error) {
        for (const event of projector.finalize({
          cancelled: activeTurn.interrupted,
          errorMessage: activeTurn.interrupted
            ? undefined
            : error instanceof Error
              ? error.message
              : String(error)
        })) {
          eventQueue.push(event);
        }
      } finally {
        session.setUpdateHandler(undefined);
        eventQueue.close();
        this.activeTurns.delete(turnId);
      }
    })();

    for (;;) {
      const next = await eventQueue.next();
      if (next.done) {
        break;
      }

      yield next.value;
    }
  }

  async close(): Promise<void> {
    const sessions = Array.from(this.sessionsByChatId.values());
    this.sessionsByChatId.clear();
    await Promise.allSettled(sessions.map((session) => session.stop()));
  }

  private async getOrCreateSession(
    context: CodexTurnContext & { threadId: string }
  ): Promise<KimiAcpSession> {
    const chatId = context.message.chatId;
    const desiredThreadId = context.threadId.startsWith("pending:") ? undefined : context.threadId;
    const existing = this.sessionsByChatId.get(chatId);

    if (existing?.isAlive()) {
      if (desiredThreadId && existing.sessionId && existing.sessionId !== desiredThreadId) {
        this.logger?.info(
          {
            chatId,
            previousSessionId: existing.sessionId,
            nextThreadId: desiredThreadId
          },
          "DSH ACP 会话线程已切换，重启 ACP 进程"
        );
        this.sessionsByChatId.delete(chatId);
        await existing.stop();
      } else {
        return existing;
      }
    } else if (existing) {
      this.sessionsByChatId.delete(chatId);
    }

    await this.runtime.prepare?.();
    const handle = this.runtime.spawnProcess({
      context,
      args: ["--profile", "acp"]
    });
    const session = new KimiAcpSession(handle, context.workspaceId, this.logger, DSH_LABEL);
    this.sessionsByChatId.set(chatId, session);
    handle.child.once("close", () => {
      if (this.sessionsByChatId.get(chatId) === session) {
        this.sessionsByChatId.delete(chatId);
      }
    });
    await session.ready();
    return session;
  }
}
