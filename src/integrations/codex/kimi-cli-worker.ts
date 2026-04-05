import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import type { Env } from "../../config/env.js";
import type { CodexEvent, ConversationItemSource } from "../../domain/types.js";
import { buildCliTurnInput } from "./cli-turn-input.js";
import type { CodexTurnContext, CodexWorker } from "./codex-worker.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

interface ParsedKimiToolCall {
  id?: string;
  name: string;
  arguments?: Record<string, unknown> | string;
}

interface ParsedKimiStreamLine {
  role: "assistant" | "tool";
  text?: string;
  toolCalls: ParsedKimiToolCall[];
  toolCallId?: string;
  toolName?: string;
  sessionId?: string;
}

interface PendingAssistantMessage {
  itemId: string;
  text?: string;
  toolCalls: ParsedKimiToolCall[];
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

function appendTail(current: string, chunk: string, limit = 64_000): string {
  const next = `${current}${chunk}`;
  return next.length <= limit ? next : next.slice(-limit);
}

function normalizeTextContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || undefined;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const texts = content
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }

      if (!item || typeof item !== "object") {
        return undefined;
      }

      const value = item as {
        type?: string;
        text?: string;
        content?: string;
      };

      if (value.type === "text" && typeof value.text === "string") {
        return value.text.trim();
      }

      if (typeof value.text === "string") {
        return value.text.trim();
      }

      if (typeof value.content === "string") {
        return value.content.trim();
      }

      return undefined;
    })
    .filter((value): value is string => Boolean(value));

  return texts.length > 0 ? texts.join("\n") : undefined;
}

function parseToolArguments(value: unknown): Record<string, unknown> | string | undefined {
  if (typeof value !== "string") {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : trimmed;
  } catch {
    return trimmed;
  }
}

function parseKimiToolCalls(value: unknown): ParsedKimiToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const parsedToolCalls: ParsedKimiToolCall[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const toolCall = item as {
      id?: string;
      function?: {
        name?: string;
        arguments?: unknown;
      };
      name?: string;
      arguments?: unknown;
    };

    const name = toolCall.function?.name ?? toolCall.name;
    if (typeof name !== "string" || !name.trim()) {
      continue;
    }

    parsedToolCalls.push({
      id: typeof toolCall.id === "string" ? toolCall.id : undefined,
      name: name.trim(),
      arguments: parseToolArguments(toolCall.function?.arguments ?? toolCall.arguments)
    });
  }

  return parsedToolCalls;
}

function buildToolTitle(toolCall: ParsedKimiToolCall): string {
  if (/^(shell|bash|terminal|command)$/i.test(toolCall.name)) {
    return "执行命令";
  }

  return `调用 ${toolCall.name}`;
}

