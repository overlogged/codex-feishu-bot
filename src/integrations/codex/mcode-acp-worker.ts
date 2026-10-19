import { applyAcpBindingSettings } from "./acp-binding-settings.js";
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

const MCODE_LABEL = "MCode ACP";

class HostMcodeAcpRuntime implements KimiAcpRuntime {
  constructor(
    private readonly env: Pick<Env, "MCODE_ACP_COMMAND" | "MCODE_ACP_ARGS">
  ) {}

  spawnProcess(options: {
    context: CodexTurnContext;
    args: string[];
  }): KimiAcpProcessHandle {
    const child = spawn(
      this.env.MCODE_ACP_COMMAND,
      this.env.MCODE_ACP_ARGS,
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

interface ActiveMcodeTurn {
  session: KimiAcpSession;
  interrupted: boolean;
}

/**
 * MiniMax Code 后端，通过 `mcode acp` 暴露的 ACP v1 stdio 协议接入。
 * 复用 Kimi ACP 的 JSON-RPC 客户端与事件投影，只替换进程启动方式和会话标签。
 *
 * 与 dsh 的差异：mcode 把思考档位命名为 `thinkingEffort`（dsh 是 `reasoning_effort`），
 * 并且提供 `permissionMode` 取代 dsh 的权限预设。
 */
export class McodeAcpWorker implements CodexWorker {
  private readonly sessionsByChatId = new Map<string, KimiAcpSession>();
  private readonly activeTurns = new Map<string, ActiveMcodeTurn>();
  private readonly runtime: KimiAcpRuntime;

  private readonly args: string[];
  private readonly reasoningEffort?: string;
  private readonly permissionMode?: string;

  constructor(
    env: Pick<Env, "MCODE_ACP_COMMAND" | "MCODE_ACP_ARGS"> &
      Partial<Pick<Env, "MCODE_ACP_REASONING" | "MCODE_ACP_PERMISSION_MODE">>,
    private readonly logger?: LoggerLike,
    runtime?: KimiAcpRuntime
  ) {
    this.runtime = runtime ?? new HostMcodeAcpRuntime(env);
    this.args = env.MCODE_ACP_ARGS;
    this.reasoningEffort = env.MCODE_ACP_REASONING?.trim() || undefined;
    this.permissionMode = env.MCODE_ACP_PERMISSION_MODE?.trim() || undefined;
  }

  supportsSteer(): boolean {
    return false;
  }

  async ensureThread(context: CodexTurnContext): Promise<string> {
    return context.session?.threadId ?? `pending:mcode-acp:${randomUUID()}`;
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
        cli: "mcode",
        mode: "acp",
        chatId: context.message.chatId,
        messageId: context.message.messageId,
        workspaceId: context.workspaceId,
        threadId: context.threadId
      },
      "开始执行 MCode ACP turn"
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

    // mcode ACP 会话默认没有思考档位，不设置的话模型不会输出思考过程。
    if (this.reasoningEffort) {
      await this.trySetConfigOption(session, {
        configId: "thinkingEffort",
        value: this.reasoningEffort,
        context,
        sessionId,
        description: "thinkingEffort"
      });
    }

    if (this.permissionMode) {
      await this.trySetConfigOption(session, {
        configId: "permissionMode",
        value: this.permissionMode,
        context,
        sessionId,
        description: "permissionMode"
      });
    }

    await applyAcpBindingSettings(session, { provider: context.provider, model: context.model, thinking: context.thinking });

    const eventQueue = new AsyncEventQueue<CodexEvent>();
    const projector = new KimiAcpTurnProjector(turnId, MCODE_LABEL);
    const activeTurn: ActiveMcodeTurn = {
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
        let result = await session.prompt(buildCliTurnInput(context));
        // 和 dsh 一样：偶尔只输出思考过程而不给最终答复，补一轮索要正文。
        if (
          !activeTurn.interrupted &&
          result.stopReason !== "cancelled" &&
          !projector.hasFinalAnswer() &&
          projector.hasCommentary()
        ) {
          this.logger?.warn(
            {
              chatId: context.message.chatId,
              messageId: context.message.messageId,
              sessionId
            },
            "MCode ACP 只返回了思考过程，追加一轮索要最终答复"
          );
          result = await session.prompt(
            "请基于上面的分析，用中文直接给出最终答复，不要再只输出思考，也不要再调用工具。"
          );
        }
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

  /**
   * 设置一个可选的 ACP 会话配置项。
   *
   * 只有当该后端确实在 session/new 的 configOptions 里声明了这个选项时才下发，
   * 这样后端调整选项名时只会退回默认值，而不会让整轮 turn 失败。
   */
  private async trySetConfigOption(
    session: KimiAcpSession,
    options: {
      configId: string;
      value: string;
      context: CodexTurnContext & { threadId: string };
      sessionId: string;
      description: string;
    }
  ): Promise<void> {
    const advertised = session.configOptions.some(
      (option) => record(option) && option.id === options.configId
    );
    if (!advertised) {
      this.logger?.warn(
        {
          chatId: options.context.message.chatId,
          sessionId: options.sessionId,
          configId: options.configId,
          advertised: session.configOptions.map((option) => (record(option) ? option.id : undefined))
        },
        `MCode ACP 未提供 ${options.description} 配置项，跳过设置并使用会话默认值`
      );
      return;
    }

    try {
      await session.setConfigOption(options.configId, options.value);
    } catch (error) {
      this.logger?.warn(
        {
          chatId: options.context.message.chatId,
          sessionId: options.sessionId,
          configId: options.configId,
          value: options.value,
          error: error instanceof Error ? error.message : String(error)
        },
        `MCode ACP 设置 ${options.description} 失败，将使用会话默认值`
      );
    }
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
          "MCode ACP 会话线程已切换，重启 ACP 进程"
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
      args: this.args
    });
    const session = new KimiAcpSession(handle, context.workspaceId, this.logger, MCODE_LABEL);
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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
