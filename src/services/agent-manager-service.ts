import { randomUUID } from "node:crypto";

import type {
  ChatSession,
  ConversationItem,
  ConversationItemSource,
  IncomingChatMessage,
  RunRecord
} from "../domain/types.js";
import type { FeishuMessageClient } from "../integrations/feishu/feishu-message-client.js";
import type {
  SessionMetadataProvider,
  SessionMetadataProviderResult
} from "../integrations/feishu/feishu-session-metadata-provider.js";
import { ConversationStore } from "../stores/conversation-store.js";
import { RunStore } from "../stores/run-store.js";
import { SessionStore } from "../stores/session-store.js";

interface MessageIngress {
  enqueue(message: IncomingChatMessage): void;
}

export interface AgentManagedSessionSummary {
  chatId: string;
  chatType: string;
  title: string;
  chatName?: string;
  chatDisplayName?: string;
  cli: ChatSession["cli"];
  executionMode: NonNullable<ChatSession["executionMode"]>;
  workspaceId: string;
  threadId: string;
  updatedAt: string;
  lastInboundAt?: string;
  lastSenderName?: string;
  lastMessagePreview?: string;
  lastUserMessagePreview?: string;
  lastReplyPreview?: string;
  activeRunId?: string;
  activeTurnId?: string;
  currentRunId?: string;
  runStatus: RunRecord["status"] | "idle";
  focus: string;
  isMainPrivateSession: boolean;
}

export interface AgentManagerSendInput {
  from: string;
  content: string;
  source: "http" | "cli";
  mirrorToFeishu?: boolean;
}

export interface AgentManagerSendResult {
  session: AgentManagedSessionSummary;
  sourceMessageId: string;
  forwardedText: string;
  mirroredToFeishu: boolean;
}

export interface AgentManagerUpdateItem {
  chatId: string;
  title: string;
  status: "updated" | "unchanged" | "failed";
  changedFields: string[];
  warnings: string[];
  error?: string;
}

export interface AgentManagerUpdateResult {
  total: number;
  updated: number;
  unchanged: number;
  failed: number;
  results: AgentManagerUpdateItem[];
}

export interface AgentManagerStableMessage {
  id: string;
  chatId: string;
  title: string;
  runId: string;
  itemId: string;
  source: Extract<ConversationItemSource, "commentary" | "final_answer">;
  phase: "completed" | "failed";
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentManagerStableMessageQuery {
  afterId?: string;
  limit?: number;
  source?: "commentary" | "final_answer" | "all";
}

export interface AgentManagerStableMessageResult {
  session: AgentManagedSessionSummary;
  messages: AgentManagerStableMessage[];
}

function summarizeText(value: string | undefined, maxLength = 120): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function extractLastParagraph(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const paragraphs = value
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return paragraphs.at(-1);
}

function compareTimestamps(left?: string, right?: string): number {
  const leftValue = left ? Date.parse(left) : 0;
  const rightValue = right ? Date.parse(right) : 0;
  return leftValue - rightValue;
}

function resolveLastUserMessagePreview(session: ChatSession): string | undefined {
  if (session.lastUserMessagePreview) {
    return session.lastUserMessagePreview;
  }

  if (session.lastSenderId?.startsWith("system:")) {
    return undefined;
  }

  return session.lastMessagePreview;
}

function formatForwardedText(from: string, content: string): string {
  return `来自${from}说：\n${content}`;
}

function normalizeSendInput(input: AgentManagerSendInput): {
  from: string;
  content: string;
  source: "http" | "cli";
  mirrorToFeishu: boolean;
} {
  const from = input.from.trim();
  const content = input.content.trim();
  if (!from) {
    throw new Error("from 不能为空。");
  }
  if (!content) {
    throw new Error("content 不能为空。");
  }

  return {
    from,
    content,
    source: input.source,
    mirrorToFeishu: Boolean(input.mirrorToFeishu)
  };
}

export class AgentManagerService {
  constructor(
    private readonly defaultWorkspace: string,
    private readonly sessionStore: SessionStore,
    private readonly runStore: RunStore,
    private readonly conversationStore: ConversationStore,
    private readonly feishuClient: FeishuMessageClient,
    private readonly messageIngress: MessageIngress,
    private readonly sessionMetadataProvider?: SessionMetadataProvider
  ) {}

