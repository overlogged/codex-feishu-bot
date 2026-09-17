export const CHAT_CLI_VALUES = ["codex", "claude", "kimi", "pi"] as const;
export type ChatCli = (typeof CHAT_CLI_VALUES)[number];

export interface IncomingChatMessage {
  chatId: string;
  chatType: string;
  chatName?: string;
  messageId: string;
  senderId: string;
  senderName: string;
  senderType: string;
  tenantKey?: string;
  text: string;
  mentionsBot: boolean;
  raw: unknown;
}

export interface ChatSession {
  chatId: string;
  threadId: string;
  cli: ChatCli;
  workspaceId: string;
  provider?: string;
  model?: string;
  thinking?: string;
  controlThreadId?: string;
  controlCli?: ChatCli;
  controlReplyToMessageId?: string;
  chatType?: string;
  chatName?: string;
  chatDisplayName?: string;
  activeRunId?: string;
  activeTurnId?: string;
  toolCardsEnabled?: boolean;
  tokenDailyReportEnabled?: boolean;
  /** 每日 token 日报发送时间，格式 HH:mm（本地时区）。 */
  tokenDailyReportTime?: string;
  /** 最近一次已发送日报的本地日期，格式 YYYY-MM-DD。 */
  tokenDailyReportLastSentDate?: string;
  lastInboundAt?: string;
  lastSenderId?: string;
  lastSenderName?: string;
  lastMessageId?: string;
  lastMessagePreview?: string;
  lastUserMessagePreview?: string;
  updatedAt: string;
}

export type ScheduledTaskStatus = "enabled" | "paused";
export type ScheduledTaskKind = "recurring" | "once";

export interface ScheduledTaskRecord {
  chatId: string;
  taskId: string;
  kind?: ScheduledTaskKind;
  cron?: string;
  runAt?: string;
  prompt: string;
  status: ScheduledTaskStatus;
  createdAt: string;
  updatedAt: string;
  createdById?: string;
  createdByName?: string;
  nextRunAt?: string;
  lastTriggeredAt?: string;
  lastError?: string;
}

export type RunStatus = "queued" | "running" | "completed" | "failed";

export interface RunRecord {
  runId: string;
  chatId: string;
  threadId: string;
  sourceMessageId: string;
  status: RunStatus;
  errorMessage?: string;
  startedAt: string;
  updatedAt: string;
}

export type ConversationItemKind = "assistant_text" | "tool_card" | "artifact_file";
export type ConversationItemPhase = "queued" | "streaming" | "completed" | "failed";
export type ConversationItemSource = "commentary" | "final_answer" | "tool" | "artifact";

export interface ConversationItem {
  runId: string;
  chatId: string;
  sourceMessageId: string;
  itemId: string;
  order: number;
  kind: ConversationItemKind;
  source: ConversationItemSource;
  phase: ConversationItemPhase;
  title?: string;
  content?: string;
  command?: string;
  output?: string;
  details: string[];
  filePaths: string[];
  artifactPath?: string;
  feishuMessageId?: string;
  feishuMessageIds?: string[];
  deliveredContentHash?: string;
  createdAt: string;
  updatedAt: string;
}

export type CodexEvent =
  | {
      kind: "thread_bound";
      threadId: string;
    }
  | {
      kind: "turn_bound";
      turnId: string;
    }
  | {
      kind: "run_status";
      status: RunStatus;
      detail?: string;
    }
  | {
      kind: "assistant_message_started";
      itemId: string;
      source: Extract<ConversationItemSource, "commentary" | "final_answer">;
    }
  | {
      kind: "assistant_message_delta";
      itemId: string;
      text: string;
    }
  | {
      kind: "assistant_message_completed";
      itemId: string;
      text: string;
    }
  | {
      kind: "tool_call_started";
      itemId: string;
      title: string;
      command?: string;
    }
  | {
      kind: "tool_call_delta";
      itemId: string;
      detail?: string;
      output?: string;
      path?: string;
    }
  | {
      kind: "tool_call_completed";
      itemId: string;
      title?: string;
      status: "completed" | "failed";
      output?: string;
      paths?: string[];
    }
  | {
      kind: "artifact_ready";
      itemId: string;
      title?: string;
      path: string;
    }
  | {
      kind: "error";
      message: string;
    };