function extractToolCommand(toolCall: ParsedKimiToolCall): string | undefined {
  if (typeof toolCall.arguments === "string") {
    return toolCall.arguments.trim() || undefined;
  }

  const args = toolCall.arguments;
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

export function extractKimiSessionId(output: string): string | undefined {
  return output.match(/To resume this session:\s*kimi -r\s+([a-f0-9-]+)/i)?.[1];
}

export function parseKimiStreamLine(line: string): ParsedKimiStreamLine | undefined {
  const parsed = parseJsonLine(line);
  if (!parsed) {
    return undefined;
  }

  const role = parsed.role;
  if (role !== "assistant" && role !== "tool") {
    return undefined;
  }

  return {
    role,
    text: normalizeTextContent(parsed.content),
    toolCalls: parseKimiToolCalls(parsed.tool_calls),
    toolCallId: typeof parsed.tool_call_id === "string" ? parsed.tool_call_id : undefined,
    toolName: typeof parsed.name === "string" ? parsed.name : undefined,
    sessionId: typeof parsed.session_id === "string" ? parsed.session_id : undefined
  };
}

export class KimiStreamProjector {
  private pendingAssistant?: PendingAssistantMessage;
  private readonly toolItemIdByCallId = new Map<string, string>();
  private toolSequence = 0;
  private assistantSequence = 0;
  private emittedAssistantText = false;
  private knownThreadId?: string;

  constructor(private readonly turnId: string) {}

  noteThread(threadId?: string): CodexEvent[] {
    if (!threadId || threadId === this.knownThreadId) {
      return [];
    }

    this.knownThreadId = threadId;
    return [
      {
        kind: "thread_bound",
        threadId
      }
    ];
  }

  ingestLine(line: string): CodexEvent[] {
    const parsed = parseKimiStreamLine(line);
    if (!parsed) {
      return [];
    }

    const events = this.noteThread(parsed.sessionId);
    if (parsed.role === "assistant") {
      events.push(...this.flushPendingAssistant("commentary"));
      this.pendingAssistant = {
        itemId: `assistant:${this.turnId}:${++this.assistantSequence}`,
        text: parsed.text,
        toolCalls: parsed.toolCalls
      };
      return events;
    }

    events.push(...this.flushPendingAssistant("commentary"));
    events.push(...this.emitToolResult(parsed));
    return events;
  }

  finalize(options: {
    sessionId?: string;
    errorMessage?: string;
  }): CodexEvent[] {
    const events = this.noteThread(options.sessionId);
    if (options.errorMessage) {
      events.push(...this.flushPendingAssistant("commentary"));
      events.push({
        kind: "error",
        message: options.errorMessage
      });
      return events;
    }

    events.push(...this.flushPendingAssistant("final_answer"));
    if (!this.emittedAssistantText) {
      events.push({
        kind: "error",
        message: "Kimi CLI 没有返回可见内容。"
      });
    }
    return events;
  }

  private flushPendingAssistant(source: Extract<ConversationItemSource, "commentary" | "final_answer">): CodexEvent[] {
    const pending = this.pendingAssistant;
    if (!pending) {
      return [];
    }

    this.pendingAssistant = undefined;
    const events: CodexEvent[] = [];

    if (pending.text?.trim()) {
      this.emittedAssistantText = true;
      events.push({
        kind: "assistant_message_started",
        itemId: pending.itemId,
        source
      });
      events.push({
        kind: "assistant_message_completed",
        itemId: pending.itemId,
        text: pending.text.trim()
      });
    }

    for (const toolCall of pending.toolCalls) {
      const itemId = `tool:${this.turnId}:${++this.toolSequence}`;
      if (toolCall.id) {
        this.toolItemIdByCallId.set(toolCall.id, itemId);
      }
      events.push({
        kind: "tool_call_started",
        itemId,
        title: buildToolTitle(toolCall),
        command: extractToolCommand(toolCall)
      });
    }

    return events;
  }

  private emitToolResult(parsed: ParsedKimiStreamLine): CodexEvent[] {
    const output = parsed.text?.trim() || undefined;
    const mappedItemId =
      (parsed.toolCallId ? this.toolItemIdByCallId.get(parsed.toolCallId) : undefined) ??
      `tool:${this.turnId}:${++this.toolSequence}`;
    const createdToolShell = !parsed.toolCallId || !this.toolItemIdByCallId.has(parsed.toolCallId);
    const events: CodexEvent[] = [];

    if (createdToolShell) {
      events.push({
        kind: "tool_call_started",
        itemId: mappedItemId,
        title: parsed.toolName ? `调用 ${parsed.toolName}` : "工具结果"
      });
    }

    if (output) {
      events.push({
        kind: "tool_call_delta",
        itemId: mappedItemId,
        output,
        detail: output.length <= 200 ? output : undefined
      });
    }

    events.push({
      kind: "tool_call_completed",
      itemId: mappedItemId,
      title: parsed.toolName ? `调用 ${parsed.toolName}` : undefined,
      status: "completed",
      output
    });

    return events;
  }
}

export class KimiCliWorker implements CodexWorker {
  private readonly activeTurns = new Map<
    string,
    {
      child: ChildProcessByStdio<null, Readable, Readable>;
      interrupted: boolean;
    }
  >();

  constructor(
    private readonly env: Env,
    private readonly logger?: LoggerLike
  ) {}

  supportsSteer(): boolean {
    return false;
  }

  async ensureThread(context: CodexTurnContext): Promise<string> {
    return context.session?.threadId ?? `pending:kimi:${randomUUID()}`;
  }

  async interruptTurn(context: CodexTurnContext & { threadId: string; turnId: string }): Promise<void> {
    const activeTurn = this.activeTurns.get(context.turnId);
    if (!activeTurn) {
      return;
    }

    activeTurn.interrupted = true;
    if (!activeTurn.child.killed) {
      activeTurn.child.kill("SIGTERM");
      setTimeout(() => {
        if (!activeTurn.child.killed) {
          activeTurn.child.kill("SIGKILL");
        }
      }, 2_000).unref();
    }
  }

  async *runTurn(
    context: CodexTurnContext & { threadId: string }
  ): AsyncGenerator<CodexEvent> {
    const turnId = randomUUID();
    const isPendingThread = context.threadId.startsWith("pending:");
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--yolo",
      "--work-dir",
      context.workspaceId,
      "--prompt",
      buildCliTurnInput(context)
    ];

    if (!isPendingThread) {
      args.unshift(context.threadId);
      args.unshift("-r");
    }

    this.logger?.info(
      {
        cli: "kimi",
        chatId: context.message.chatId,
        messageId: context.message.messageId,
        workspaceId: context.workspaceId,
        threadId: context.threadId
      },
      "开始执行 Kimi CLI turn"
    );

    if (!isPendingThread) {
      yield {
        kind: "thread_bound",
        threadId: context.threadId
      };
    }
    yield {
      kind: "turn_bound",
      turnId
    };
    yield {
      kind: "run_status",
      status: "running"
    };
    yield {
      kind: "assistant_message_started",
      itemId: `commentary:${turnId}:start`,
      source: "commentary"
    };
    yield {
      kind: "assistant_message_completed",
      itemId: `commentary:${turnId}:start`,
      text: "Kimi 已开始处理。当前 CLI 不会暴露推理过程；如果它给出阶段说明或工具结果，我会继续同步。"
    };

    const eventQueue = new AsyncEventQueue<CodexEvent>();
    const projector = new KimiStreamProjector(turnId);
    let activeTurn:
      | {
          child: ChildProcessByStdio<null, Readable, Readable>;
          interrupted: boolean;
        }
      | undefined;

    const closeResultPromise = new Promise<{
      exitCode: number;
      stderr: string;
      sessionId?: string;
    }>((resolve) => {
      const child = spawn(this.env.KIMI_CLI_COMMAND, args, {
        cwd: context.workspaceId,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const activeTurnRecord = {
        child,
        interrupted: false
      };
      activeTurn = activeTurnRecord;
      this.activeTurns.set(turnId, activeTurnRecord);

      let stdoutBuffer = "";
      let stderrBuffer = "";
      let stderr = "";
      let rawOutput = "";
      let settled = false;

      const finish = (exitCode: number, extraStderr?: string) => {
        if (settled) {
          return;
        }

        settled = true;
        this.activeTurns.delete(turnId);
        const trailingStdout = stdoutBuffer.trim();
        const trailingStderr = stderrBuffer.trim();
        if (trailingStdout) {
          for (const event of projector.ingestLine(trailingStdout)) {
            eventQueue.push(event);
          }
        }
        if (trailingStderr) {
          for (const event of projector.ingestLine(trailingStderr)) {
            eventQueue.push(event);
          }
        }

        resolve({
          exitCode,
          stderr: (extraStderr ?? stderr).trim(),
          sessionId: extractKimiSessionId(rawOutput)
        });
      };

      const handleChunk = (chunk: string, stream: "stdout" | "stderr") => {
        rawOutput = appendTail(rawOutput, chunk);
        if (stream === "stderr") {
          stderr = appendTail(stderr, chunk, 32_000);
          stderrBuffer += chunk;
          let index = stderrBuffer.indexOf("\n");
          while (index >= 0) {
            const line = stderrBuffer.slice(0, index).trim();
            stderrBuffer = stderrBuffer.slice(index + 1);
            if (line) {
              for (const event of projector.ingestLine(line)) {
                eventQueue.push(event);
              }
            }
            index = stderrBuffer.indexOf("\n");
          }
          return;
        }

        stdoutBuffer += chunk;
        let index = stdoutBuffer.indexOf("\n");
        while (index >= 0) {
          const line = stdoutBuffer.slice(0, index).trim();
          stdoutBuffer = stdoutBuffer.slice(index + 1);
          if (line) {
            for (const event of projector.ingestLine(line)) {
              eventQueue.push(event);
            }
          }
          index = stdoutBuffer.indexOf("\n");
        }
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        handleChunk(chunk, "stdout");
      });
      child.stderr.on("data", (chunk: string) => {
        handleChunk(chunk, "stderr");
      });
      child.on("error", (error) => {
        finish(1, error instanceof Error ? error.message : String(error));
      });
      child.on("close", (exitCode) => {
        finish(exitCode ?? 1);
      });
    });

    void closeResultPromise
      .then((result) => {
        const errorMessage = activeTurn?.interrupted
          ? "当前任务已被“新会话”中断。"
          : result.exitCode !== 0
            ? result.stderr || "Kimi CLI 执行失败。"
            : undefined;

        for (const event of projector.finalize({
          sessionId: result.sessionId,
          errorMessage
        })) {
          eventQueue.push(event);
        }
      })
      .catch((error) => {
        eventQueue.push({
          kind: "error",
          message: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        eventQueue.close();
      });

    for (;;) {
      const next = await eventQueue.shift();
      if (next.done) {
        break;
      }

      yield next.value;
    }
  }
}