  listSessions(): AgentManagedSessionSummary[] {
    const sessions = this.sessionStore.list();
    const mainPrivateSession = this.selectMainPrivateSession(sessions);

    return sessions
      .map((session) => this.buildSessionSummary(session, mainPrivateSession?.chatId))
      .sort((left, right) => {
        if (left.isMainPrivateSession !== right.isMainPrivateSession) {
          return left.isMainPrivateSession ? -1 : 1;
        }
        if (Boolean(left.activeRunId) !== Boolean(right.activeRunId)) {
          return left.activeRunId ? -1 : 1;
        }
        return compareTimestamps(right.lastInboundAt ?? right.updatedAt, left.lastInboundAt ?? left.updatedAt);
      });
  }

  getSession(chatId: string): AgentManagedSessionSummary | undefined {
    return this.listSessions().find((session) => session.chatId === chatId);
  }

  getMainPrivateSession(): AgentManagedSessionSummary | undefined {
    return this.listSessions().find((session) => session.isMainPrivateSession);
  }

  listStableMessagesForMainPrivateSession(
    query: AgentManagerStableMessageQuery = {}
  ): AgentManagerStableMessageResult {
    const session = this.selectMainPrivateSession(this.sessionStore.list());
    if (!session) {
      throw new Error("当前还没有可用的私聊主 session。先在飞书里和机器人进行一次私聊。");
    }

    return this.listStableMessagesForSession(session.chatId, query);
  }

  listStableMessagesForSession(
    chatId: string,
    query: AgentManagerStableMessageQuery = {}
  ): AgentManagerStableMessageResult {
    const session = this.sessionStore.get(chatId);
    if (!session) {
      throw new Error(`chatId=${chatId} 的 session 不存在。`);
    }

    const normalizedSource = query.source ?? "commentary";
    const stableMessages = this.conversationStore
      .list()
      .filter((item) => item.chatId === chatId)
      .filter((item): item is ConversationItem & {
        kind: "assistant_text";
        source: "commentary" | "final_answer";
        phase: "completed" | "failed";
        content: string;
      } => {
        if (item.kind !== "assistant_text") {
          return false;
        }
        if (item.phase !== "completed" && item.phase !== "failed") {
          return false;
        }
        if (item.source !== "commentary" && item.source !== "final_answer") {
          return false;
        }
        if (normalizedSource !== "all" && item.source !== normalizedSource) {
          return false;
        }

        return typeof item.content === "string" && item.content.trim().length > 0;
      })
      .sort((left, right) => compareTimestamps(left.updatedAt, right.updatedAt))
      .map((item) => ({
        id: this.buildStableMessageId(item.runId, item.itemId),
        chatId: item.chatId,
        title: this.buildSessionTitle(session),
        runId: item.runId,
        itemId: item.itemId,
        source: item.source,
        phase: item.phase,
        content: item.content.trim(),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      }));

    const afterIndex = query.afterId
      ? stableMessages.findIndex((item) => item.id === query.afterId)
      : -1;
    const slicedMessages = afterIndex >= 0 ? stableMessages.slice(afterIndex + 1) : stableMessages;
    const limit =
      typeof query.limit === "number" && Number.isFinite(query.limit) && query.limit > 0
        ? Math.floor(query.limit)
        : undefined;
    const messages = limit ? slicedMessages.slice(-limit) : slicedMessages;

    return {
      session: this.buildSessionSummary(
        session,
        this.selectMainPrivateSession(this.sessionStore.list())?.chatId
      ),
      messages
    };
  }

  async sendToMainPrivateSession(input: AgentManagerSendInput): Promise<AgentManagerSendResult> {
    const session = this.selectMainPrivateSession(this.sessionStore.list());
    if (!session) {
      throw new Error("当前还没有可用的私聊主 session。先在飞书里和机器人进行一次私聊。");
    }

    return this.sendToSession(session.chatId, {
      ...input,
      mirrorToFeishu: true
    });
  }

