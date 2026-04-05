import type { CodexTurnContext, CodexWorker } from "./codex-worker.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

export class ExecutionModeRoutedCodexWorker implements CodexWorker {
  constructor(
    private readonly hostWorker: CodexWorker,
    private readonly dockerWorker: CodexWorker,
    private readonly logger?: LoggerLike
  ) {}

  async start(): Promise<void> {
    await this.hostWorker.start?.();
    await this.dockerWorker.start?.();
  }

  async close(): Promise<void> {
    await this.hostWorker.close?.();
    await this.dockerWorker.close?.();
  }

  supportsSteer(context: CodexTurnContext): boolean {
    const worker = this.selectWorker(context);
    return worker.supportsSteer?.(context) ?? Boolean(worker.steerTurn);
  }

  ensureThread(context: CodexTurnContext): Promise<string> {
    return this.selectWorker(context).ensureThread(context);
  }

  steerTurn(context: CodexTurnContext & { threadId: string; turnId: string }): Promise<void> {
    const worker = this.selectWorker(context);
    if (!worker.steerTurn) {
      throw new Error(`${context.cli} / ${context.executionMode ?? "host"} 不支持 steerTurn`);
    }
    return worker.steerTurn(context);
  }

  interruptTurn(context: CodexTurnContext & { threadId: string; turnId: string }): Promise<void> {
    const worker = this.selectWorker(context);
    if (!worker.interruptTurn) {
      throw new Error(`${context.cli} / ${context.executionMode ?? "host"} 不支持 interruptTurn`);
    }
    return worker.interruptTurn(context);
  }

  async *runTurn(context: CodexTurnContext & { threadId: string }) {
    yield* this.selectWorker(context).runTurn(context);
  }

  private selectWorker(context: CodexTurnContext): CodexWorker {
    if ((context.executionMode ?? "host") !== "docker") {
      return this.hostWorker;
    }

    if (context.cli !== "codex") {
      this.logger?.warn(
        {
          cli: context.cli,
          executionMode: context.executionMode,
          chatId: context.message.chatId
        },
        "docker 模式当前只支持 codex"
      );
      throw new Error("docker 模式当前只支持 codex。请把群绑定改回 host，或者切回 codex。");
    }

    return this.dockerWorker;
  }
}
