import type { ChatCli } from "../../domain/types.js";
import type { CodexTurnContext, CodexWorker } from "./codex-worker.js";

export class MultiCliWorker implements CodexWorker {
  constructor(private readonly workers: Record<ChatCli, CodexWorker>) {}

  async start(): Promise<void> {
    for (const worker of Object.values(this.workers)) {
      await worker.start?.();
    }
  }

  async close(): Promise<void> {
    for (const worker of Object.values(this.workers)) {
      await worker.close?.();
    }
  }

  supportsSteer(context: CodexTurnContext): boolean {
    const worker = this.workers[context.cli];
    return worker.supportsSteer?.(context) ?? Boolean(worker.steerTurn);
  }

  ensureThread(context: CodexTurnContext): Promise<string> {
    return this.workers[context.cli].ensureThread(context);
  }

  steerTurn(context: CodexTurnContext & { threadId: string; turnId: string }): Promise<void> {
    const worker = this.workers[context.cli];
    if (!worker.steerTurn) {
      throw new Error(`${context.cli} CLI 不支持 steerTurn`);
    }
    return worker.steerTurn(context);
  }

  interruptTurn(context: CodexTurnContext & { threadId: string; turnId: string }): Promise<void> {
    const worker = this.workers[context.cli];
    if (!worker.interruptTurn) {
      throw new Error(`${context.cli} CLI 不支持 interruptTurn`);
    }
    return worker.interruptTurn(context);
  }

  async *runTurn(context: CodexTurnContext & { threadId: string }) {
    yield* this.workers[context.cli].runTurn(context);
  }
}
