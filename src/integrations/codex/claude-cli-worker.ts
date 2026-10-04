import { createInterface } from "node:readline";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import type { CodexEvent } from "../../domain/types.js";
import type { Env } from "../../config/env.js";
import { clearProxyEnv } from "../../config/proxy-env.js";
import { buildCliTurnInput } from "./cli-turn-input.js";
import type { CodexInterruptContext, CodexTurnContext, CodexWorker } from "./codex-worker.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Convert complete JSONL events while Claude is still running. Keep the last
 * text pending until a tool call or result identifies it as progress or final. */
export class ClaudeStreamProjector {
  private pendingText: string[] = [];
  private sequence = 0;
  private lastProgressAt = 0;
  private progressStarted = false;
  private readonly tools = new Set<string>();
  resultText?: string;
  error?: string;
  sessionId?: string;

  constructor(private readonly turnId: string) {}

  consume(line: string): CodexEvent[] {
    let event: Record<string, any>;
    try { event = JSON.parse(line); } catch { return []; }
    if (!event || typeof event !== "object") return [];
    const events: CodexEvent[] = [];
    if (typeof event.session_id === "string") this.sessionId = event.session_id;
    if (event.type === "result") {
      if (typeof event.result === "string" && event.result.trim()) this.resultText = event.result.trim();
      if (event.is_error === true) this.error = this.resultText ?? "Claude CLI 执行失败。";
      return events;
    }
    const content = event.message?.content;
    if (!Array.isArray(content)) return events;
    if (event.type === "assistant") {
      if (typeof event.error === "string") this.error = "Claude CLI 请求失败。";
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          this.pendingText.push(block.text.trim());
        }
        if (block?.type === "tool_use" && typeof block.id === "string" && !this.tools.has(block.id)) {
          this.tools.add(block.id);
          const title = typeof block.name === "string" ? block.name : "工具";
          if (this.pendingText.length) {
            const itemId = `claude-commentary:${this.turnId}:${this.sequence++}`;
            events.push({ kind: "assistant_message_started", itemId, source: "commentary" },
              { kind: "assistant_message_completed", itemId, text: this.pendingText.join("\n\n") });
            this.pendingText = [];
          } else if (Date.now() - this.lastProgressAt >= 15_000) {
            // Tool cards are opt-in. A compact status remains visible by default,
            // and updates one message instead of sending a message per tool call.
            const itemId = `claude-progress:${this.turnId}`;
            if (!this.progressStarted) {
              events.push({ kind: "assistant_message_started", itemId, source: "commentary" });
              this.progressStarted = true;
            }
            events.push({ kind: "assistant_message_completed", itemId, text: `Claude 正在执行：${title}。` });
            this.lastProgressAt = Date.now();
          }
          events.push({ kind: "tool_call_started", itemId: block.id, title });
        }
      }
    }
    if (event.type === "user") {
      for (const block of content) {
        if (block?.type === "tool_result" && this.tools.has(block.tool_use_id)) {
          events.push({ kind: "tool_call_completed", itemId: block.tool_use_id,
            status: block.is_error ? "failed" : "completed" });
        }
      }
    }
    return events;
  }

  continueAfterResult(): CodexEvent[] {
    const text = this.resultText ?? this.pendingText.join("\n\n");
    const itemId = `claude-commentary:${this.turnId}:${this.sequence++}`;
    const events: CodexEvent[] = text && !this.error ? [
      { kind: "assistant_message_started", itemId, source: "commentary" },
      { kind: "assistant_message_completed", itemId, text }
    ] : [];
    this.pendingText = [];
    this.resultText = undefined;
    this.error = undefined;
    return events;
  }

  finish(): CodexEvent[] {
    if (!this.progressStarted) return [];
    return [{ kind: "assistant_message_completed", itemId: `claude-progress:${this.turnId}`,
      text: this.error ? "Claude 执行遇到错误。" : "Claude 本轮执行已结束。" }];
  }

  finalText(): string {
    return this.resultText ?? (this.pendingText.join("\n\n") || "Claude CLI 没有返回可见内容。");
  }
}

