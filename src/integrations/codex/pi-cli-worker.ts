import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";

import type { CodexEvent } from "../../domain/types.js";
import type { Env } from "../../config/env.js";
import { AsyncEventQueue } from "./async-event-queue.js";
import { buildCliTurnInput } from "./cli-turn-input.js";
import type { CodexInterruptContext, CodexTurnContext, CodexWorker } from "./codex-worker.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

interface PiModelSelection {
  provider?: string;
  model?: string;
  thinking?: string;
}

export const PI_DS_FLASH_MODEL = "deepseek-flash";

export interface PiCliProcessHandle {
  child: ChildProcessByStdio<null, Readable, Readable>;
  stop(): Promise<void>;
}

export interface PiCliRuntime {
  prepare?(context: CodexTurnContext): Promise<void>;
  spawnProcess(options: {
    turnId: string;
    context: CodexTurnContext;
    args: string[];
  }): PiCliProcessHandle;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/[\s_\-]+/g, " ").toLowerCase();
}

function includesWord(text: string, word: string): boolean {
  return new RegExp(`(^|\\s)${word}(\\s|$)`).test(text);
}

export function selectPiModelFromMessage(text: string): PiModelSelection {
  const normalized = normalizeWhitespace(text);

  if (
    normalized.includes("glm 5 3 flash") ||
    normalized.includes("glm 5.3 flash") ||
    normalized.includes("glm 53 flash") ||
    normalized.includes("glm flash") ||
    normalized.includes("openmodel") ||
    normalized.includes("open model") ||
    includesWord(normalized, "glm")
  ) {
    return { provider: "openmodel", model: "glm-5.3-flash" };
  }

  if (
    normalized.includes("deepseek v4.1 flash") ||
    normalized.includes("ds4.1 flash") ||
    normalized.includes("v4.1 flash") ||
    normalized.includes("deepseek v4 flash") ||
    normalized.includes("ds4 flash") ||
    normalized.includes("v4 flash")
  ) {
    return { model: PI_DS_FLASH_MODEL };
  }

  if (
    normalized.includes("deepseek v4 pro") ||
    normalized.includes("ds4 pro") ||
    normalized.includes("v4 pro")
  ) {
    return { model: PI_DS_FLASH_MODEL };
  }

  if (
    normalized.includes("deepseek v4.1") ||
    normalized.includes("ds4.1") ||
    normalized.includes("deepseek v4") ||
    normalized.includes("deepseek") ||
    normalized.includes("ds4") ||
    includesWord(normalized, "ds")
  ) {
    return { model: PI_DS_FLASH_MODEL };
  }

  return {};
}

function canonicalizePiModel(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return selectPiModelFromMessage(value).model ?? value;
}

function sanitizePathSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").replace(/^-+|-+$/g, "") || "chat";
}

function resolvePiSessionBaseDir(workspaceId: string): string {
  const configured = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(workspaceId, configured);
  }

  return join(process.env.HOME ?? workspaceId, ".pi", "agent", "sessions", "codex-feishu-bot");
}

function createPiSessionPath(context: CodexTurnContext): string {
  return join(
    resolvePiSessionBaseDir(context.workspaceId),
    sanitizePathSegment(context.message.chatId),
    `${randomUUID()}.jsonl`
  );
}

function resolvePiThreadId(context: CodexTurnContext & { threadId?: string }): string {
  const threadId = context.session?.threadId ?? context.threadId;
  if (!threadId || threadId.startsWith("pending:")) {
    return createPiSessionPath(context);
  }

  if (threadId.includes("/") || threadId.includes("\\") || threadId.endsWith(".jsonl")) {
    return isAbsolute(threadId) ? threadId : resolve(context.workspaceId, threadId);
  }

  return join(
    resolvePiSessionBaseDir(context.workspaceId),
    sanitizePathSegment(context.message.chatId),
    `${sanitizePathSegment(threadId)}.jsonl`
  );
}

