import { clearProxyEnv } from "../../config/proxy-env.js";
import { applyAcpBindingSettings } from "./acp-binding-settings.js";
import { applyDshModelSelection } from "./dsh-session-settings.js";
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

/** DSH uses Node fetch; proxy environment support must be enabled at process startup. */
export function dshProcessEnv(proxy?: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  clearProxyEnv(env);
  delete env.NODE_USE_ENV_PROXY;
  if (proxy?.trim()) {
    env.http_proxy = env.https_proxy = env.HTTP_PROXY = env.HTTPS_PROXY = proxy.trim();
    env.no_proxy = env.NO_PROXY = "localhost,127.0.0.1,::1";
    env.NODE_USE_ENV_PROXY = "1";
  }
  return env;
}

class HostDshAcpRuntime implements KimiAcpRuntime {
  constructor(
    private readonly env: Pick<Env, "DSH_ACP_COMMAND" | "DSH_ACP_PROFILE"> & Partial<Pick<Env, "DSH_PROXY_URL">>
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
        env: dshProcessEnv(this.env.DSH_PROXY_URL),
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
  chatId: string;
  threadId: string;
}

/**
 * DeepSeek Harness 后端，通过官方 `dsh --profile acp` 暴露的 ACP v1 stdio 协议接入。
 * 复用 Kimi ACP 的 JSON-RPC 客户端与事件投影，只替换进程启动方式和会话标签。
 * 支持按群选择 DeepSeek 账号和 OpenCode 等 provider，并使用 ACP 广告的模型路由。
 */
export class DshAcpWorker implements CodexWorker {
  private readonly sessionsByChatId = new Map<string, KimiAcpSession>();
  private readonly activeTurns = new Map<string, ActiveDshTurn>();
  private readonly runtime: KimiAcpRuntime;

  private readonly reasoningEffort?: string;

  constructor(
    env: Pick<Env, "DSH_ACP_COMMAND" | "DSH_ACP_PROFILE"> &
      Partial<Pick<Env, "DSH_ACP_REASONING" | "DSH_PROXY_URL">>,
    private readonly logger?: LoggerLike,
    runtime?: KimiAcpRuntime
  ) {
    this.runtime = runtime ?? new HostDshAcpRuntime(env);
    this.reasoningEffort = env.DSH_ACP_REASONING?.trim() || undefined;
  }

  /**
   * dsh 的 ACP 没有 in-turn 输入通道：`KimiAcpSession.runPrompt` 必须等前一轮
   * `session/prompt` 返回才能发下一次（同 session 不允许并发 prompt，否则 agent 会回
   * "another turn is already in progress"）。所以这里的 steer 语义是
   * **「当前轮自然结束后，用这条消息接力下一轮」**——不调用 session/cancel，
   * 因此当前任务能正常跑完，只是紧接着处理新消息。
   *
   * `KimiAcpSession.prompt` 已内置串行化，这里直接复用即可。
   */
  supportsSteer(): boolean {
    return true;
  }

  /**
   * 把新消息排进当前会话，在当前轮结束后接力执行。
   */
  async steerTurn(context: CodexTurnContext & { threadId: string; turnId: string }): Promise<void> {
    const activeTurn = this.activeTurns.get(context.turnId);
    if (!activeTurn) {
      throw Object.assign(new Error("DSH 当前任务已结束，无法追加消息。"), {
        code: "DSH_TURN_FINISHED"
      });
    }

    if (activeTurn.interrupted || activeTurn.chatId !== context.message.chatId ||
      activeTurn.threadId !== context.threadId) {
      throw Object.assign(new Error("DSH 当前任务已进入收尾，等待结束后继续处理新消息。"), {
        code: "DSH_TURN_FINISHED"
      });
    }

    const text = buildCliTurnInput(context);
    // 不 await：prompt 内部会等当前轮结束再发送，这里只需把接力排上就返回，
    // 调用方与用户都不会被当前轮的剩余耗时阻塞。
    void activeTurn.session.prompt(text).catch((error: unknown) => {
      this.logger?.warn(
        {
          chatId: context.message.chatId,
          messageId: context.message.messageId,
          sessionId: activeTurn.session.sessionId ?? null,
          error: error instanceof Error ? error.message : String(error)
        },
        "DSH ACP 追加 steer 消息失败"
      );
    });

    this.logger?.info(
      {
        chatId: context.message.chatId,
        messageId: context.message.messageId,
        threadId: context.threadId,
        turnId: context.turnId
      },
      "已向运行中的 DSH 会话排队 steer 消息，将在当前轮结束后接力"
    );
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

    // Model selection resets model-dependent reasoning settings in DSH.
    await applyDshModelSelection(session, { provider: context.provider, model: context.model });
    if (context.thinking) {
      await applyAcpBindingSettings(session, { thinking: context.thinking });
    } else if (this.reasoningEffort) {
      try {
        await applyAcpBindingSettings(session, { thinking: this.reasoningEffort });
      } catch (error) {
        this.logger?.warn(
          {
            chatId: context.message.chatId,
            sessionId,
            reasoningEffort: this.reasoningEffort,
            error: error instanceof Error ? error.message : String(error)
          },
          "DSH ACP 设置 reasoning_effort 失败，将使用会话默认值"
        );
      }
    }

    const eventQueue = new AsyncEventQueue<CodexEvent>();
    const projector = new KimiAcpTurnProjector(turnId, DSH_LABEL);
    const activeTurn: ActiveDshTurn = {
      session,
      interrupted: false,
      chatId: context.message.chatId,
      threadId: context.threadId
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
        // dsh 有时（尤其是定时任务、工具调用之后）只输出思考过程、不输出正文，
        // 这里补一轮索要最终答复，避免用户只看到错误而没有回复。
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
            "DSH ACP 只返回了思考过程，追加一轮索要最终答复"
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
