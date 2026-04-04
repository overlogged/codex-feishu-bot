import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import type { CodexEvent } from "../../domain/types.js";
import type { Env } from "../../config/env.js";
import { buildCliTurnInput } from "./cli-turn-input.js";
import type { CodexTurnContext, CodexWorker } from "./codex-worker.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function extractClaudeResult(output: string): {
  sessionId?: string;
  text?: string;
  error?: string;
} {
  const events = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });

  let sessionId: string | undefined;
  let text: string | undefined;
  let error: string | undefined;

  for (const event of events) {
    if (typeof event.session_id === "string") {
      sessionId = event.session_id;
    }

    if (event.type === "assistant") {
      const message = event.message as
        | {
            content?: Array<{
              type?: string;
              text?: string;
            }>;
          }
        | undefined;
      const assistantText = message?.content
        ?.filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text?.trim())
        .filter(Boolean)
        .join("\n");
      if (assistantText) {
        text = assistantText;
      }
      if (typeof event.error === "string") {
        error = assistantText || event.error;
      }
    }

    if (event.type === "result") {
      if (typeof event.result === "string" && event.result.trim()) {
        text = event.result.trim();
      }
      if (event.is_error === true) {
        error =
          (typeof event.result === "string" && event.result.trim()) ||
          error ||
          "Claude CLI 执行失败。";
      }
    }
  }

  return {
    sessionId,
    text,
    error
  };
}

export class ClaudeCliWorker implements CodexWorker {
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
    return context.session?.threadId ?? randomUUID();
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
    const itemId = `final:${turnId}`;
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      context.threadId,
      buildCliTurnInput(context)
    ];
    const commandLine = [
      this.env.CLAUDE_CLI_COMMAND,
      ...args.map((arg) => shellEscape(arg))
    ].join(" ");

    this.logger?.info(
      {
        cli: "claude",
        chatId: context.message.chatId,
        messageId: context.message.messageId,
        workspaceId: context.workspaceId,
        threadId: context.threadId
      },
      "开始执行 Claude CLI turn"
    );

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

    let activeTurn:
      | {
          child: ChildProcessByStdio<null, Readable, Readable>;
          interrupted: boolean;
        }
      | undefined;
    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>((resolve, reject) => {
      const child = spawn(
        "zsh",
        ["-lc", `source ~/.zshrc >/dev/null 2>&1; exec ${commandLine}`],
        {
          cwd: context.workspaceId,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      const activeTurnRecord = {
        child,
        interrupted: false
      };
      activeTurn = activeTurnRecord;
      this.activeTurns.set(turnId, activeTurnRecord);

      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (exitCode) => {
        resolve({
          stdout,
          stderr,
          exitCode: exitCode ?? 1
        });
      });
    }).catch((error) => {
      return {
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1
      };
    });
    this.activeTurns.delete(turnId);

    if (activeTurn?.interrupted) {
      yield {
        kind: "error",
        message: "当前任务已被“新会话”中断。"
      };
      return;
    }

    const parsed = extractClaudeResult(result.stdout);
    const errorText =
      parsed.error ||
      (result.exitCode !== 0
        ? parsed.text || result.stderr.trim() || "Claude CLI 执行失败。"
        : undefined);

    if (parsed.sessionId && parsed.sessionId !== context.threadId) {
      yield {
        kind: "thread_bound",
        threadId: parsed.sessionId
      };
    }

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
      text: parsed.text?.trim() || "Claude CLI 没有返回可见内容。"
    };
  }
}