export function claudeProcessEnv(proxy?: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  clearProxyEnv(env);
  if (proxy) {
    env.http_proxy = env.https_proxy = env.HTTP_PROXY = env.HTTPS_PROXY = proxy;
    env.no_proxy = env.NO_PROXY = "localhost,127.0.0.1,::1";
  }
  return env;
}

export async function buildClaudeArgs(
  context: CodexTurnContext & { threadId: string },
  configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
): Promise<string[]> {
  // A thread is persisted by the orchestrator before its first turn. Check the
  // actual Claude transcript to distinguish a new session from a resumed one.
  const project = context.workspaceId.replace(/[^a-zA-Z0-9]/g, "-");
  const exists = await access(join(configDir, "projects", project, `${context.threadId}.jsonl`))
    .then(() => true, () => false);
  const args = ["-p", "--output-format", "stream-json", "--verbose",
    "--input-format", "stream-json", "--replay-user-messages",
    "--dangerously-skip-permissions", exists ? "--resume" : "--session-id", context.threadId];
  if (context.model) args.push("--model", context.model);
  return args;
}

function claudeSessionId(value?: string): string {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : randomUUID();
}

export class ClaudeCliWorker implements CodexWorker {
  private readonly activeTurns = new Map<
    string,
    {
      child: ChildProcessByStdio<Writable, Readable, Readable>;
      chatId: string;
      threadId: string;
      acceptingInput: boolean;
      pendingInputs: Set<string>;
      interrupted: boolean;
      interruptionMessage?: string;
    }
  >();

  constructor(
    private readonly env: Env,
    private readonly logger?: LoggerLike
  ) {}

  supportsSteer(): boolean {
    return true;
  }

  async steerTurn(context: CodexTurnContext & { threadId: string; turnId: string }): Promise<void> {
    const active = this.activeTurns.get(context.turnId);
    if (!active || !active.acceptingInput || active.interrupted ||
        active.chatId !== context.message.chatId || active.threadId !== context.threadId) {
      throw Object.assign(new Error("Claude 当前任务已进入收尾，等待结束后继续处理新消息。"), { code: "CLAUDE_TURN_FINISHED" });
    }
    await this.sendInput(active, context, "now");
    this.logger?.info({ chatId: context.message.chatId, messageId: context.message.messageId,
      threadId: context.threadId, turnId: context.turnId, pid: active.child.pid }, "已向运行中的 Claude 会话追加 steer 消息");
  }

  private async sendInput(
    active: { child: ChildProcessByStdio<Writable, Readable, Readable>; threadId: string; pendingInputs: Set<string> },
    context: CodexTurnContext,
    priority: "now" | "next"
  ): Promise<void> {
    const uuid = randomUUID();
    active.pendingInputs.add(uuid);
    const input = JSON.stringify({ type: "user", uuid, session_id: active.threadId,
      parent_tool_use_id: null, priority,
      message: { role: "user", content: buildCliTurnInput(context) } });
    try {
      await new Promise<void>((resolve, reject) => {
        active.child.stdin.write(`${input}\n`, (error) => error ? reject(error) : resolve());
      });
    } catch (error) {
      active.pendingInputs.delete(uuid);
      throw error;
    }
  }

  async ensureThread(context: CodexTurnContext): Promise<string> {
    return claudeSessionId(context.session?.threadId);
  }

  async interruptTurn(context: CodexInterruptContext): Promise<void> {
    const activeTurn = this.activeTurns.get(context.turnId);
    if (!activeTurn) {
      return;
    }

    activeTurn.acceptingInput = false;
    activeTurn.interrupted = true;
    activeTurn.interruptionMessage = context.interruptionMessage ?? "当前任务已被中断。";
    if (!activeTurn.child.killed) {
      activeTurn.child.kill("SIGTERM");
      setTimeout(() => {
        if (activeTurn.child.exitCode === null && activeTurn.child.signalCode === null) {
          activeTurn.child.kill("SIGKILL");
        }
      }, 2_000).unref();
    }
  }