export function buildPiCliArgs(
  env: Pick<Env, "PI_CLI_PROVIDER" | "PI_CLI_MODEL" | "PI_CLI_THINKING">,
  context: CodexTurnContext,
  sessionPath: string
): string[] {
  const args = ["-p", "--mode", "json", "--session", sessionPath];
  const messageSelection = selectPiModelFromMessage(context.message.text);
  const explicitProvider = messageSelection.provider ?? context.provider;
  const model = canonicalizePiModel(
    messageSelection.model ?? context.model ?? env.PI_CLI_MODEL
  );
  // GLM 模型只存在于本机 pi 的 openmodel 自定义 provider 里；如果 provider 只是
  // 环境默认值（deepseek/openrouter），跨 provider 传 glm 模型会被上游 400 拒绝。
  const envProvider = env.PI_CLI_PROVIDER;
  const provider =
    explicitProvider ??
    (model?.startsWith("glm") && (envProvider === "deepseek" || envProvider === "openrouter")
      ? "openmodel"
      : envProvider);
  const thinking =
    messageSelection.thinking ?? context.thinking ?? env.PI_CLI_THINKING;

  if (provider) {
    args.push("--provider", provider);
  } else if (model?.startsWith("deepseek")) {
    args.push("--provider", "openrouter");
  }

  if (model) {
    args.push("--model", model);
  }

  if (thinking) {
    args.push("--thinking", thinking);
  }

  args.push(buildCliTurnInput(context));
  return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringifyValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractContentText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((item) => {
      if (!isRecord(item)) {
        return "";
      }

      if (item.type === "text" && typeof item.text === "string") {
        return item.text;
      }

      return "";
    })
    .join("");
}

function extractMessageText(message: unknown): string {
  if (!isRecord(message)) {
    return "";
  }

  return extractContentText(message.content);
}

function extractToolCommand(toolName: string, args: unknown): string | undefined {
  if (toolName === "bash" && isRecord(args) && typeof args.command === "string") {
    return args.command;
  }

  return stringifyValue(args);
}

function extractToolOutput(result: unknown): string | undefined {
  if (!isRecord(result)) {
    return stringifyValue(result);
  }

  const contentText = extractContentText(result.content);
  return contentText || stringifyValue(result);
}

interface PiToolState {
  itemId: string;
  name: string;
  output?: string;
}

class PiJsonTurnProjector {
  private readonly commentaryItemId: string;
  private readonly finalItemId: string;
  private commentaryStarted = false;
  private finalStarted = false;
  private commentaryText = "";
  private finalText = "";
  private toolSequence = 0;
  private readonly toolStateByCallId = new Map<string, PiToolState>();
  private rawText = "";

  constructor(private readonly turnId: string) {
    this.commentaryItemId = `assistant:${turnId}:commentary`;
    this.finalItemId = `assistant:${turnId}:final`;
  }

  ingestLine(line: string): CodexEvent[] {
    const entry = parseJsonLine(line);
    if (!entry) {
      if (line.trim()) {
        this.rawText += `${line}\n`;
      }
      return [];
    }

    const type = typeof entry.type === "string" ? entry.type : undefined;
    switch (type) {
      case "message_update":
        return this.ingestAssistantMessageEvent(entry.assistantMessageEvent);
      case "tool_execution_start":
        return this.ingestToolExecutionStart(entry);
      case "tool_execution_update":
        return this.ingestToolExecutionUpdate(entry);
      case "tool_execution_end":
        return this.ingestToolExecutionEnd(entry);
      case "message_end":
        return this.ingestMessageEnd(entry.message);
      default:
        return [];
    }
  }

  finalize(options: { errorMessage?: string }): CodexEvent[] {
    const events: CodexEvent[] = [];

    if (this.commentaryStarted) {
      events.push({
        kind: "assistant_message_completed",
        itemId: this.commentaryItemId,
        text: this.commentaryText.trim()
      });
    }

    if (this.finalStarted) {
      events.push({
        kind: "assistant_message_completed",
        itemId: this.finalItemId,
        text: this.finalText.trim()
      });
    }

    if (options.errorMessage) {
      events.push({
        kind: "error",
        message: options.errorMessage
      });
      return events;
    }

    if (!this.finalStarted) {
      const fallback = this.rawText.trim();
      if (fallback) {
        events.push(...this.ensureFinalStarted());
        events.push({
          kind: "assistant_message_completed",
          itemId: this.finalItemId,
          text: fallback
        });
      } else {
        events.push({
          kind: "error",
          message: this.commentaryStarted
            ? "Pi CLI 没有返回最终答复。"
            : "Pi CLI 没有返回可见内容。"
        });
      }
    }

    return events;
  }