  async sendToSession(chatId: string, input: AgentManagerSendInput): Promise<AgentManagerSendResult> {
    const session = this.sessionStore.get(chatId);
    if (!session) {
      throw new Error(`chatId=${chatId} 的 session 不存在。`);
    }

    const normalized = normalizeSendInput(input);
    const forwardedText = formatForwardedText(normalized.from, normalized.content);
    if (normalized.mirrorToFeishu) {
      await this.feishuClient.sendText({
        chatId,
        content: forwardedText
      });
    }

    const sourceMessageId = `agent-manager:${normalized.source}:${chatId}:${randomUUID()}`;
    this.messageIngress.enqueue({
      chatId,
      chatType: this.inferChatType(session),
      chatName: session.chatName,
      messageId: sourceMessageId,
      senderId: `system:agent-manager:${normalized.source}:${normalized.from}`,
      senderName: normalized.from,
      senderType: "system",
      text: forwardedText,
      mentionsBot: false,
      raw: {
        agentManager: {
          source: normalized.source,
          forwardedText,
          originalContent: normalized.content,
          mirroredToFeishu: normalized.mirrorToFeishu
        }
      }
    });

    return {
      session: this.buildSessionSummary(
        session,
        this.selectMainPrivateSession(this.sessionStore.list())?.chatId
      ),
      sourceMessageId,
      forwardedText,
      mirroredToFeishu: normalized.mirrorToFeishu
    };
  }

