import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import type { Env } from "../../config/env.js";
import type { CodexEvent } from "../../domain/types.js";
import { AsyncEventQueue } from "./async-event-queue.js";
import { buildCliTurnInput } from "./cli-turn-input.js";
import { resolveKimiAcpWirePath } from "./thread-transcript.js";
import type {
  CodexInterruptContext,
  CodexTurnContext,
  CodexWorker
} from "./codex-worker.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

export type KimiAcpChild = ChildProcessByStdio<Writable, Readable, Readable>;

export interface KimiAcpProcessHandle {
  child: KimiAcpChild;
  stop(): Promise<void>;
}

export interface KimiAcpRuntime {
  prepare?(): Promise<void>;
  spawnProcess(options: {
    context: CodexTurnContext;
    args: string[];
  }): KimiAcpProcessHandle;
}

export type KimiAcpSpawnProcess = (options: {
  context: CodexTurnContext;
  args: string[];
}) => KimiAcpProcessHandle;

async function terminateChildProcess(child: KimiAcpChild): Promise<void> {
  if (child.killed || child.exitCode !== null) {
    return;
  }

  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
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

class HostKimiAcpRuntime implements KimiAcpRuntime {
  constructor(private readonly env: Pick<Env, "KIMI_ACP_COMMAND">) {}

  spawnProcess(options: {
    context: CodexTurnContext;
    args: string[];
  }): KimiAcpProcessHandle {
    const child = spawn(this.env.KIMI_ACP_COMMAND, options.args, {
      cwd: options.context.workspaceId,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    return {
      child,
      stop: () => terminateChildProcess(child)
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateText(value: string, maxLength = 200): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function extractAcpToolCommand(rawInput: unknown): string | undefined {
  if (!isRecord(rawInput)) {
    return undefined;
  }

  for (const key of ["command", "cmd"]) {
    const value = rawInput[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function extractAcpToolPath(update: Record<string, unknown>): string | undefined {
  const rawInput = isRecord(update.rawInput) ? update.rawInput : undefined;
  for (const key of ["path", "file_path", "filePath"]) {
    const value = rawInput?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  const locations = Array.isArray(update.locations) ? update.locations : [];
  for (const location of locations) {
    if (isRecord(location) && typeof location.path === "string" && location.path.trim()) {
      return location.path.trim();
    }
  }

  return undefined;
}

function extractAcpContentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  const parts: string[] = [];
  for (const entry of content) {
    if (!isRecord(entry)) {
      continue;
    }

    if (entry.type === "content" && isRecord(entry.content)) {
      const inner = entry.content;
      if (inner.type === "text" && typeof inner.text === "string" && inner.text) {
        parts.push(inner.text);
      }
      continue;
    }

    if (entry.type === "diff" && typeof entry.path === "string") {
      parts.push(`修改文件: ${entry.path}`);
    }
  }

  return parts.length > 0 ? parts.join("\n") : undefined;
}

function extractAcpRawOutput(rawOutput: unknown): string | undefined {
  if (typeof rawOutput === "string" && rawOutput.trim()) {
    return rawOutput;
  }

  if (isRecord(rawOutput)) {
    for (const key of ["output", "stdout", "content", "text"]) {
      const value = rawOutput[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
  }

  return undefined;
}

interface AcpToolState {
  itemId: string;
  title: string;
  emittedCommand?: string;
  emittedPath?: string;
  completed: boolean;
}

export class KimiAcpTurnProjector {
  private readonly commentaryItemId: string;
  private readonly finalItemId: string;
  private commentaryStarted = false;
  private finalStarted = false;
  private commentaryText = "";
  private finalText = "";
  private toolSequence = 0;
  private readonly toolStateByCallId = new Map<string, AcpToolState>();

  constructor(private readonly turnId: string) {
    this.commentaryItemId = `assistant:${turnId}:commentary`;
    this.finalItemId = `assistant:${turnId}:final`;
  }

  hasVisibleActivity(): boolean {
    return this.commentaryStarted || this.finalStarted || this.toolSequence > 0;
  }

  announceQueued(): CodexEvent[] {
    const itemId = `assistant:${this.turnId}:notice`;
    const text =
      "Kimi 还在执行上一条指令，这条消息已在 Kimi 侧排队；轮到它时结果会同步到这里。";
    return [
      { kind: "assistant_message_started", itemId, source: "commentary" },
      { kind: "assistant_message_delta", itemId, text },
      { kind: "assistant_message_completed", itemId, text }
    ];
  }

  ingestRecoveredFinal(text: string): CodexEvent[] {
    const events = this.ensureFinalStarted();
    this.finalText += text;
    events.push({
      kind: "assistant_message_delta",
      itemId: this.finalItemId,
      text
    });
    return events;
  }

  ingestUpdate(update: Record<string, unknown>): CodexEvent[] {
    switch (update.sessionUpdate) {
      case "agent_thought_chunk":
        return this.ingestChunk(update, "commentary");
      case "agent_message_chunk":
        return this.ingestChunk(update, "final");
      case "tool_call":
        return this.ingestToolCall(update);
      case "tool_call_update":
        return this.ingestToolCallUpdate(update);
      default:
        return [];
    }
  }

  finalize(options: {
    cancelled?: boolean;
    errorMessage?: string;
  }): CodexEvent[] {
    const events: CodexEvent[] = [];

    if (this.commentaryStarted) {
      events.push({
        kind: "assistant_message_completed",
        itemId: this.commentaryItemId,
        text: this.commentaryText
      });
    }

    if (this.finalStarted) {
      events.push({
        kind: "assistant_message_completed",
        itemId: this.finalItemId,
        text: this.finalText
      });
    }

    if (options.errorMessage) {
      events.push({
        kind: "error",
        message: options.errorMessage
      });
      return events;
    }

    if (!options.cancelled && !this.finalStarted) {
      events.push({
        kind: "error",
        message: this.commentaryStarted
          ? "Kimi ACP 没有返回最终答复。"
          : "Kimi ACP 没有返回可见内容。"
      });
    }

    return events;
  }

  private ingestChunk(
    update: Record<string, unknown>,
    target: "commentary" | "final"
  ): CodexEvent[] {
    const content = isRecord(update.content) ? update.content : undefined;
    const text = typeof content?.text === "string" ? content.text : "";
    if (!text) {
      return [];
    }

    const events =
      target === "commentary" ? this.ensureCommentaryStarted() : this.ensureFinalStarted();
    if (target === "commentary") {
      this.commentaryText += text;
    } else {
      this.finalText += text;
    }

    events.push({
      kind: "assistant_message_delta",
      itemId: target === "commentary" ? this.commentaryItemId : this.finalItemId,
      text
    });
    return events;
  }

  private ingestToolCall(update: Record<string, unknown>): CodexEvent[] {
    const toolCallId =
      typeof update.toolCallId === "string" && update.toolCallId
        ? update.toolCallId
        : `anonymous:${++this.toolSequence}`;
    const title =
      typeof update.title === "string" && update.title.trim() ? update.title.trim() : "工具调用";
    const itemId = `tool:${this.turnId}:${++this.toolSequence}`;
    const events: CodexEvent[] = [
      {
        kind: "tool_call_started",
        itemId,
        title,
        command: extractAcpToolCommand(update.rawInput)
      }
    ];

    this.toolStateByCallId.set(toolCallId, {
      itemId,
      title,
      emittedCommand: extractAcpToolCommand(update.rawInput),
      emittedPath: extractAcpToolCommand(update.rawInput)
        ? undefined
        : extractAcpToolPath(update),
      completed: false
    });

    events.push(...this.ingestToolProgress(toolCallId, update));
    return events;
  }

  private ingestToolCallUpdate(update: Record<string, unknown>): CodexEvent[] {
    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
    if (!toolCallId) {
      return [];
    }

    let state = this.toolStateByCallId.get(toolCallId);
    if (!state) {
      const title =
        typeof update.title === "string" && update.title.trim() ? update.title.trim() : "工具调用";
      state = {
        itemId: `tool:${this.turnId}:${++this.toolSequence}`,
        title,
        completed: false
      };
      this.toolStateByCallId.set(toolCallId, state);
      return [
        {
          kind: "tool_call_started",
          itemId: state.itemId,
          title,
          command: extractAcpToolCommand(update.rawInput)
        },
        ...this.ingestToolProgress(toolCallId, update)
      ];
    }

    return this.ingestToolProgress(toolCallId, update);
  }

  private ingestToolProgress(
    toolCallId: string,
    update: Record<string, unknown>
  ): CodexEvent[] {
    const state = this.toolStateByCallId.get(toolCallId);
    if (!state || state.completed) {
      return [];
    }

    const events: CodexEvent[] = [];
    const status = update.status;

    // kimi-code streams the tool arguments as cumulative partial-JSON content
    // while status is still in_progress; only rawInput marks the finalized
    // arguments. Emitting those fragments would stack noisy JSON prefixes on
    // the tool card, so mid-flight updates only surface the finalized
    // command/path, and output is only emitted at a terminal status.
    if (status !== "completed" && status !== "failed") {
      if (isRecord(update.rawInput)) {
        const command = extractAcpToolCommand(update.rawInput);
        if (command && command !== state.emittedCommand) {
          state.emittedCommand = command;
          events.push({
            kind: "tool_call_delta",
            itemId: state.itemId,
            detail: `执行: ${command}`
          });
        }

        const path = extractAcpToolPath(update);
        if (!command && path && path !== state.emittedPath) {
          state.emittedPath = path;
          events.push({
            kind: "tool_call_delta",
            itemId: state.itemId,
            detail: `文件: ${path}`
          });
        }
      }

      return events;
    }

    state.completed = true;
    const output =
      extractAcpRawOutput(update.rawOutput) ?? extractAcpContentText(update.content);
    if (output) {
      events.push({
        kind: "tool_call_delta",
        itemId: state.itemId,
        output,
        detail: output.length <= 200 ? output : undefined
      });
    }

    events.push({
      kind: "tool_call_completed",
      itemId: state.itemId,
      title: state.title,
      status: status === "failed" ? "failed" : "completed",
      output
    });
    return events;
  }

  private ensureCommentaryStarted(): CodexEvent[] {
    if (this.commentaryStarted) {
      return [];
    }

    this.commentaryStarted = true;
    return [
      {
        kind: "assistant_message_started",
        itemId: this.commentaryItemId,
        source: "commentary"
      }
    ];
  }

  private ensureFinalStarted(): CodexEvent[] {
    if (this.finalStarted) {
      return [];
    }

    this.finalStarted = true;
    return [
      {
        kind: "assistant_message_started",
        itemId: this.finalItemId,
        source: "final_answer"
      }
    ];
  }
}

interface PendingRequest {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

class KimiAcpSession {
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private updateHandler?: (update: Record<string, unknown>) => void;
  private readonly readline: ReadlineInterface;
  private initialized = false;
  private closed = false;
  private activePrompt?: Promise<{ stopReason?: string }>;
  sessionId?: string;

  private readonly child: KimiAcpChild;

  constructor(
    private readonly handle: KimiAcpProcessHandle,
    private readonly workspaceId: string,
    private readonly logger?: LoggerLike
  ) {
    const child = handle.child;
    this.child = child;
    this.readline = createInterface({ input: child.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        this.logger?.warn(
          { workspaceId: this.workspaceId, stderr: truncateText(text, 500) },
          "Kimi ACP 进程 stderr"
        );
      }
    });
    child.once("close", (code, signal) => {
      this.closed = true;
      const error = new Error(`Kimi ACP 进程已退出 (code=${code ?? "null"}, signal=${signal ?? "null"})。`);
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  isAlive(): boolean {
    return !this.closed && !this.child.killed && this.child.exitCode === null;
  }

  async ready(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {}
    });
    this.initialized = true;
  }

  async ensureSession(threadId: string | undefined): Promise<string> {
    if (this.sessionId) {
      return this.sessionId;
    }

    if (threadId && !threadId.startsWith("pending:")) {
      try {
        await this.request("session/resume", {
          sessionId: threadId,
          cwd: this.workspaceId,
          mcpServers: []
        });
        this.sessionId = threadId;
        return threadId;
      } catch (error) {
        this.logger?.warn(
          {
            workspaceId: this.workspaceId,
            threadId,
            error: error instanceof Error ? error.message : String(error)
          },
          "Kimi ACP session/resume 失败，改为创建新会话"
        );
      }
    }

    const result = (await this.request("session/new", {
      cwd: this.workspaceId,
      mcpServers: []
    })) as Record<string, unknown>;
    const sessionId = result.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error("Kimi ACP session/new 没有返回 sessionId。");
    }

    this.sessionId = sessionId;
    return sessionId;
  }

  setUpdateHandler(handler: ((update: Record<string, unknown>) => void) | undefined): void {
    this.updateHandler = handler;
  }

  prompt(text: string): Promise<{ stopReason?: string }> {
    if (!this.sessionId) {
      return Promise.reject(new Error("Kimi ACP 会话还没有 sessionId。"));
    }

    const run = this.runPrompt(text);
    const tracked = run.finally(() => {
      if (this.activePrompt === tracked) {
        this.activePrompt = undefined;
      }
    });
    this.activePrompt = tracked;
    return tracked;
  }

  private async runPrompt(text: string): Promise<{ stopReason?: string }> {
    // ACP 同一 session 不允许并发 prompt，否则 agent 会返回
    // "another turn is already in progress"。这里串行化，保证上一个 turn 结束后再发。
    const previous = this.activePrompt;
    if (previous) {
      await previous.catch(() => undefined);
    }

    return (await this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [
        {
          type: "text",
          text
        }
      ]
    })) as { stopReason?: string };
  }

  hasActivePrompt(): boolean {
    return this.activePrompt !== undefined;
  }

  async waitForIdle(timeoutMs = 15_000): Promise<void> {
    const active = this.activePrompt;
    if (!active) {
      return;
    }

    await Promise.race([
      active.catch(() => undefined),
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs).unref();
      })
    ]);
  }

  cancel(): void {
    if (!this.sessionId || !this.isAlive()) {
      return;
    }

    this.notify("session/cancel", {
      sessionId: this.sessionId
    });
  }

  async stop(): Promise<void> {
    await this.handle.stop();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.isAlive()) {
      return Promise.reject(new Error("Kimi ACP 进程不可用。"));
    }

    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: Record<string, unknown>): void {
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.logger?.warn(
        {
          workspaceId: this.workspaceId,
          error: error instanceof Error ? error.message : String(error)
        },
        "Kimi ACP 写入请求失败"
      );
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.logger?.warn(
        { workspaceId: this.workspaceId, line: truncateText(trimmed, 300) },
        "Kimi ACP 输出了一行非 JSON 内容"
      );
      return;
    }

    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      if (isRecord(message.error)) {
        const errorMessage =
          typeof message.error.message === "string" ? message.error.message : JSON.stringify(message.error);
        pending.reject(new Error(errorMessage));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === "session/update") {
      const params = isRecord(message.params) ? message.params : undefined;
      const update = isRecord(params?.update) ? params.update : undefined;
      if (update) {
        this.updateHandler?.(update);
      }
      return;
    }

    if (typeof message.method === "string" && message.id !== undefined) {
      this.handleAgentRequest(message);
    }
  }

  private handleAgentRequest(message: Record<string, unknown>): void {
    const id = message.id;
    if (message.method === "session/request_permission") {
      const params = isRecord(message.params) ? message.params : undefined;
      const options = Array.isArray(params?.options) ? params.options : [];
      const preferred =
        options.find(
          (option) => isRecord(option) && option.kind === "allow_always"
        ) ??
        options.find((option) => isRecord(option) && option.kind === "allow_once") ??
        options.find((option) => isRecord(option));
      const optionId = isRecord(preferred) ? preferred.optionId : undefined;
      this.write({
        jsonrpc: "2.0",
        id,
        result: {
          outcome: {
            outcome: "selected",
            optionId: typeof optionId === "string" ? optionId : ""
          }
        }
      });
      return;
    }

    this.write({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `客户端不支持 ${message.method}`
      }
    });
  }
}

interface ActiveAcpTurn {
  session: KimiAcpSession;
  interrupted: boolean;
}

export interface KimiAcpQueuedRecoveryOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

type QueuedRecoveryResult = { text: string } | { errorMessage: string } | undefined;

export class KimiAcpWorker implements CodexWorker {
  private readonly sessionsByChatId = new Map<string, KimiAcpSession>();
  private readonly activeTurns = new Map<string, ActiveAcpTurn>();
  private readonly claimedTurnsBySession = new Map<string, Set<string>>();
  private readonly runtime: KimiAcpRuntime;
  private readonly recoveryPollIntervalMs: number;
  private readonly recoveryTimeoutMs: number;

  constructor(
    env: Pick<Env, "KIMI_ACP_COMMAND">,
    private readonly logger?: LoggerLike,
    runtime?: KimiAcpRuntime,
    recovery?: KimiAcpQueuedRecoveryOptions
  ) {
    this.runtime = runtime ?? new HostKimiAcpRuntime(env);
    this.recoveryPollIntervalMs = recovery?.pollIntervalMs ?? 5_000;
    this.recoveryTimeoutMs = recovery?.timeoutMs ?? 45 * 60_000;
  }

  supportsSteer(): boolean {
    return false;
  }

  async ensureThread(context: CodexTurnContext): Promise<string> {
    return context.session?.threadId ?? `pending:kimi-acp:${randomUUID()}`;
  }

  async interruptTurn(context: CodexInterruptContext): Promise<void> {
    const activeTurn = this.activeTurns.get(context.turnId);
    if (!activeTurn) {
      return;
    }

    activeTurn.interrupted = true;
    activeTurn.session.cancel();
    // 等 in-flight turn 真的结束，否则紧随其后的新 prompt 会被 ACP 拒绝为
    // "another turn is already in progress"。
    await activeTurn.session.waitForIdle();
  }

  async *runTurn(
    context: CodexTurnContext & { threadId: string }
  ): AsyncGenerator<CodexEvent> {
    const turnId = randomUUID();

    this.logger?.info(
      {
        cli: "kimi",
        mode: "acp",
        chatId: context.message.chatId,
        messageId: context.message.messageId,
        workspaceId: context.workspaceId,
        threadId: context.threadId
      },
      "开始执行 Kimi ACP turn"
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
    // 会话可能还有未结束的 turn（例如刚被 cancel 还在收尾），等它退出后再接管事件处理器并发新 prompt。
    await session.waitForIdle();
    const sessionId = await session.ensureSession(context.threadId);
    yield {
      kind: "thread_bound",
      threadId: sessionId
    };

    const eventQueue = new AsyncEventQueue<CodexEvent>();
    const projector = new KimiAcpTurnProjector(turnId);
    const activeTurn: ActiveAcpTurn = {
      session,
      interrupted: false
    };
    this.activeTurns.set(turnId, activeTurn);

    session.setUpdateHandler((update) => {
      for (const event of projector.ingestUpdate(update)) {
        eventQueue.push(event);
      }
    });

    const promptText = buildCliTurnInput(context);
    const sentAtMs = Date.now();
    void (async () => {
      try {
        const result = await session.prompt(promptText);
        const cancelled = activeTurn.interrupted || result.stopReason === "cancelled";
        if (!cancelled && !projector.hasVisibleActivity()) {
          // kimi-code 0.43+ 的 ACP 适配层在引擎被内部 turn（如后台任务完成通知）占用时，
          // 会把 prompt 排队并立刻以 end_turn 应答，事件也不再回流。此时从会话的
          // wire.jsonl 里等这个排队 turn 真正执行完，把它的可见答复补投到本次 run。
          this.logger?.warn(
            {
              chatId: context.message.chatId,
              messageId: context.message.messageId,
              workspaceId: context.workspaceId,
              threadId: sessionId,
              stopReason: result.stopReason ?? null
            },
            "Kimi ACP prompt 立即返回且没有任何事件，按引擎排队处理并等待补投"
          );
          for (const event of projector.announceQueued()) {
            eventQueue.push(event);
          }

          const recovered = await this.recoverQueuedTurn({
            session,
            sessionId,
            workspaceId: context.workspaceId,
            promptText,
            sentAtMs,
            interrupted: () => activeTurn.interrupted
          });
          if (recovered && "text" in recovered) {
            for (const event of projector.ingestRecoveredFinal(recovered.text)) {
              eventQueue.push(event);
            }
            for (const event of projector.finalize({})) {
              eventQueue.push(event);
            }
            return;
          }
          if (recovered && "errorMessage" in recovered) {
            for (const event of projector.finalize({ errorMessage: recovered.errorMessage })) {
              eventQueue.push(event);
            }
            return;
          }
          for (const event of projector.finalize({ cancelled: true })) {
            eventQueue.push(event);
          }
          return;
        }

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

  private async recoverQueuedTurn(input: {
    session: KimiAcpSession;
    sessionId: string;
    workspaceId: string;
    promptText: string;
    sentAtMs: number;
    interrupted: () => boolean;
  }): Promise<QueuedRecoveryResult> {
    const wirePath = await resolveKimiAcpWirePath(input.sessionId, input.workspaceId);
    let claimed = this.claimedTurnsBySession.get(input.sessionId);
    if (!claimed) {
      claimed = new Set<string>();
      this.claimedTurnsBySession.set(input.sessionId, claimed);
    }

    let processedChars = 0;
    let lastSize = -1;
    let turnId: string | undefined;
    const textParts: string[] = [];
    const deadline = Date.now() + this.recoveryTimeoutMs;

    while (Date.now() < deadline) {
      if (input.interrupted()) {
        return undefined;
      }
      if (!input.session.isAlive()) {
        return { errorMessage: "Kimi ACP 进程已退出，排队消息的答复未能补投。" };
      }

      let raw: string | undefined;
      try {
        const info = await stat(wirePath);
        if (info.size !== lastSize) {
          lastSize = info.size;
          raw = await readFile(wirePath, "utf8");
        }
      } catch {
        // wire 文件还没建出来，继续等。
      }

      if (raw !== undefined) {
        if (raw.length < processedChars) {
          // 文件被重建过，从头再扫一遍。
          processedChars = 0;
        }
        const fresh = raw.slice(processedChars);
        processedChars = raw.length;
        for (const line of fresh.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }

          let entry: Record<string, unknown>;
          try {
            entry = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (turnId === undefined) {
            if (
              entry.type !== "turn.prompt" ||
              typeof entry.time !== "number" ||
              entry.time < input.sentAtMs - 5_000
            ) {
              continue;
            }

            const candidateId = entry.turnId !== undefined ? String(entry.turnId) : undefined;
            const candidateText = Array.isArray(entry.input)
              ? entry.input
                  .map((part) =>
                    isRecord(part) && part.type === "text" && typeof part.text === "string"
                      ? part.text
                      : ""
                  )
                  .join("")
              : "";
            if (candidateId && candidateText === input.promptText && !claimed.has(candidateId)) {
              claimed.add(candidateId);
              turnId = candidateId;
            }
            continue;
          }

          if (entry.type === "context.append_loop_event" && isRecord(entry.event)) {
            const event = entry.event;
            if (
              event.type === "content.part" &&
              String(event.turnId) === turnId &&
              isRecord(event.part) &&
              event.part.type === "text" &&
              typeof event.part.text === "string" &&
              event.part.text.trim()
            ) {
              textParts.push(event.part.text.trim());
            }
            continue;
          }

          if (entry.type === "turn.ended" && String(entry.turnId) === turnId) {
            const text = textParts.join("\n").trim();
            return text
              ? { text }
              : { errorMessage: "Kimi ACP 排队消息已执行，但没有产生可见答复。" };
          }
        }
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.recoveryPollIntervalMs).unref();
      });
    }

    return {
      errorMessage: `Kimi ACP 排队消息等待结果超时（${Math.round(this.recoveryTimeoutMs / 60_000)} 分钟），请重新发送。`
    };
  }

  private async getOrCreateSession(
    context: CodexTurnContext & { threadId: string }
  ): Promise<KimiAcpSession> {
    const chatId = context.message.chatId;
    const desiredThreadId = context.threadId.startsWith("pending:") ? undefined : context.threadId;
    const existing = this.sessionsByChatId.get(chatId);

    if (existing?.isAlive()) {
      if (
        desiredThreadId &&
        existing.sessionId &&
        existing.sessionId !== desiredThreadId
      ) {
        this.logger?.info(
          {
            chatId,
            previousSessionId: existing.sessionId,
            nextThreadId: desiredThreadId
          },
          "Kimi ACP 会话线程已切换，重启 ACP 进程"
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
      args: ["acp"]
    });
    const { child } = handle;
    const session = new KimiAcpSession(handle, context.workspaceId, this.logger);
    this.sessionsByChatId.set(chatId, session);
    child.once("close", () => {
      if (this.sessionsByChatId.get(chatId) === session) {
        this.sessionsByChatId.delete(chatId);
      }
    });
    await session.ready();
    return session;
  }
}
