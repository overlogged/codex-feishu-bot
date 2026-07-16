import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import type { Env } from "../../config/env.js";
import type { CodexEvent } from "../../domain/types.js";
import { buildCliTurnInput } from "./cli-turn-input.js";
import type { CodexInterruptContext, CodexTurnContext, CodexWorker } from "./codex-worker.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

export interface KimiCliProcessHandle {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  stop(): Promise<void>;
}

export interface KimiCliRuntime {
  prepare?(context: CodexTurnContext): Promise<void>;
  spawnProcess(options: {
    turnId: string;
    context: CodexTurnContext;
    args: string[];
  }): KimiCliProcessHandle;
}

interface ParsedKimiToolCall {
  name: string;
  arguments?: Record<string, unknown> | string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

type JsonRpcResponse =
  | {
      kind: "success";
      id: string;
      result: unknown;
    }
  | {
      kind: "error";
      id: string;
      error: JsonRpcErrorObject;
    };

interface JsonRpcWireEvent {
  kind: "event";
  eventType: string;
  payload: Record<string, unknown>;
}

interface JsonRpcWireRequest {
  kind: "request";
  id: string;
  requestType: string;
  payload: Record<string, unknown>;
}

type ParsedJsonRpcLine = JsonRpcResponse | JsonRpcWireEvent | JsonRpcWireRequest;

interface ToolCallState {
  itemId: string;
  name: string;
  argumentsBuffer: string;
  emittedCommand?: string;
}

interface ActiveKimiTurn {
  turnId: string;
  eventQueue: AsyncEventQueue<CodexEvent>;
  projector: KimiWireTurnProjector;
  interrupted: boolean;
  interruptionMessage?: string;
  bumpActivity(): void;
  stopActivityWatch(): void;
}

const KIMI_WIRE_PROTOCOL_VERSION = "1.8";
const KIMI_WIRE_IDLE_TTL_MS = 5 * 60_000;
const KIMI_WIRE_INITIALIZE_TIMEOUT_MS = 10_000;
const KIMI_WIRE_TURN_IDLE_TIMEOUT_MS = 0;
const KIMI_WIRE_INTERRUPT_TIMEOUT_MS = 5_000;

export interface KimiCliTimingOptions {
  initializeTimeoutMs?: number;
  turnIdleTimeoutMs?: number;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return {
    promise,
    resolve,
    reject
  };
}

class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) {
      return;
    }

    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({
        done: false,
        value
      });
      return;
    }

    this.values.push(value);
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const resolver of this.resolvers.splice(0)) {
      resolver({
        done: true,
        value: undefined as T
      });
    }
  }

  async shift(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) {
      return {
        done: false,
        value: this.values.shift() as T
      };
    }

    if (this.closed) {
      return {
        done: true,
        value: undefined as T
      };
    }

    return new Promise<IteratorResult<T>>((resolve) => {
      this.resolvers.push(resolve);
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(timeoutMessage));
        }, timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function createResettableTimeout(timeoutMs: number, timeoutMessage: string): {
  promise: Promise<never>;
  bump(): void;
  stop(): void;
} {
  const deferred = createDeferred<never>();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const schedule = () => {
    if (stopped) {
      return;
    }

    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      if (stopped) {
        return;
      }
      stopped = true;
      deferred.reject(new Error(timeoutMessage));
    }, timeoutMs);
    timer.unref();
  };

  schedule();

  return {
    promise: deferred.promise,
    bump() {
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    }
  };
}