  private ingestAssistantMessageEvent(value: unknown): CodexEvent[] {
    if (!isRecord(value) || typeof value.type !== "string") {
      return [];
    }

    if (value.type === "thinking_delta" && typeof value.delta === "string" && value.delta) {
      const events = this.ensureCommentaryStarted();
      this.commentaryText += value.delta;
      events.push({
        kind: "assistant_message_delta",
        itemId: this.commentaryItemId,
        text: value.delta
      });
      return events;
    }

    if (
      value.type === "thinking_end" &&
      typeof value.content === "string" &&
      !this.commentaryText
    ) {
      this.commentaryText = value.content;
      return [];
    }

    if (value.type === "text_delta" && typeof value.delta === "string" && value.delta) {
      const events = this.ensureFinalStarted();
      this.finalText += value.delta;
      events.push({
        kind: "assistant_message_delta",
        itemId: this.finalItemId,
        text: value.delta
      });
      return events;
    }

    if (value.type === "text_end" && typeof value.content === "string") {
      if (!this.finalStarted && value.content) {
        const events = this.ensureFinalStarted();
        this.finalText = value.content;
        events.push({
          kind: "assistant_message_delta",
          itemId: this.finalItemId,
          text: value.content
        });
        return events;
      }
    }

    return [];
  }

  private ingestToolExecutionStart(entry: Record<string, unknown>): CodexEvent[] {
    const callId =
      typeof entry.toolCallId === "string" ? entry.toolCallId : `anonymous:${++this.toolSequence}`;
    const toolName =
      typeof entry.toolName === "string" && entry.toolName.trim()
        ? entry.toolName.trim()
        : "tool";
    const itemId = `tool:${this.turnId}:${++this.toolSequence}`;
    const command = extractToolCommand(toolName, entry.args);

    this.toolStateByCallId.set(callId, {
      itemId,
      name: toolName
    });

    return [
      {
        kind: "tool_call_started",
        itemId,
        title: `调用 ${toolName}`,
        command
      }
    ];
  }

  private ingestToolExecutionUpdate(entry: Record<string, unknown>): CodexEvent[] {
    const state = this.resolveToolState(entry);
    const output = extractToolOutput(isRecord(entry.partialResult) ? entry.partialResult : undefined);
    if (!output || output === state.output) {
      return [];
    }

    state.output = output;
    return [
      {
        kind: "tool_call_delta",
        itemId: state.itemId,
        output,
        detail: output.length <= 200 ? output : undefined
      }
    ];
  }

  private ingestToolExecutionEnd(entry: Record<string, unknown>): CodexEvent[] {
    const state = this.resolveToolState(entry);
    const output = extractToolOutput(entry.result) ?? state.output;
    const isError = entry.isError === true;

    return [
      {
        kind: "tool_call_completed",
        itemId: state.itemId,
        title: `调用 ${state.name}`,
        status: isError ? "failed" : "completed",
        output
      }
    ];
  }

  private ingestMessageEnd(message: unknown): CodexEvent[] {
    if (!isRecord(message) || message.role !== "assistant" || this.finalStarted) {
      return [];
    }

    const text = extractMessageText(message);
    if (!text) {
      return [];
    }

    const events = this.ensureFinalStarted();
    this.finalText = text;
    events.push({
      kind: "assistant_message_delta",
      itemId: this.finalItemId,
      text
    });
    return events;
  }

