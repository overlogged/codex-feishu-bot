import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import type { Env } from "../../config/env.js";
import type { CodexEvent } from "../../domain/types.js";
import { buildCliTurnInput } from "./cli-turn-input.js";
import type { CodexTurnContext, CodexWorker } from "./codex-worker.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

function parseKimiResult(output: string): {
  sessionId?: string;
  text?: string;
} {
  const sessionId = output.match(/To resume this session:\s*kimi -r\s+([a-f0-9-]+)/i)?.[1];
  const jsonLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("{"));

  let text: string | undefined;
  if (jsonLine) {
    try {
      const parsed = JSON.parse(jsonLine) as {
        content?: Array<{
          type?: string;
          text?: string;
        }>;
      };
      text = parsed.content
        ?.filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text?.trim())
        .filter(Boolean)
        .join("\n");
    } catch {
      text = undefined;
    }
  }

  return {
    sessionId,
    text
  };
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
    const itemId = `final:${turnId}`;
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

    const parsed = parseKimiResult(`${result.stdout}\n${result.stderr}`);
    if (parsed.sessionId) {
      yield {
        kind: "thread_bound",
        threadId: parsed.sessionId
      };
    }

    if (result.exitCode !== 0) {
      yield {
        kind: "error",
        message: result.stderr.trim() || parsed.text || "Kimi CLI 执行失败。"
      };
      return;
    }

    if (!parsed.text?.trim()) {
      yield {
        kind: "error",
        message: "Kimi CLI 没有返回可见内容。"
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
      text: parsed.text.trim()
    };
  }
}
