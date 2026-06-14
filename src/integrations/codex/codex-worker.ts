import type {
  ChatCli,
  ChatExecutionMode,
  ChatSession,
  CodexEvent,
  IncomingChatMessage
} from "../../domain/types.js";

export interface CodexTurnContext {
  session?: ChatSession;
  cli: ChatCli;
  workspaceId: string;
  executionMode?: ChatExecutionMode;
  provider?: string;
  model?: string;
  thinking?: string;
  message: IncomingChatMessage;
}

export interface CodexInterruptContext extends CodexTurnContext {
  threadId: string;
  turnId: string;
  interruptionMessage?: string;
}

export interface CodexWorker {
  start?(): Promise<void>;
  close?(): Promise<void>;
  supportsSteer?(context: CodexTurnContext): boolean;
  ensureThread(context: CodexTurnContext): Promise<string>;
  steerTurn?(context: CodexTurnContext & { threadId: string; turnId: string }): Promise<void>;
  interruptTurn?(context: CodexInterruptContext): Promise<void>;
  runTurn(context: CodexTurnContext & { threadId: string }): AsyncGenerator<CodexEvent>;
}