  async updateSessionMetadata(chatId?: string): Promise<AgentManagerUpdateResult> {
    if (!this.sessionMetadataProvider) {
      throw new Error("当前没有可用的飞书会话信息 provider，无法执行 update。");
    }

    const targetSessions = chatId
      ? (() => {
          const session = this.sessionStore.get(chatId);
          if (!session) {
            throw new Error(`chatId=${chatId} 的 session 不存在。`);
          }
          return [session];
        })()
      : this.sessionStore.list();

    const results: AgentManagerUpdateItem[] = [];

    for (const session of targetSessions) {
      try {
        const titleBefore = this.buildSessionTitle(session);
        const providerResult = await this.sessionMetadataProvider.refreshSessionMetadata({
          session,
          chatType: this.inferChatType(session)
        });
        const nextSession = this.mergeSessionMetadata(session, providerResult);
        const changedFields = this.collectChangedFields(session, nextSession);

        if (changedFields.length > 0) {
          this.sessionStore.save(nextSession);
        }

        results.push({
          chatId: session.chatId,
          title: this.buildSessionTitle(nextSession) || titleBefore,
          status: changedFields.length > 0 ? "updated" : "unchanged",
          changedFields,
          warnings: providerResult.warnings
        });
      } catch (error) {
        results.push({
          chatId: session.chatId,
          title: this.buildSessionTitle(session),
          status: "failed",
          changedFields: [],
          warnings: [],
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return {
      total: results.length,
      updated: results.filter((item) => item.status === "updated").length,
      unchanged: results.filter((item) => item.status === "unchanged").length,
      failed: results.filter((item) => item.status === "failed").length,
      results
    };
  }

  private selectMainPrivateSession(sessions: ChatSession[]): ChatSession | undefined {
    return sessions
      .filter((session) => this.inferChatType(session) === "p2p")
      .sort((left, right) =>
        compareTimestamps(
          right.lastInboundAt ?? right.updatedAt,
          left.lastInboundAt ?? left.updatedAt
        )
      )[0];
  }

  private buildSessionSummary(
    session: ChatSession,
    mainPrivateChatId?: string
  ): AgentManagedSessionSummary {
    const currentRun = this.resolveRelevantRun(session);
    const chatType = this.inferChatType(session);
    const lastReplyPreview = this.findLastReplyPreview(session, currentRun);
    return {
      chatId: session.chatId,
      chatType,
      title: this.buildSessionTitle(session),
      chatName: session.chatName,
      chatDisplayName: session.chatDisplayName,
      cli: session.cli,
      executionMode: session.executionMode ?? "host",
      workspaceId: session.workspaceId,
      threadId: session.threadId,
      updatedAt: session.updatedAt,
      lastInboundAt: session.lastInboundAt,
      lastSenderName: session.lastSenderName,
      lastMessagePreview: session.lastMessagePreview,
      lastUserMessagePreview: resolveLastUserMessagePreview(session),
      lastReplyPreview,
      activeRunId: session.activeRunId,
      activeTurnId: session.activeTurnId,
      currentRunId: currentRun?.runId,
      runStatus: currentRun?.status ?? "idle",
      focus: this.describeSessionFocus(session, currentRun),
      isMainPrivateSession: session.chatId === mainPrivateChatId
    };
  }

  private buildSessionTitle(session: ChatSession): string {
    return session.chatDisplayName ?? session.chatName ?? session.lastSenderName ?? session.chatId;
  }

  private buildStableMessageId(runId: string, itemId: string): string {
    return `${runId}:${itemId}`;
  }

  private inferChatType(session: ChatSession): string {
    if (session.chatType) {
      return session.chatType;
    }

    return session.workspaceId === this.defaultWorkspace ? "p2p" : "group";
  }

  private resolveRelevantRun(session: ChatSession): RunRecord | undefined {
    if (session.activeRunId) {
      return this.runStore.get(session.activeRunId);
    }

    return this.runStore
      .list()
      .filter((run) => run.chatId === session.chatId)
      .sort((left, right) => compareTimestamps(right.updatedAt, left.updatedAt))[0];
  }

  private describeSessionFocus(session: ChatSession, run?: RunRecord): string {
    if (!run) {
      return session.lastMessagePreview
        ? `空闲，最近消息：${session.lastMessagePreview}`
        : "空闲";
    }

    const items = this.conversationStore.listByRun(run.runId);
    const assistantSummary = this.findAssistantSummary(items);
    const toolSummary = this.findToolSummary(items);

    if (run.status === "running" || run.status === "queued") {
      if (toolSummary) {
        return `正在 ${toolSummary}`;
      }
      if (assistantSummary) {
        return `正在回复：${assistantSummary}`;
      }
      return run.status === "queued" ? "排队中" : "正在处理";
    }

    if (run.status === "failed") {
      return summarizeText(run.errorMessage, 140)
        ? `最近失败：${summarizeText(run.errorMessage, 140)}`
        : "最近失败";
    }

    if (assistantSummary) {
      return `最近完成：${assistantSummary}`;
    }

    return "最近完成";
  }

  private findAssistantSummary(items: ConversationItem[]): string | undefined {
    const assistantItem = [...items]
      .reverse()
      .find((item) => item.kind === "assistant_text" && typeof item.content === "string" && item.content.trim());
    return summarizeText(assistantItem?.content, 140);
  }

  private findLastReplyPreview(session: ChatSession, run?: RunRecord): string | undefined {
    const items = run
      ? this.conversationStore.listByRun(run.runId)
      : this.conversationStore
          .list()
          .filter((item) => item.chatId === session.chatId)
          .sort((left, right) => compareTimestamps(left.updatedAt, right.updatedAt));

    const assistantItem = [...items]
      .reverse()
      .find(
        (item) =>
          item.kind === "assistant_text" &&
          (item.phase === "completed" || item.phase === "failed") &&
          typeof item.content === "string" &&
          item.content.trim()
      );

    return summarizeText(extractLastParagraph(assistantItem?.content), 220);
  }

  private findToolSummary(items: ConversationItem[]): string | undefined {
    const toolItem = [...items]
      .reverse()
      .find((item) => item.kind === "tool_card" && (item.title || item.command || item.details.length > 0));
    return summarizeText(toolItem?.title ?? toolItem?.command ?? toolItem?.details.at(-1), 120);
  }

  private mergeSessionMetadata(
    session: ChatSession,
    providerResult: SessionMetadataProviderResult
  ): ChatSession {
    const patch = providerResult.patch;
    const next: ChatSession = {
      ...session,
      chatType: patch.chatType ?? session.chatType,
      chatName: patch.chatName ?? session.chatName,
      chatDisplayName:
        patch.chatDisplayName ?? patch.chatName ?? session.chatDisplayName ?? session.chatName,
      updatedAt: new Date().toISOString()
    };

    return next;
  }

  private collectChangedFields(current: ChatSession, next: ChatSession): string[] {
    const changed: string[] = [];
    if ((current.chatType ?? "") !== (next.chatType ?? "")) {
      changed.push("chatType");
    }
    if ((current.chatName ?? "") !== (next.chatName ?? "")) {
      changed.push("chatName");
    }
    if ((current.chatDisplayName ?? "") !== (next.chatDisplayName ?? "")) {
      changed.push("chatDisplayName");
    }
    return changed;
  }
}
