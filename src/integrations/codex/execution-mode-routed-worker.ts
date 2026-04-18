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
    const selectedWorker = (context.executionMode ?? "host") === "docker" ? this.dockerWorker : this.hostWorker;
    this.logger?.info(
      {
        cli: context.cli,
        executionMode: context.executionMode ?? "host",
        chatId: context.message.chatId
      },
      "根据执行模式选择 worker"
    );
    return selectedWorker;
  }
}