  async *runTurn(
    context: CodexTurnContext & { threadId: string }
  ): AsyncGenerator<CodexEvent> {
    // First turns reach runTurn directly with the orchestrator's pending ID.
    // Normalize here as well as ensureThread, and publish the UUID so later
    // turns (including after restart) resume the same Claude session.
    context = { ...context, threadId: claudeSessionId(context.threadId) };
    const turnId = randomUUID();
    const itemId = `final:${turnId}`;
    const args = await buildClaudeArgs(context);
    const commandLine = [
      this.env.CLAUDE_CLI_COMMAND,
      ...args.map((arg) => shellEscape(arg))
    ].join(" ");

    const stream = new ClaudeStreamProjector(turnId);
    const child = spawn("zsh", ["-lc", `exec ${commandLine}`], {
      cwd: context.workspaceId,
      env: claudeProcessEnv(this.env.CLAUDE_PROXY_URL),
      stdio: ["pipe", "pipe", "pipe"]
    });
    const activeTurn = { child, chatId: context.message.chatId, threadId: context.threadId,
      acceptingInput: true, pendingInputs: new Set<string>(),
      interrupted: false, interruptionMessage: undefined as string | undefined };
    this.activeTurns.set(turnId, activeTurn);
    this.logger?.info(
      {
        cli: "claude",
        pid: child.pid,
        chatId: context.message.chatId,
        messageId: context.message.messageId,
        workspaceId: context.workspaceId,
        threadId: context.threadId
      },
      "开始执行 Claude CLI turn"
    );


    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-32_768); });
    // A write callback reports failed delivery; keep EPIPE from becoming an
    // uncaught process error when the child exits while a message is arriving.
    child.stdin.on("error", () => { activeTurn.acceptingInput = false; });
    const closed = new Promise<number>((resolve) => {
      child.once("error", (error) => { stderr = error.message; resolve(1); });
      child.once("close", (code) => resolve(code ?? 1));
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let exitCode = 1;
    let completedResult = false;
    try {
      await this.sendInput(activeTurn, context, "next");
      yield {
        kind: "thread_bound",
        threadId: context.threadId
      };
      yield {
        kind: "turn_bound",
        turnId
      };
      yield {
        kind: "run_status",
        status: "running"
      };

      for await (const line of lines) {
        if (activeTurn.interrupted) continue;
        let raw: Record<string, unknown>;
        try { raw = JSON.parse(line); } catch { continue; }
        if (!raw || typeof raw !== "object") continue;
        if (raw.type === "user" && typeof raw.uuid === "string") activeTurn.pendingInputs.delete(raw.uuid);
        const events = stream.consume(line);
        if (raw.type === "result") {
          // A result may finish only the old request. Do not close stdin while
          // newer sends await acknowledgement or the CLI reports queued turns.
          if (activeTurn.pendingInputs.size > 0 ||
              (typeof raw.queued_turn_count === "number" && raw.queued_turn_count > 0)) {
            events.push(...stream.continueAfterResult());
          } else {
            completedResult = true;
            activeTurn.acceptingInput = false;
            child.stdin.end();
          }
        }
        for (const event of events) yield event;
      }
      exitCode = await closed;
    } finally {
      activeTurn.acceptingInput = false;
      lines.close();
      this.activeTurns.delete(turnId);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }

    if (activeTurn?.interrupted) {
      stream.error = activeTurn.interruptionMessage ?? "当前任务已被中断。";
      yield* stream.finish();
      yield {
        kind: "error",
        message: activeTurn.interruptionMessage ?? "当前任务已被中断。"
      };
      return;
    }

    const errorText =
      stream.error ||
      (exitCode !== 0
        ? stderr.trim() || "Claude CLI 执行失败。"
        : !completedResult ? "Claude 会话提前退出，追加消息可能尚未处理，请重发未完成的请求。" : undefined);

    if (stream.sessionId && stream.sessionId !== context.threadId) {
      yield {
        kind: "thread_bound",
        threadId: stream.sessionId
      };
    }

    if (errorText) stream.error = errorText;
    yield* stream.finish();

    if (errorText) {
      yield {
        kind: "error",
        message: errorText
      };
      return;
    }

    yield {
      kind: "assistant_message_started",
      itemId,
      source: "final_answer"
    };
    yield {
      kind: "assistant_message_completed",
      itemId,
      text: stream.finalText()
    };
  }
}
