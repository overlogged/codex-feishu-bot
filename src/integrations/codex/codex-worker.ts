import type {
  ChatCli,
  ChatSession,
  CodexEvent,
  IncomingChatMessage
} from "../../domain/types.js";

export interface CodexTurnContext {
  session?: ChatSession;
  cli: ChatCli;
  workspaceId: string;
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

export interface CodexGoalState {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface CodexGoalRunContext extends CodexTurnContext {
  threadId: string;
  objective: string;
}

export interface CodexWorker {
  start?(): Promise<void>;
  close?(): Promise<void>;
  supportsSteer?(context: CodexTurnContext): boolean;
  ensureThread(context: CodexTurnContext): Promise<string>;
  steerTurn?(context: CodexTurnContext & { threadId: string; turnId: string }): Promise<void>;
  interruptTurn?(context: CodexInterruptContext): Promise<void>;
  getGoal?(context: CodexTurnContext & { threadId: string }): Promise<CodexGoalState | null>;
  clearGoal?(context: CodexTurnContext & { threadId: string }): Promise<boolean>;
  runGoal?(context: CodexGoalRunContext): AsyncGenerator<CodexEvent>;
  runTurn(context: CodexTurnContext & { threadId: string }): AsyncGenerator<CodexEvent>;
}
