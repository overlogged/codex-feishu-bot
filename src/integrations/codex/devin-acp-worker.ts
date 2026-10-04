import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Env } from "../../config/env.js";
import { clearProxyEnv } from "../../config/proxy-env.js";
import type { CodexEvent } from "../../domain/types.js";
import { AsyncEventQueue } from "./async-event-queue.js";
import { buildCliTurnInput } from "./cli-turn-input.js";
import { KimiAcpSession, KimiAcpTurnProjector, terminateChildProcess, type KimiAcpRuntime } from "./kimi-acp-worker.js";
import type { CodexInterruptContext, CodexTurnContext, CodexWorker } from "./codex-worker.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}
type DevinConfig = Pick<Env, "DEVIN_ACP_COMMAND" | "DEVIN_ACP_MODEL" | "DEVIN_PROXY_URL">;

export function devinProcessEnv(proxy?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  clearProxyEnv(env);
  if (proxy) {
    env.http_proxy = env.https_proxy = env.HTTP_PROXY = env.HTTPS_PROXY = proxy;
    env.no_proxy = env.NO_PROXY = "localhost,127.0.0.1,::1";
  }
  return env;
}

export function buildDevinAcpArgs(model?: string): string[] {
  return ["--permission-mode", "dangerous", "--respect-workspace-trust", "false", "acp",
    ...(model ? ["--model", model] : [])];
}

/** Resolve user-facing aliases against the live ACP catalog, never silently change model families. */
export function resolveDevinModel(requested: string, configOptions: unknown[]): string {
  const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
  const config = configOptions.find((option) => record(option) && option.id === "model");
  if (!record(config) || !Array.isArray(config.options)) {
    throw new Error("Devin 未返回可用模型列表，无法确认所选模型。");
  }
  const flatten = (options: unknown[]): Record<string, unknown>[] => options.flatMap(option =>
    !record(option) ? [] : Array.isArray(option.options) ? flatten(option.options) : [option]);
  const options = flatten(config.options).filter(option => typeof option.value === "string");
  const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^claude/, "");
  const wanted = key(requested);
  const exact = options.filter(option => option.value === requested || key(String(option.value)) === wanted ||
    (typeof option.name === "string" && key(option.name) === wanted));
  if (exact.length === 1) return String(exact[0]!.value);
  const matches = options.filter(option => {
    const value = key(String(option.value));
    return value === wanted || ["off", "low", "medium", "high", "xhigh", "max", "ultra"].some(effort => value === wanted + effort);
  });
  const preferred = matches.find(option => option.value === config.currentValue) ??
    matches.find(option => key(String(option.value)) === wanted + "medium") ??
    (matches.length === 1 ? matches[0] : undefined);
  if (preferred) return String(preferred.value);
  throw new Error(`Devin 无法匹配模型“${requested}”。请使用完整模型 ID：${options.map(option => option.value).join(", ")}`);
}

/** Devin owns file/terminal tools. The bridge advertises no host tool capabilities. */
export class DevinAcpWorker implements CodexWorker {
  private readonly sessions = new Map<string, {
    session: KimiAcpSession; workspaceId: string; initialThreadId: string; ready: Promise<void>;
  }>();
  private readonly activeTurns = new Map<string, { session: KimiAcpSession; interrupted: boolean }>();
  private readonly runtime: KimiAcpRuntime;

  constructor(private readonly env: DevinConfig, private readonly logger?: LoggerLike, runtime?: KimiAcpRuntime) {
    this.runtime = runtime ?? { spawnProcess: ({ context, args }) => {
      const child = spawn(env.DEVIN_ACP_COMMAND, args, {
        cwd: context.workspaceId, env: devinProcessEnv(env.DEVIN_PROXY_URL), stdio: ["pipe", "pipe", "pipe"]
      });
      return { child, stop: () => terminateChildProcess(child) };
    } };
  }

  supportsSteer(): boolean { return false; }

  async ensureThread(context: CodexTurnContext): Promise<string> {
    return context.session?.threadId ?? `pending:devin:${randomUUID()}`;
  }

  async interruptTurn(context: CodexInterruptContext): Promise<void> {
    const active = this.activeTurns.get(context.turnId);
    if (!active) return;
    active.interrupted = true;
    active.session.cancel();
    await active.session.waitForIdle();
  }

  async *runTurn(context: CodexTurnContext & { threadId: string }): AsyncGenerator<CodexEvent> {
    const turnId = randomUUID();
    const session = await this.getSession(context);
    await session.waitForIdle();
    // ACP session/new defaults to accept-edits even with the CLI permission flag.
    await session.setConfigOption("mode", "bypass");
    if (context.model) {
      const model = resolveDevinModel(context.model, session.configOptions);
      await session.setConfigOption("model", model);
      this.logger?.info({ cli: "devin", requestedModel: context.model, model }, "Devin 模型已确认");
    }
    const sessionId = session.sessionId!;
    const active = { session, interrupted: false };
    this.activeTurns.set(turnId, active);
    const queue = new AsyncEventQueue<CodexEvent>();
    const projector = new KimiAcpTurnProjector(turnId, "Devin ACP");
    session.setUpdateHandler((update) => {
      for (const event of projector.ingestUpdate(update)) queue.push(event);
    });
    this.logger?.info({ cli: "devin", chatId: context.message.chatId, threadId: sessionId }, "开始执行 Devin ACP turn");
    yield { kind: "thread_bound", threadId: sessionId };
    yield { kind: "turn_bound", turnId };
    yield { kind: "run_status", status: "running" };

    void (async () => {
      try {
        const result = await session.prompt(buildCliTurnInput(context));
        for (const event of projector.finalize({ cancelled: active.interrupted || result.stopReason === "cancelled" })) queue.push(event);
      } catch (error) {
        for (const event of projector.finalize({ cancelled: active.interrupted,
          errorMessage: active.interrupted ? undefined : error instanceof Error ? error.message : String(error) })) queue.push(event);
      } finally {
        session.setUpdateHandler(undefined);
        this.activeTurns.delete(turnId);
        queue.close();
      }
    })();
    yield* queue.iterate();
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map(({ session }) => session.stop()));
  }

  private async getSession(context: CodexTurnContext & { threadId: string }): Promise<KimiAcpSession> {
    const chatId = context.message.chatId;
    const existing = this.sessions.get(chatId);
    if (existing && existing.session.isAlive() && existing.workspaceId === context.workspaceId &&
        (context.threadId === existing.session.sessionId || context.threadId === existing.initialThreadId)) {
      await existing.ready;
      return existing.session;
    }
    if (existing) {
      this.sessions.delete(chatId);
      await existing.session.stop();
    }
    await this.runtime.prepare?.();
    const handle = this.runtime.spawnProcess({ context, args: buildDevinAcpArgs(this.env.DEVIN_ACP_MODEL) });
    const session = new KimiAcpSession(handle, context.workspaceId, this.logger, "Devin ACP", {
      resumeMethod: "session/load", strictResume: true, requestTimeoutMs: 45_000
    });
    const ready = (async () => {
      await session.ready();
      await session.ensureSession(context.threadId.startsWith("pending:") ? undefined : context.threadId);
    })();
    this.sessions.set(chatId, { session, workspaceId: context.workspaceId, initialThreadId: context.threadId, ready });
    handle.child.once("close", () => {
      if (this.sessions.get(chatId)?.session === session) this.sessions.delete(chatId);
    });
    try { await ready; } catch (error) {
      if (this.sessions.get(chatId)?.session === session) this.sessions.delete(chatId);
      await session.stop();
      throw error;
    }
    return session;
  }
}