  private resolveToolState(entry: Record<string, unknown>): PiToolState {
    const callId = typeof entry.toolCallId === "string" ? entry.toolCallId : undefined;
    const existing = callId ? this.toolStateByCallId.get(callId) : undefined;
    if (existing) {
      return existing;
    }

    const toolName =
      typeof entry.toolName === "string" && entry.toolName.trim()
        ? entry.toolName.trim()
        : "tool";
    const itemId = `tool:${this.turnId}:${++this.toolSequence}`;
    const state = {
      itemId,
      name: toolName
    };
    if (callId) {
      this.toolStateByCallId.set(callId, state);
    }
    return state;
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

async function terminateChildProcess(
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

class HostPiCliRuntime implements PiCliRuntime {
  constructor(private readonly env: Env) {}

  spawnProcess(options: {
    turnId: string;
    context: CodexTurnContext;
    args: string[];
  }): PiCliProcessHandle {
    const child = spawn(this.env.PI_CLI_COMMAND, options.args, {
      cwd: options.context.workspaceId,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    return {
      child,
      async stop() {
        await terminateChildProcess(child);
      }
    };
  }
}

export class PiCliWorker implements CodexWorker {
  private readonly activeTurns = new Map<
    string,
    {
      handle: PiCliProcessHandle;
      interrupted: boolean;
      interruptionMessage?: string;
    }
  >();

  constructor(
    private readonly env: Env,
    private readonly logger?: LoggerLike,
    private readonly runtime: PiCliRuntime = new HostPiCliRuntime(env)
  ) {}

  supportsSteer(): boolean {
    return false;
  }

  async ensureThread(context: CodexTurnContext): Promise<string> {
    const threadId = resolvePiThreadId(context);
    await mkdir(dirname(threadId), {
      recursive: true
    });
    return threadId;
  }

  async interruptTurn(context: CodexInterruptContext): Promise<void> {
    const activeTurn = this.activeTurns.get(context.turnId);
    if (!activeTurn) {
      return;
    }

    activeTurn.interrupted = true;
    activeTurn.interruptionMessage = context.interruptionMessage ?? "当前任务已被中断。";
    await activeTurn.handle.stop();
  }

  async *runTurn(
    context: CodexTurnContext & { threadId: string }
  ): AsyncGenerator<CodexEvent> {
    const turnId = randomUUID();
    const threadId = resolvePiThreadId(context);
    await mkdir(dirname(threadId), {
      recursive: true
    });
    await this.runtime.prepare?.(context);
    const args = buildPiCliArgs(this.env, context, threadId);

    this.logger?.info(
      {
        cli: "pi",
        command: this.env.PI_CLI_COMMAND,
        args,
        chatId: context.message.chatId,
        messageId: context.message.messageId,
        workspaceId: context.workspaceId,
        threadId
      },
      "开始执行 Pi CLI turn"
    );

    yield {
      kind: "thread_bound",
      threadId
    };
    yield {
      kind: "turn_bound",
      turnId
    };
    yield {
      kind: "run_status",
      status: "running"
    };

    let activeTurn:
      | {
          handle: PiCliProcessHandle;
          interrupted: boolean;
          interruptionMessage?: string;
        }
      | undefined;
    const eventQueue = new AsyncEventQueue<CodexEvent>();
    const projector = new PiJsonTurnProjector(turnId);
    let stderr = "";
    let lineBuffer = "";
    let settled = false;
    let handle: PiCliProcessHandle | undefined;

    const pushProjectorEvents = (events: CodexEvent[]) => {
      for (const event of events) {
        eventQueue.push(event);
      }
    };
    const flushLineBuffer = () => {
      if (!lineBuffer.trim()) {
        lineBuffer = "";
        return;
      }

      pushProjectorEvents(projector.ingestLine(lineBuffer));
      lineBuffer = "";
    };
    const finish = (exitCode: number, errorMessage?: string) => {
      if (settled) {
        return;
      }

      settled = true;
      flushLineBuffer();
      this.activeTurns.delete(turnId);

      const finalErrorMessage =
        errorMessage ??
        (activeTurn?.interrupted
          ? activeTurn.interruptionMessage ?? "当前任务已被中断。"
          : exitCode !== 0
            ? stderr.trim() || "Pi CLI 执行失败。"
            : undefined);
      pushProjectorEvents(projector.finalize({ errorMessage: finalErrorMessage }));
      eventQueue.close();
    };

    try {
      handle = this.runtime.spawnProcess({
        turnId,
        context,
        args
      });
      const { child } = handle;
      const activeTurnRecord = {
        handle,
        interrupted: false,
        interruptionMessage: undefined
      };
      activeTurn = activeTurnRecord;
      this.activeTurns.set(turnId, activeTurnRecord);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        lineBuffer += chunk;
        let newlineIndex = lineBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = lineBuffer.slice(0, newlineIndex);
          lineBuffer = lineBuffer.slice(newlineIndex + 1);
          pushProjectorEvents(projector.ingestLine(line));
          newlineIndex = lineBuffer.indexOf("\n");
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        finish(1, error instanceof Error ? error.message : String(error));
      });
      child.on("close", (exitCode) => {
        finish(exitCode ?? 1);
      });
    } catch (error) {
      finish(1, error instanceof Error ? error.message : String(error));
    }

    try {
      yield* eventQueue.iterate();
    } finally {
      if (!settled) {
        await handle?.stop();
        finish(1, "Pi CLI 执行被取消。");
      }
    }
  }
}
