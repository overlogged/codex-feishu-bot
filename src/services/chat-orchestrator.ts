import type { ChatSession, IncomingChatMessage } from "../domain/types.js";
import type { CodexWorker } from "../integrations/codex/codex-worker.js";
import type { FeishuMessageClient } from "../integrations/feishu/feishu-message-client.js";
import { ConversationStore } from "../stores/conversation-store.js";
import { RunStore } from "../stores/run-store.js";
import { SessionStore } from "../stores/session-store.js";
import type { ChatWorkspaceResolver } from "./chat-workspace-resolver.js";
import { ConversationDeliveryService } from "./conversation-delivery-service.js";
import { MessageProjector } from "./message-projector.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

const WORKSPACE_CATALOG_COMMAND = /^(工作区|workspace|workspaces)$/i;

function isWorkspaceCatalogCommand(text: string): boolean {
  return WORKSPACE_CATALOG_COMMAND.test(text.trim());
}

function extractGroupBindingCode(message: IncomingChatMessage): string | undefined {
  if (message.chatType !== "group" || !message.mentionsBot) {
    return undefined;
  }

  const strippedText = message.text.replace(/@\S+/g, " ").trim();
  return /^\d+$/.test(strippedText) ? strippedText : undefined;
}

export class ChatOrchestrator {
  private readonly seenIncomingMessages = new Map<string, number>();

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly runStore: RunStore,
    private readonly conversationStore: ConversationStore,
    private readonly feishuClient: FeishuMessageClient,
    private readonly deliveryService: ConversationDeliveryService,
    private readonly projector: MessageProjector,
    private readonly codexWorker: CodexWorker,
    private readonly workspaceResolver: ChatWorkspaceResolver,
    private readonly defaultWorkspace: string,
    private readonly logger: LoggerLike
  ) {}

  enqueue(message: IncomingChatMessage): void {
    if (message.senderType === "app" || message.senderType === "bot") {
      this.logger.info(
        {
          chatId: message.chatId,
          messageId: message.messageId,
          chatType: message.chatType,
          senderType: message.senderType
        },
        "忽略机器人自己发出的消息"
      );
      return;
    }

    if (this.isDuplicateIncomingMessage(message)) {
      this.logger.warn(
        {
          chatId: message.chatId,
          messageId: message.messageId,
          chatType: message.chatType,
          senderId: message.senderId
        },
        "忽略重复投递的飞书消息事件"
      );
      return;
    }

    this.logger.info(
      {
        chatId: message.chatId,
        messageId: message.messageId,
        chatType: message.chatType,
        senderId: message.senderId,
        textPreview: message.text.slice(0, 120)
      },
      "收到飞书消息，准备进入编排处理"
    );

    void this.processIncomingMessage(message);
  }

  private async processIncomingMessage(message: IncomingChatMessage): Promise<void> {
    if (await this.handleWorkspaceManagementMessage(message)) {
      return;
    }

    const existingSession = this.sessionStore.get(message.chatId);
    const workspaceResolution = await this.workspaceResolver.resolve({
      message,
      session: existingSession
    });

    if (!workspaceResolution.ok) {
      this.logger.warn(
        {
          chatId: message.chatId,
          messageId: message.messageId,
          chatType: message.chatType,
          reason: workspaceResolution.reason,
          configuredWorkspace: workspaceResolution.configuredWorkspace,
          resolvedWorkspace: workspaceResolution.resolvedWorkspace,
          configFilePath: workspaceResolution.configFilePath
        },
        "群消息未命中有效工作区配置，已拒绝启动任务"
      );
      await this.notifyWorkspaceRequirement(message, workspaceResolution.detail);
      return;
    }

    if (
      existingSession?.activeRunId &&
      this.codexWorker.steerTurn &&
      existingSession.workspaceId === workspaceResolution.workspaceId
    ) {
      await this.dispatchActiveOrNew(existingSession, message, workspaceResolution.workspaceId);
      return;
    }

    await this.handleMessage(message, workspaceResolution.workspaceId);
  }

  private async handleMessage(message: IncomingChatMessage, workspaceId?: string): Promise<void> {
    const existingSession = this.sessionStore.get(message.chatId);
    const resolvedWorkspaceId = workspaceId ?? existingSession?.workspaceId ?? this.defaultWorkspace;
    const reusableSession =
      existingSession?.workspaceId === resolvedWorkspaceId ? existingSession : undefined;
    const threadId = reusableSession
      ? await this.codexWorker.ensureThread({
          session: reusableSession,
          workspaceId: resolvedWorkspaceId,
          message
        })
      : `pending:${message.chatId}:${Date.now()}`;

    this.sessionStore.save({
      chatId: message.chatId,
      threadId,
      workspaceId: resolvedWorkspaceId,
      activeRunId: reusableSession?.activeRunId,
      activeTurnId: reusableSession?.activeTurnId,
      updatedAt: new Date().toISOString()
    });

    const run = this.runStore.create({
      chatId: message.chatId,
      threadId,
      sourceMessageId: message.messageId
    });

    this.sessionStore.attachRun(message.chatId, run.runId);

    try {
      for await (const event of this.codexWorker.runTurn({
        session: this.sessionStore.get(message.chatId),
        workspaceId: resolvedWorkspaceId,
        message,
        threadId
      })) {
        if (event.kind === "turn_bound") {
          this.sessionStore.bindTurn(message.chatId, event.turnId);
          continue;
        }

        const result = this.projector.apply(run.runId, event);
        this.sessionStore.save({
          chatId: message.chatId,
          threadId: result.run.threadId,
          workspaceId: resolvedWorkspaceId,
          activeRunId: run.runId,
          activeTurnId: this.sessionStore.get(message.chatId)?.activeTurnId,
          updatedAt: new Date().toISOString()
        });

        for (const item of result.items) {
          this.logger.info(
            {
              runId: run.runId,
              chatId: message.chatId,
              itemId: item.itemId,
              kind: item.kind,
              phase: item.phase,
              feishuMessageId: item.feishuMessageId
            },
            "消息投影已更新，准备同步飞书"
          );
          this.deliveryService.schedule(item);
        }
      }
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : "处理过程中发生未知错误";
      const result = this.projector.apply(run.runId, {
        kind: "error",
        message: messageText
      });
      for (const item of result.items) {
        this.deliveryService.schedule(item);
      }
      this.logger.error(
        {
          runId: run.runId,
          chatId: message.chatId,
          error: messageText
        },
        "处理飞书消息失败"
      );
    } finally {
      await this.deliveryService.flushRun(run.runId).catch((error) => {
        this.logger.error(
          {
            runId: run.runId,
            chatId: message.chatId,
            error: error instanceof Error ? error.message : String(error)
          },
          "刷新 run 对应的飞书消息失败"
        );
      });
      this.sessionStore.releaseRun(message.chatId);
    }
  }

  private async steerMessage(messageSession: ReturnType<SessionStore["get"]>, message: IncomingChatMessage) {
    if (!messageSession?.activeRunId || !messageSession.activeTurnId) {
      await this.handleMessage(message);
      return;
    }

    const workspaceId = messageSession.workspaceId ?? this.defaultWorkspace;
    this.logger.info(
      {
        chatId: message.chatId,
        messageId: message.messageId,
        threadId: messageSession.threadId,
        turnId: messageSession.activeTurnId,
        activeRunId: messageSession.activeRunId,
        textPreview: message.text.slice(0, 160)
      },
      "检测到活跃 Codex turn，直接 steer 新消息"
    );

    this.runStore.update(messageSession.activeRunId, {
      sourceMessageId: message.messageId
    });

    try {
      await this.codexWorker.steerTurn?.({
        session: messageSession,
        workspaceId,
        message,
        threadId: messageSession.threadId,
        turnId: messageSession.activeTurnId
      });
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        {
          chatId: message.chatId,
          messageId: message.messageId,
          threadId: messageSession.threadId,
          turnId: messageSession.activeTurnId,
          activeRunId: messageSession.activeRunId,
          error: errorText
        },
        "steer 失败，退回启动新 turn"
      );

      this.sessionStore.releaseRun(message.chatId);
      await this.handleMessage(message);
    }
  }

  private async dispatchActiveOrNew(
    initialSession: ReturnType<SessionStore["get"]>,
    message: IncomingChatMessage,
    workspaceId: string
  ): Promise<void> {
    let session = initialSession;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (!session?.activeRunId) {
        break;
      }

      if (session.activeTurnId) {
        await this.steerMessage(session, message);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
      session = this.sessionStore.get(message.chatId);
    }

    await this.handleMessage(message, workspaceId);
  }

  getDebugState() {
    return {
      sessions: this.sessionStore.list(),
      runs: this.runStore.list(),
      items: this.conversationStore.list()
    };
  }

  private async handleWorkspaceManagementMessage(message: IncomingChatMessage): Promise<boolean> {
    if (message.chatType === "p2p" && isWorkspaceCatalogCommand(message.text)) {
      const entries = await this.workspaceResolver.listCatalog();
      const content =
        entries.length === 0
          ? [
              `当前在 ${this.defaultWorkspace} 下没有可绑定的子目录。`,
              "请先创建目录后，再回来发送“工作区”。"
            ].join("\n")
          : [
              `可绑定的工作区编号如下，根目录是 ${this.defaultWorkspace}：`,
              ...entries.map((entry) => `${entry.code}. ${entry.workspace}`),
              "",
              "在目标群里 @机器人 发送编号即可绑定，例如：@机器人 12"
            ].join("\n");
      await this.notifyWorkspaceRequirement(message, content);
      return true;
    }

    const bindingCode = extractGroupBindingCode(message);
    if (!bindingCode) {
      return false;
    }

    const result = await this.workspaceResolver.bindGroupWorkspace({
      chatId: message.chatId,
      code: bindingCode
    });
    if (!result.ok) {
      await this.notifyWorkspaceRequirement(message, result.detail);
      return true;
    }

    await this.notifyWorkspaceRequirement(
      message,
      `已将这个群绑定到工作区 ${result.entry.code}: ${result.entry.workspace}\n后续这个群里的任务都会从 ${result.entry.workspaceId} 启动。`
    );
    return true;
  }

  private isDuplicateIncomingMessage(message: IncomingChatMessage): boolean {
    const now = Date.now();
    const ttlMs = 6 * 60 * 60 * 1000;

    for (const [key, timestamp] of this.seenIncomingMessages) {
      if (now - timestamp > ttlMs) {
        this.seenIncomingMessages.delete(key);
      }
    }

    const key = `${message.chatId}:${message.messageId}`;
    if (this.seenIncomingMessages.has(key)) {
      return true;
    }

    this.seenIncomingMessages.set(key, now);
    return false;
  }

  private async notifyWorkspaceRequirement(message: IncomingChatMessage, content: string): Promise<void> {
    try {
      await this.feishuClient.sendText({
        chatId: message.chatId,
        content
      });
    } catch (error) {
      this.logger.error(
        {
          chatId: message.chatId,
          messageId: message.messageId,
          error: error instanceof Error ? error.message : String(error)
        },
        "发送工作区配置提示失败"
      );
    }
  }
}
