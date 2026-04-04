import type { ChatCli, ChatSession, CodexEvent, IncomingChatMessage } from "../../domain/types.js";

export interface CodexTurnContext {
  session?: ChatSession;
  cli: ChatCli;
  workspaceId: string;
  message: IncomingChatMessage;
}

export interface CodexWorker {
  start?(): Promise<void>;
  close?(): Promise<void>;
  supportsSteer?(context: CodexTurnContext): boolean;
  ensureThread(context: CodexTurnContext): Promise<string>;
  steerTurn?(context: CodexTurnContext & { threadId: string; turnId: string }): Promise<void>;
  interruptTurn?(context: CodexTurnContext & { threadId: string; turnId: string }): Promise<void>;
  runTurn(context: CodexTurnContext & { threadId: string }): AsyncGenerator<CodexEvent>;
}
