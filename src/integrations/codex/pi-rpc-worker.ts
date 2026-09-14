import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";

import type { Env } from "../../config/env.js";
import type { CodexEvent } from "../../domain/types.js";
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

export type PiRpcChild = ChildProcessByStdio<Writable, Readable, Readable>;

export interface PiRpcProcessHandle {
  child: PiRpcChild;
  stop(): Promise<void>;
}

export interface PiRpcRuntime {
  prepare?(context: CodexTurnContext): Promise<void>;
  spawnProcess(options: {
    context: CodexTurnContext;
    args: string[];
  }): PiRpcProcessHandle;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateText(value: string, maxLength = 200): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
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

interface PiResolvedSettings {
  provider?: string;
  model?: string;
  thinking?: string;
}

function resolvePiSettings(
  env: Pick<Env, "PI_CLI_PROVIDER" | "PI_CLI_MODEL" | "PI_CLI_THINKING">,
  context: CodexTurnContext
): PiResolvedSettings {
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
  const thinking = messageSelection.thinking ?? context.thinking ?? env.PI_CLI_THINKING;

  return { provider, model, thinking };
}

export function buildPiRpcArgs(
  env: Pick<Env, "PI_CLI_PROVIDER" | "PI_CLI_MODEL" | "PI_CLI_THINKING">,
  context: CodexTurnContext,
  sessionPath: string
): string[] {
  const settings = resolvePiSettings(env, context);
  const args = ["--mode", "rpc", "--session", sessionPath, "--approve"];

  if (settings.provider) {
    args.push("--provider", settings.provider);
  } else if (settings.model?.startsWith("deepseek")) {
    args.push("--provider", "openrouter");
  }

  if (settings.model) {
    args.push("--model", settings.model);
  }

  if (settings.thinking) {
    args.push("--thinking", settings.thinking);
  }

  return args;
}

function piSettingsKey(settings: PiResolvedSettings): string {
  return `${settings.provider ?? ""}|${settings.model ?? ""}|${settings.thinking ?? ""}`;
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

export class PiRpcTurnProjector {
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

  ingestEvent(entry: Record<string, unknown>): CodexEvent[] {
    return this.ingestLine(JSON.stringify(entry));
  }

  finalize(options: { cancelled?: boolean; errorMessage?: string }): CodexEvent[] {
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

    if (options.cancelled) {
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
            ? "Pi RPC 没有返回最终答复。"
            : "Pi RPC 没有返回可见内容。"
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

async function terminateChildProcess(child: PiRpcChild): Promise<void> {
  if (child.killed || child.exitCode !== null) {
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

class HostPiRpcRuntime implements PiRpcRuntime {
  constructor(private readonly env: Env) {}

  spawnProcess(options: {
    context: CodexTurnContext;
    args: string[];
  }): PiRpcProcessHandle {
    const child = spawn(this.env.PI_CLI_COMMAND, options.args, {
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

interface PendingRpcRequest {
  resolve(entry: Record<string, unknown>): void;
  reject(error: Error): void;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function createDeferred(): Deferred {
  let resolveFn: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  return {
    promise,
    resolve: resolveFn
  };
}

class PiRpcSession {
  private readonly pending = new Map<number, PendingRpcRequest>();
  private nextRequestId = 1;
  private readonly decoder = new StringDecoder("utf8");
  private lineBuffer = "";
  private closed = false;
  private onEvent?: (entry: Record<string, unknown>) => void;
  private settleDeferred?: Deferred;

  constructor(
    private readonly handle: PiRpcProcessHandle,
    readonly sessionPath: string,
    readonly settingsKey: string,
    private readonly logger?: LoggerLike
  ) {
    const { child } = handle;
    child.stdout.on("data", (chunk: Buffer) => {
      this.consumeChunk(chunk);
    });
    child.stdout.on("end", () => {
      this.flushBuffer();
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        this.logger?.warn(
          { sessionPath: this.sessionPath, stderr: truncateText(text, 500) },
          "Pi RPC 进程 stderr"
        );
      }
    });
    child.once("close", (code, signal) => {
      this.closed = true;
      const error = new Error(
        `Pi RPC 进程已退出 (code=${code ?? "null"}, signal=${signal ?? "null"})。`
      );
      for (const request of this.pending.values()) {
        request.reject(error);
      }
      this.pending.clear();
      this.settleDeferred?.resolve();
    });
  }

  isAlive(): boolean {
    return !this.closed && !this.handle.child.killed && this.handle.child.exitCode === null;
  }

  async ready(): Promise<void> {
    await this.request({ type: "get_state" });
  }

  async prompt(
    text: string,
    onEvent: (entry: Record<string, unknown>) => void
  ): Promise<{ stopReason?: string }> {
    if (!this.isAlive()) {
      throw new Error("Pi RPC 进程不可用。");
    }

    const settle = createDeferred();
    this.onEvent = onEvent;
    this.settleDeferred = settle;

    try {
      const response = await this.request({ type: "prompt", message: text });
      if (response.success === false) {
        throw new Error(
          typeof response.error === "string" ? response.error : "Pi RPC prompt 被拒绝。"
        );
      }

      await settle.promise;
      if (!this.isAlive()) {
        throw new Error("Pi RPC 进程在任务完成前退出。");
      }
      return {};
    } finally {
      this.onEvent = undefined;
      this.settleDeferred = undefined;
    }
  }

  async steer(text: string): Promise<void> {
    const response = await this.request({ type: "steer", message: text });
    if (response.success === false) {
      throw new Error(typeof response.error === "string" ? response.error : "Pi RPC steer 失败。");
    }
  }

  async abort(): Promise<void> {
    try {
      await this.request({ type: "abort" });
    } catch (error) {
      this.logger?.warn(
        {
          sessionPath: this.sessionPath,
          error: error instanceof Error ? error.message : String(error)
        },
        "Pi RPC abort 失败"
      );
    } finally {
      this.settleDeferred?.resolve();
    }
  }

  async stop(): Promise<void> {
    await this.handle.stop();
  }

  private request(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.isAlive()) {
      return Promise.reject(new Error("Pi RPC 进程不可用。"));
    }

    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ ...command, id });
    });
  }

  private write(message: Record<string, unknown>): void {
    try {
      this.handle.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.logger?.warn(
        {
          sessionPath: this.sessionPath,
          error: error instanceof Error ? error.message : String(error)
        },
        "Pi RPC 写入请求失败"
      );
    }
  }

  private consumeChunk(chunk: Buffer): void {
    this.lineBuffer += this.decoder.write(chunk);
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      let line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  private flushBuffer(): void {
    this.lineBuffer += this.decoder.end();
    if (!this.lineBuffer) {
      return;
    }

    let line = this.lineBuffer;
    this.lineBuffer = "";
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    this.handleLine(line);
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) {
        return;
      }
      entry = parsed;
    } catch {
      this.logger?.warn(
        { sessionPath: this.sessionPath, line: truncateText(line, 300) },
        "Pi RPC 输出了一行非 JSON 内容"
      );
      return;
    }

    const type = entry.type;
    if (type === "response") {
      const id = typeof entry.id === "number" ? entry.id : undefined;
      const request = id !== undefined ? this.pending.get(id) : undefined;
      if (request && id !== undefined) {
        this.pending.delete(id);
        request.resolve(entry);
      }
      return;
    }

    if (type === "extension_ui_request") {
      this.handleExtensionUiRequest(entry);
      return;
    }

    if (type === "agent_settled") {
      this.settleDeferred?.resolve();
      return;
    }

    this.onEvent?.(entry);
  }

  private handleExtensionUiRequest(entry: Record<string, unknown>): void {
    const id = entry.id;
    const method = entry.method;
    if (id === undefined) {
      return;
    }

    if (method === "confirm") {
      this.write({ type: "extension_ui_response", id, confirmed: true });
      return;
    }

    if (method === "select" || method === "input" || method === "editor") {
      this.logger?.warn(
        { sessionPath: this.sessionPath, method, title: entry.title },
        "Pi RPC 收到交互式 UI 请求，已自动取消"
      );
      this.write({ type: "extension_ui_response", id, cancelled: true });
      return;
    }

    // notify / setStatus / setWidget / setTitle / set_editor_text are fire-and-forget.
  }
}

interface ActivePiTurn {
  session: PiRpcSession;
  interrupted: boolean;
  interruptionMessage?: string;
}

interface PiSessionRecord {
  session: PiRpcSession;
  settingsKey: string;
  sessionPath: string;
}

export class PiRpcWorker implements CodexWorker {
  private readonly sessionsByChatId = new Map<string, PiSessionRecord>();
  private readonly activeTurns = new Map<string, ActivePiTurn>();
  private readonly runtime: PiRpcRuntime;

  constructor(
    private readonly env: Env,
    private readonly logger?: LoggerLike,
    runtime?: PiRpcRuntime
  ) {
    this.runtime = runtime ?? new HostPiRpcRuntime(env);
  }

  supportsSteer(): boolean {
    return true;
  }

  async ensureThread(context: CodexTurnContext): Promise<string> {
    const threadId = resolvePiThreadId(context);
    await mkdir(dirname(threadId), {
      recursive: true
    });
    return threadId;
  }

  async steerTurn(
    context: CodexTurnContext & { threadId: string; turnId: string }
  ): Promise<void> {
    const activeTurn = this.activeTurns.get(context.turnId);
    if (!activeTurn) {
      throw new Error("当前 Pi turn 不在运行中，无法 steer。");
    }

    await activeTurn.session.steer(buildPiSteerInput(context));
  }

  async interruptTurn(context: CodexInterruptContext): Promise<void> {
    const activeTurn = this.activeTurns.get(context.turnId);
    if (!activeTurn) {
      return;
    }

    activeTurn.interrupted = true;
    activeTurn.interruptionMessage = context.interruptionMessage ?? "当前任务已被中断。";
    await activeTurn.session.abort();
  }

  async *runTurn(
    context: CodexTurnContext & { threadId: string }
  ): AsyncGenerator<CodexEvent> {
    const turnId = randomUUID();
    const sessionPath = resolvePiThreadId(context);
    await mkdir(dirname(sessionPath), {
      recursive: true
    });
    await this.runtime.prepare?.(context);

    this.logger?.info(
      {
        cli: "pi",
        mode: "rpc",
        command: this.env.PI_CLI_COMMAND,
        chatId: context.message.chatId,
        messageId: context.message.messageId,
        workspaceId: context.workspaceId,
        sessionPath
      },
      "开始执行 Pi RPC turn"
    );

    yield {
      kind: "turn_bound",
      turnId
    };
    yield {
      kind: "run_status",
      status: "running"
    };

    const session = await this.getOrCreateSession(context, sessionPath);
    yield {
      kind: "thread_bound",
      threadId: sessionPath
    };

    const eventQueue = new AsyncEventQueue<CodexEvent>();
    const projector = new PiRpcTurnProjector(turnId);
    const activeTurn: ActivePiTurn = {
      session,
      interrupted: false
    };
    this.activeTurns.set(turnId, activeTurn);

    void session
      .prompt(buildCliTurnInput(context), (entry) => {
        for (const event of projector.ingestEvent(entry)) {
          eventQueue.push(event);
        }
      })
      .then(() => {
        for (const event of projector.finalize({
          cancelled: activeTurn.interrupted
        })) {
          eventQueue.push(event);
        }
      })
      .catch((error) => {
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
      })
      .finally(() => {
        eventQueue.close();
        this.activeTurns.delete(turnId);
      });

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
    await Promise.allSettled(sessions.map((record) => record.session.stop()));
  }

  private async getOrCreateSession(
    context: CodexTurnContext & { threadId: string },
    sessionPath: string
  ): Promise<PiRpcSession> {
    const chatId = context.message.chatId;
    const settingsKey = piSettingsKey(resolvePiSettings(this.env, context));
    const existing = this.sessionsByChatId.get(chatId);

    if (
      existing?.session.isAlive() &&
      existing.sessionPath === sessionPath &&
      existing.settingsKey === settingsKey
    ) {
      return existing.session;
    }

    if (existing) {
      this.sessionsByChatId.delete(chatId);
      this.logger?.info(
        {
          chatId,
          previousSessionPath: existing.sessionPath,
          nextSessionPath: sessionPath,
          previousSettingsKey: existing.settingsKey,
          nextSettingsKey: settingsKey
        },
        "Pi RPC 会话参数已变化，重启 RPC 进程"
      );
      await existing.session.stop();
    }

    const args = buildPiRpcArgs(this.env, context, sessionPath);
    const handle = this.runtime.spawnProcess({
      context,
      args
    });
    const session = new PiRpcSession(handle, sessionPath, settingsKey, this.logger);
    this.sessionsByChatId.set(chatId, {
      session,
      settingsKey,
      sessionPath
    });
    handle.child.once("close", () => {
      const current = this.sessionsByChatId.get(chatId);
      if (current?.session === session) {
        this.sessionsByChatId.delete(chatId);
      }
    });
    await session.ready();
    return session;
  }
}

function buildPiSteerInput(context: CodexTurnContext): string {
  return [
    "Additional user message received while the current turn is still active.",
    `- Feishu chat: ${context.message.chatId}`,
    `- New user message id: ${context.message.messageId}`,
    "- Treat this as the latest instruction and adjust the ongoing turn accordingly.",
    "",
    "Latest user message:",
    context.message.text
  ].join("\n");
}