function appendTail(current: string, chunk: string, limit = 64_000): string {
  const next = `${current}${chunk}`;
  return next.length <= limit ? next : next.slice(-limit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value.trim() || undefined;
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function parseToolArguments(value: unknown): Record<string, unknown> | string | undefined {
  if (typeof value !== "string") {
    return isRecord(value) ? value : undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : trimmed;
  } catch {
    return trimmed;
  }
}

function buildToolTitle(toolCall: ParsedKimiToolCall): string {
  if (/^(shell|bash|terminal|command)$/i.test(toolCall.name)) {
    return "执行命令";
  }

  return `调用 ${toolCall.name}`;
}

function extractToolCommand(
  args: Record<string, unknown> | string | undefined
): string | undefined {
  if (typeof args === "string") {
    return args.trim() || undefined;
  }

  if (!args) {
    return undefined;
  }

  for (const key of ["command", "cmd", "shell_command"] as const) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function extractToolResultOutput(returnValue: unknown): string | undefined {
  if (typeof returnValue === "string") {
    return returnValue.trim() || undefined;
  }

  if (!isRecord(returnValue)) {
    return undefined;
  }

  const output = normalizeText(returnValue.output);
  if (output) {
    return output;
  }

  return normalizeText(returnValue.message);
}

function parseJsonRpcLine(line: string): ParsedJsonRpcLine | undefined {
  const parsed = parseJsonLine(line);
  if (!parsed) {
    return undefined;
  }

  const id = typeof parsed.id === "string" ? parsed.id : undefined;
  if (id && "error" in parsed && isRecord(parsed.error) && typeof parsed.error.message === "string") {
    return {
      kind: "error",
      id,
      error: {
        code: typeof parsed.error.code === "number" ? parsed.error.code : -32603,
        message: parsed.error.message,
        data: parsed.error.data
      }
    };
  }

  if (id && "result" in parsed) {
    return {
      kind: "success",
      id,
      result: parsed.result
    };
  }

  const method = parsed.method;
  if (method !== "event" && method !== "request") {
    return undefined;
  }

  const params = isRecord(parsed.params) ? parsed.params : undefined;
  const wireType = typeof params?.type === "string" ? params.type : undefined;
  const payload = isRecord(params?.payload) ? params.payload : {};
  if (!wireType) {
    return undefined;
  }

  if (method === "event") {
    return {
      kind: "event",
      eventType: wireType,
      payload
    };
  }

  if (!id) {
    return undefined;
  }

  return {
    kind: "request",
    id,
    requestType: wireType,
    payload
  };
}

function parsePromptResultError(result: unknown): string | undefined {
  if (!isRecord(result) || typeof result.status !== "string") {
    return undefined;
  }

  if (result.status === "finished") {
    return undefined;
  }

  if (result.status === "cancelled") {
    return "当前任务已被中断。";
  }

  if (result.status === "max_steps_reached") {
    return "Kimi 达到了单轮最大步骤限制。";
  }

  return `Kimi turn 以异常状态结束：${result.status}`;
}

export function normalizeKimiErrorMessage(message: string | undefined): string | undefined {
  const trimmed = message?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/error code:\s*402/i.test(trimmed) && /membership benefits/i.test(trimmed)) {
    return [
      "Kimi CLI 上游返回 402：当前账号的会员权益校验未通过。",
      "这个群当前走的是 Kimi CLI。请重新登录或续费 Kimi Code，或者把群绑定切到 codex 后重试。"
    ].join("\n");
  }

  return trimmed;
}

function resolveKimiStateDir(): string {
  const home = process.env.HOME ?? "/home/overlogged";
  return join(home, ".kimi");
}

function resolveKimiSessionsDir(workspaceId: string): string {
  const workspaceHash = createHash("md5").update(workspaceId).digest("hex");
  return join(resolveKimiStateDir(), "sessions", workspaceHash);
}

async function listKimiSessionIds(workspaceId: string): Promise<Set<string>> {
  try {
    const entries = await readdir(resolveKimiSessionsDir(workspaceId), {
      withFileTypes: true
    });
    return new Set(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    );
  } catch {
    return new Set<string>();
  }
}

async function readKimiLastSessionId(workspaceId: string): Promise<string | undefined> {
  try {
    const metadataPath = join(resolveKimiStateDir(), "kimi.json");
    const raw = await readFile(metadataPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.work_dirs)) {
      return undefined;
    }

    for (const item of parsed.work_dirs) {
      if (!isRecord(item) || item.path !== workspaceId) {
        continue;
      }

      return typeof item.last_session_id === "string" ? item.last_session_id : undefined;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

async function discoverNewKimiSessionId(
  workspaceId: string,
  knownSessionIds: Set<string>,
  timeoutMs = 2_000
): Promise<string | undefined> {
  const sessionsDir = resolveKimiSessionsDir(workspaceId);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  for (;;) {
    try {
      const entries = await readdir(sessionsDir, {
        withFileTypes: true
      });
      const created = entries
        .filter((entry) => entry.isDirectory() && !knownSessionIds.has(entry.name))
        .map((entry) => entry.name);

      if (created.length === 1) {
        return created[0];
      }

      if (created.length > 1) {
        const ranked = await Promise.all(
          created.map(async (sessionId) => {
            const info = await stat(join(sessionsDir, sessionId));
            return {
              sessionId,
              mtimeMs: info.mtimeMs
            };
          })
        );
        ranked.sort((left, right) => right.mtimeMs - left.mtimeMs);
        return ranked[0]?.sessionId;
      }
    } catch {
      // Ignore and keep polling until timeout.
    }

    if (Date.now() >= deadline) {
      break;
    }

    await sleep(100);
  }

  const lastSessionId = await readKimiLastSessionId(workspaceId);
  if (lastSessionId && !knownSessionIds.has(lastSessionId)) {
    return lastSessionId;
  }

  return undefined;
}

async function hasUnfinishedKimiTurn(
  workspaceId: string,
  threadId: string
): Promise<boolean> {
  try {
    const wirePath = join(resolveKimiSessionsDir(workspaceId), threadId, "wire.jsonl");
    const raw = await readFile(wirePath, "utf8");
    let lastBoundary: "begin" | "end" | undefined;

    for (const line of raw.split(/\r?\n/)) {
      const entry = parseJsonLine(line);
      const message = isRecord(entry?.message) ? entry.message : undefined;
      const type = typeof message?.type === "string" ? message.type : undefined;
      if (type === "TurnBegin") {
        lastBoundary = "begin";
      } else if (type === "TurnEnd") {
        lastBoundary = "end";
      }
    }

    return lastBoundary === "begin";
  } catch {
    return false;
  }
}

export class KimiWireTurnProjector {
  private readonly commentaryItemId: string;
  private readonly finalItemId: string;
  private commentaryStarted = false;
  private finalStarted = false;
  private commentaryText = "";
  private finalText = "";
  private toolSequence = 0;
  private lastToolCallId?: string;
  private readonly toolStateByCallId = new Map<string, ToolCallState>();

  constructor(private readonly turnId: string) {
    this.commentaryItemId = `assistant:${turnId}:commentary`;
    this.finalItemId = `assistant:${turnId}:final`;
  }

  ingestEvent(event: {
    type: string;
    payload: Record<string, unknown>;
  }): CodexEvent[] {
    switch (event.type) {
      case "ContentPart":
        return this.ingestContentPart(event.payload);
      case "ToolCall":
        return this.ingestToolCall(event.payload);
      case "ToolCallPart":
        return this.ingestToolCallPart(event.payload);
      case "ToolResult":
        return this.ingestToolResult(event.payload);
      case "SubagentEvent":
        return this.ingestSubagentEvent(event.payload);
      default:
        return [];
    }
  }

  finalize(options: {
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

    if (!this.finalStarted) {
      events.push({
        kind: "error",
        message: this.commentaryStarted
          ? "Kimi CLI 没有返回最终答复。"
          : "Kimi CLI 没有返回可见内容。"
      });
    }

    return events;
  }

  private ingestContentPart(payload: Record<string, unknown>): CodexEvent[] {
    if (payload.type === "think" && typeof payload.think === "string" && payload.think) {
      const events = this.ensureCommentaryStarted();
      this.commentaryText += payload.think;
      events.push({
        kind: "assistant_message_delta",
        itemId: this.commentaryItemId,
        text: payload.think
      });
      return events;
    }

    if (payload.type === "text" && typeof payload.text === "string" && payload.text) {
      const events = this.ensureFinalStarted();
      this.finalText += payload.text;
      events.push({
        kind: "assistant_message_delta",
        itemId: this.finalItemId,
        text: payload.text
      });
      return events;
    }

    return [];
  }

  private ingestToolCall(payload: Record<string, unknown>): CodexEvent[] {
    const callId = typeof payload.id === "string" ? payload.id : `anonymous:${++this.toolSequence}`;
    const functionPayload = isRecord(payload.function) ? payload.function : undefined;
    const name =
      typeof functionPayload?.name === "string" && functionPayload.name.trim()
        ? functionPayload.name.trim()
        : "工具调用";
    const argumentsBuffer =
      typeof functionPayload?.arguments === "string" ? functionPayload.arguments : "";
    const parsedArguments = parseToolArguments(argumentsBuffer);
    const itemId = `tool:${this.turnId}:${++this.toolSequence}`;
    const command = extractToolCommand(parsedArguments);

    this.lastToolCallId = callId;
    this.toolStateByCallId.set(callId, {
      itemId,
      name,
      argumentsBuffer,
      emittedCommand: command
    });

    return [
      {
        kind: "tool_call_started",
        itemId,
        title: buildToolTitle({
          name,
          arguments: parsedArguments
        }),
        command
      }
    ];
  }

  private ingestToolCallPart(payload: Record<string, unknown>): CodexEvent[] {
    if (!this.lastToolCallId) {
      return [];
    }

    const state = this.toolStateByCallId.get(this.lastToolCallId);
    if (!state || typeof payload.arguments_part !== "string" || !payload.arguments_part) {
      return [];
    }

    state.argumentsBuffer += payload.arguments_part;
    const command = extractToolCommand(parseToolArguments(state.argumentsBuffer));
    if (!command || command === state.emittedCommand) {
      return [];
    }

    state.emittedCommand = command;
    return [
      {
        kind: "tool_call_delta",
        itemId: state.itemId,
        detail: `执行: ${command}`
      }
    ];
  }

  private ingestToolResult(payload: Record<string, unknown>): CodexEvent[] {
    const callId = typeof payload.tool_call_id === "string" ? payload.tool_call_id : undefined;
    const state = callId ? this.toolStateByCallId.get(callId) : undefined;
    const itemId = state?.itemId ?? `tool:${this.turnId}:${++this.toolSequence}`;
    const returnValue = payload.return_value;
    const output = extractToolResultOutput(returnValue);
    const isError = isRecord(returnValue) && returnValue.is_error === true;
    const events: CodexEvent[] = [];

    if (!state) {
      events.push({
        kind: "tool_call_started",
        itemId,
        title: "工具调用"
      });
    }

    if (output) {
      events.push({
        kind: "tool_call_delta",
        itemId,
        output,
        detail: output.length <= 200 ? output : undefined
      });
    }

    events.push({
      kind: "tool_call_completed",
      itemId,
      title: state ? `调用 ${state.name}` : undefined,
      status: isError ? "failed" : "completed",
      output
    });
    return events;
  }

  private ingestSubagentEvent(payload: Record<string, unknown>): CodexEvent[] {
    const nested = isRecord(payload.event) ? payload.event : undefined;
    const eventType = typeof nested?.type === "string" ? nested.type : undefined;
    const eventPayload = isRecord(nested?.payload) ? nested.payload : undefined;
    if (!eventType || !eventPayload) {
      return [];
    }

    return this.ingestEvent({
      type: eventType,
      payload: eventPayload
    });
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

class HostKimiCliRuntime implements KimiCliRuntime {
  constructor(private readonly env: Env) {}

  spawnProcess(options: {
    turnId: string;
    context: CodexTurnContext;
    args: string[];
  }): KimiCliProcessHandle {
    const child = spawn(this.env.KIMI_CLI_COMMAND, options.args, {
      cwd: options.context.workspaceId,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    return {
      child,
      async stop() {
        await terminateChildProcess(child);
      }
    };
  }
}

class KimiWireSession {
  readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  readonly workspaceId: string;

  private readonly pendingResponses = new Map<string, Deferred<JsonRpcResponse>>();
  private readonly initializationPromise: Promise<void>;
  private readonly sessionIdDiscoveryPromise: Promise<void>;
  private activeTurn?: ActiveKimiTurn;
  private activeTurnSettled?: Deferred<void>;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private stderr = "";
  private stopPromise?: Promise<void>;
  private idleTimer?: NodeJS.Timeout;

  constructor(
    private readonly handle: KimiCliProcessHandle,
    workspaceId: string,
    readonly initialThreadKey: string,
    private threadIdValue: string | undefined,
    knownSessionIds: Set<string> | undefined,
    private readonly timings: Required<KimiCliTimingOptions>,
    private readonly logger: LoggerLike | undefined,
    private readonly callbacks: {
      onThreadId(threadId: string): void;
      onClosed(): void;
    }
  ) {
    this.child = handle.child;
    this.workspaceId = workspaceId;
    this.attachListeners();
    this.initializationPromise = this.initialize();
    this.sessionIdDiscoveryPromise = this.threadIdValue
      ? Promise.resolve()
      : discoverNewKimiSessionId(workspaceId, knownSessionIds ?? new Set<string>())
          .then((threadId) => {
            if (threadId) {
              this.setThreadId(threadId);
            }
          })
          .catch((error) => {
            this.logger?.warn(
              {
                workspaceId,
                error: error instanceof Error ? error.message : String(error)
              },
              "Kimi Wire 新会话 ID 发现失败"
            );
          });
  }

  get threadId(): string | undefined {
    return this.threadIdValue;
  }

  async ready(): Promise<void> {
    await this.initializationPromise;
  }

  async awaitThreadId(): Promise<string | undefined> {
    await this.sessionIdDiscoveryPromise;
    return this.threadIdValue;
  }

  async runPrompt(
    prompt: string,
    turnId: string,
    eventQueue: AsyncEventQueue<CodexEvent>
  ): Promise<void> {
    if (this.activeTurn) {
      throw new Error("Kimi 会话当前已有任务在运行。");
    }

    this.clearIdleTimer();
    await this.ready();

    const activityWatch =
      this.timings.turnIdleTimeoutMs > 0
        ? createResettableTimeout(
            this.timings.turnIdleTimeoutMs,
            "Kimi Wire 长时间没有输出，已终止当前任务。"
          )
        : undefined;

    const activeTurn: ActiveKimiTurn = {
      turnId,
      eventQueue,
      projector: new KimiWireTurnProjector(turnId),
      interrupted: false,
      bumpActivity: () => {
        activityWatch?.bump();
      },
      stopActivityWatch: () => {
        activityWatch?.stop();
      }
    };
    this.activeTurn = activeTurn;
    const activeTurnSettled = createDeferred<void>();
    this.activeTurnSettled = activeTurnSettled;

    try {
      const response = activityWatch
        ? await Promise.race([
            this.sendRequest("prompt", {
              user_input: prompt
            }),
            activityWatch.promise
          ])
        : await this.sendRequest("prompt", {
            user_input: prompt
          });
      const errorMessage = activeTurn.interrupted
        ? activeTurn.interruptionMessage ?? "当前任务已被中断。"
        : response.kind === "error"
          ? normalizeKimiErrorMessage(response.error.message)
          : parsePromptResultError(response.result);

      for (const event of activeTurn.projector.finalize({
        errorMessage
      })) {
        eventQueue.push(event);
      }
    } catch (error) {
      const fallback = this.stderr.trim() || "Kimi Wire 会话执行失败。";
      await this.stop();
      const rawErrorMessage = error instanceof Error ? error.message || fallback : fallback;
      for (const event of activeTurn.projector.finalize({
        errorMessage: normalizeKimiErrorMessage(rawErrorMessage)
      })) {
        eventQueue.push(event);
      }
    } finally {
      activeTurn.stopActivityWatch();
      if (this.activeTurn === activeTurn) {
        this.activeTurn = undefined;
      }
      if (this.activeTurnSettled === activeTurnSettled) {
        this.activeTurnSettled = undefined;
      }
      activeTurnSettled.resolve();
      this.scheduleIdleStop();
      await this.awaitThreadId();
      eventQueue.close();
    }
  }

  async interruptActiveTurn(message: string): Promise<void> {
    const activeTurn = this.activeTurn;
    if (!activeTurn) {
      return;
    }
    const settledPromise = this.activeTurnSettled?.promise;

    activeTurn.interrupted = true;
    activeTurn.interruptionMessage = message;

    try {
      const response = await this.sendRequest("cancel", {});
      if (response.kind === "error" && response.error.code !== -32000) {
        throw new Error(response.error.message);
      }
    } catch (error) {
      this.logger?.warn(
        {
          threadId: this.threadIdValue ?? this.initialThreadKey,
          error: error instanceof Error ? error.message : String(error)
        },
        "Kimi Wire cancel 失败，转为直接关闭进程"
      );
      await this.stop();
    }

    if (!settledPromise) {
      return;
    }

    try {
      await withTimeout(
        settledPromise,
        KIMI_WIRE_INTERRUPT_TIMEOUT_MS,
        "Kimi Wire cancel 未在预期时间内结束当前任务。"
      );
    } catch {
      await this.stop();
      await settledPromise.catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    if (!this.stopPromise) {
      this.stopPromise = (async () => {
        this.clearIdleTimer();
        const error = new Error("Kimi Wire 会话已关闭。");
        for (const pending of this.pendingResponses.values()) {
          pending.reject(error);
        }
        this.pendingResponses.clear();
        await this.handle.stop();
      })()
        .catch((error) => {
          this.logger?.warn(
            {
              threadId: this.threadIdValue ?? this.initialThreadKey,
              error: error instanceof Error ? error.message : String(error)
            },
            "关闭 Kimi Wire 会话失败"
          );
        })
        .finally(() => {
          this.callbacks.onClosed();
        });
    }

    await this.stopPromise;
  }

  private attachListeners(): void {
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.handleStdoutChunk(chunk);
    });
    this.child.stderr.on("data", (chunk: string) => {
      this.handleStderrChunk(chunk);
    });
    this.child.on("error", (error) => {
      this.rejectPending(error instanceof Error ? error : new Error(String(error)));
    });
    this.child.on("close", () => {
      const fallback = this.stderr.trim() || "Kimi Wire 会话已退出。";
      this.rejectPending(new Error(fallback));
      this.callbacks.onClosed();
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingResponses.values()) {
      pending.reject(error);
    }
    this.pendingResponses.clear();
  }

  private setThreadId(threadId: string): void {
    if (this.threadIdValue === threadId) {
      return;
    }

    this.threadIdValue = threadId;
    this.callbacks.onThreadId(threadId);
    if (this.activeTurn) {
      this.activeTurn.eventQueue.push({
        kind: "thread_bound",
        threadId
      });
    }
  }

  private async initialize(): Promise<void> {
    try {
      const response = await withTimeout(
        this.sendRequest("initialize", {
          protocol_version: KIMI_WIRE_PROTOCOL_VERSION,
          client: {
            name: "codex-feishu-bot",
            version: "1"
          },
          capabilities: {
            supports_question: false,
            supports_plan_mode: false
          }
        }),
        this.timings.initializeTimeoutMs,
        "Kimi Wire initialize 超时。"
      );

      if (response.kind === "error") {
        this.logger?.warn(
          {
            error: response.error.message,
            code: response.error.code,
            threadId: this.threadIdValue ?? this.initialThreadKey
          },
          "Kimi Wire initialize 失败，回退为无握手模式"
        );
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (this.isClosedOrUnwritable()) {
        throw new Error(errorMessage || this.stderr.trim() || "Kimi Wire initialize 异常。");
      }
      this.logger?.warn(
        {
          error: errorMessage,
          threadId: this.threadIdValue ?? this.initialThreadKey
        },
        "Kimi Wire initialize 异常，回退为无握手模式"
      );
    }
  }

  private isClosedOrUnwritable(): boolean {
    const stdin = this.child.stdin;
    return (
      this.child.exitCode !== null ||
      this.child.signalCode !== null ||
      this.child.killed ||
      !stdin ||
      stdin.destroyed ||
      !stdin.writable
    );
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    let index = this.stdoutBuffer.indexOf("\n");
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line) {
        this.handleStdoutLine(line);
      }
      index = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleStderrChunk(chunk: string): void {
    this.stderr = appendTail(this.stderr, chunk, 32_000);
    this.stderrBuffer += chunk;
    let index = this.stderrBuffer.indexOf("\n");
    while (index >= 0) {
      this.stderrBuffer = this.stderrBuffer.slice(index + 1);
      index = this.stderrBuffer.indexOf("\n");
    }
  }

  private handleStdoutLine(line: string): void {
    const message = parseJsonRpcLine(line);
    if (!message) {
      return;
    }

    this.activeTurn?.bumpActivity();

    if (message.kind === "success" || message.kind === "error") {
      const pending = this.pendingResponses.get(message.id);
      if (!pending) {
        return;
      }

      this.pendingResponses.delete(message.id);
      pending.resolve(message);
      return;
    }

    if (message.kind === "request") {
      void this.sendMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: `Wire request not supported: ${message.requestType}`
        }
      }).catch(() => {
        // Ignore late write failures while closing the session.
      });
      return;
    }

    const activeTurn = this.activeTurn;
    if (!activeTurn) {
      return;
    }

    for (const event of activeTurn.projector.ingestEvent({
      type: message.eventType,
      payload: message.payload
    })) {
      activeTurn.eventQueue.push(event);
    }
  }

  private async sendRequest(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = randomUUID();
    const deferred = createDeferred<JsonRpcResponse>();
    this.pendingResponses.set(id, deferred);

    try {
      await this.sendMessage({
        jsonrpc: "2.0",
        id,
        method,
        params
      });
    } catch (error) {
      this.pendingResponses.delete(id);
      throw error;
    }

    return deferred.promise;
  }

  private async sendMessage(message: Record<string, unknown>): Promise<void> {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw new Error("Kimi Wire stdin 不可写。");
    }

    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      stdin.write(line, "utf8", (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) {
      return;
    }

    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdleStop(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.stop();
    }, KIMI_WIRE_IDLE_TTL_MS);
    this.idleTimer.unref();
  }
}

export class KimiCliWorker implements CodexWorker {
  private readonly runtime: KimiCliRuntime;
  private readonly timings: Required<KimiCliTimingOptions>;
  private readonly activeTurns = new Map<
    string,
    {
      process: KimiWireSession;
      interrupted: boolean;
      interruptionMessage?: string;
    }
  >();
  private readonly processByThreadKey = new Map<string, KimiWireSession>();

  constructor(
    env: Env,
    private readonly logger?: LoggerLike,
    runtime?: KimiCliRuntime,
    timings?: KimiCliTimingOptions
  ) {
    this.runtime = runtime ?? new HostKimiCliRuntime(env);
    this.timings = {
      initializeTimeoutMs: timings?.initializeTimeoutMs ?? KIMI_WIRE_INITIALIZE_TIMEOUT_MS,
      turnIdleTimeoutMs: timings?.turnIdleTimeoutMs ?? KIMI_WIRE_TURN_IDLE_TIMEOUT_MS
    };
  }

  supportsSteer(): boolean {
    return false;
  }

  async close(): Promise<void> {
    const uniqueProcesses = new Set(this.processByThreadKey.values());
    await Promise.allSettled(Array.from(uniqueProcesses, (process) => process.stop()));
    this.processByThreadKey.clear();
    this.activeTurns.clear();
  }

  async ensureThread(context: CodexTurnContext): Promise<string> {
    const existingThreadId = context.session?.threadId;
    if (!existingThreadId) {
      return `pending:kimi:${randomUUID()}`;
    }

    if (
      existingThreadId.startsWith("pending:") ||
      context.executionMode !== "docker" ||
      this.processByThreadKey.has(existingThreadId)
    ) {
      return existingThreadId;
    }

    if (await hasUnfinishedKimiTurn(context.workspaceId, existingThreadId)) {
      const nextThreadId = `pending:kimi:${randomUUID()}`;
      this.logger?.warn(
        {
          workspaceId: context.workspaceId,
          staleThreadId: existingThreadId,
          nextThreadId
        },
        "检测到未收尾的 Kimi Wire docker 线程，改为创建新会话"
      );
      return nextThreadId;
    }

    return existingThreadId;
  }

  async interruptTurn(context: CodexInterruptContext): Promise<void> {
    const activeTurn = this.activeTurns.get(context.turnId);
    if (!activeTurn) {
      return;
    }

    activeTurn.interrupted = true;
    const interruptionMessage = context.interruptionMessage ?? "当前任务已被中断。";
    activeTurn.interruptionMessage = interruptionMessage;
    await activeTurn.process.interruptActiveTurn(interruptionMessage);
  }

  async *runTurn(
    context: CodexTurnContext & { threadId: string }
  ): AsyncGenerator<CodexEvent> {
    const turnId = randomUUID();
    const isPendingThread = context.threadId.startsWith("pending:");

    this.logger?.info(
      {
        cli: "kimi",
        mode: "wire",
        chatId: context.message.chatId,
        messageId: context.message.messageId,
        workspaceId: context.workspaceId,
        threadId: context.threadId
      },
      "开始执行 Kimi Wire turn"
    );

    yield {
      kind: "turn_bound",
      turnId
    };
    yield {
      kind: "run_status",
      status: "running"
    };

    await this.runtime.prepare?.(context);
    const process = await this.getOrCreateProcess(context, turnId);

    const knownThreadId = process.threadId ?? (isPendingThread ? undefined : context.threadId);
    if (knownThreadId) {
      yield {
        kind: "thread_bound",
        threadId: knownThreadId
      };
    }

    const eventQueue = new AsyncEventQueue<CodexEvent>();
    this.activeTurns.set(turnId, {
      process,
      interrupted: false
    });

    void process
      .runPrompt(buildCliTurnInput(context), turnId, eventQueue)
      .catch((error) => {
        eventQueue.push({
          kind: "error",
          message: error instanceof Error ? error.message : String(error)
        });
        eventQueue.close();
      })
      .finally(() => {
        this.activeTurns.delete(turnId);
      });

    for (;;) {
      const next = await eventQueue.shift();
      if (next.done) {
        break;
      }

      yield next.value;
    }
  }

  private async getOrCreateProcess(
    context: CodexTurnContext & { threadId: string },
    turnId: string
  ): Promise<KimiWireSession> {
    const existing = this.processByThreadKey.get(context.threadId);
    if (existing) {
      await existing.ready();
      return existing;
    }

    const isPendingThread = context.threadId.startsWith("pending:");
    const knownSessionIds = isPendingThread
      ? await listKimiSessionIds(context.workspaceId)
      : undefined;
    const args = ["--wire", "--yolo", "--work-dir", context.workspaceId];
    if (!isPendingThread) {
      args.unshift(context.threadId);
      args.unshift("-r");
    }

    const handle = this.runtime.spawnProcess({
      turnId,
      context,
      args
    });
    const process = new KimiWireSession(
      handle,
      context.workspaceId,
      context.threadId,
      isPendingThread ? undefined : context.threadId,
      knownSessionIds,
      this.timings,
      this.logger,
      {
        onThreadId: (threadId) => {
          if (threadId === context.threadId) {
            return;
          }

          const current = this.processByThreadKey.get(context.threadId);
          if (current === process) {
            this.processByThreadKey.delete(context.threadId);
          }
          this.processByThreadKey.set(threadId, process);
        },
        onClosed: () => {
          for (const [key, value] of this.processByThreadKey.entries()) {
            if (value === process) {
              this.processByThreadKey.delete(key);
            }
          }
        }
      }
    );

    this.processByThreadKey.set(context.threadId, process);
    await process.ready();
    if (isPendingThread) {
      await process.awaitThreadId();
    }
    return process;
  }
}
