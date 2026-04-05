import type {
  ChatCli,
  ChatExecutionMode,
  ChatSession,
  IncomingChatMessage,
  ScheduledTaskRecord
} from "../domain/types.js";
import type { CodexWorker } from "../integrations/codex/codex-worker.js";
import type { FeishuMessageClient } from "../integrations/feishu/feishu-message-client.js";
import { ConversationStore } from "../stores/conversation-store.js";
import { RunStore } from "../stores/run-store.js";
import { SessionStore } from "../stores/session-store.js";
import {
  ChatScheduleService,
  formatScheduleTime,
  type ScheduledTaskTriggerResult
} from "./chat-schedule-service.js";
import {
  type GroupControlAgent,
  type GroupControlIntent
} from "./group-control-agent.js";
import type { ChatWorkspaceResolver } from "./chat-workspace-resolver.js";
import { ConversationDeliveryService } from "./conversation-delivery-service.js";
import { MessageProjector } from "./message-projector.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

const WORKSPACE_CATALOG_COMMAND = /^(工作区|workspace|workspaces)$/i;
const SCHEDULE_COMMAND = /^(定时任务|schedule|schedules)(?:\s+(.+))?$/i;
const NEW_SESSION_COMMAND = /^(新会话|new\s+session|reset\s+session)$/i;

type ScheduleCommand =
  | {
      kind: "list";
    }
  | {
      kind: "add";
      cron: string;
      prompt: string;
    }
  | {
      kind: "delete" | "pause" | "resume";
      taskId: string;
    }
  | {
      kind: "help";
      detail: string;
    };

function stripMentions(text: string): string {
  return text.replace(/@\S+/g, " ").trim();
}

function isWorkspaceCatalogCommand(text: string): boolean {
  return WORKSPACE_CATALOG_COMMAND.test(text.trim());
}

function renderCliLabel(cli: ChatCli): string {
  switch (cli) {
    case "claude":
      return "Claude";
    case "kimi":
      return "Kimi";
    case "codex":
    default:
      return "Codex";
  }
}

function renderExecutionModeLabel(executionMode: ChatExecutionMode): string {
  return executionMode === "docker" ? "Docker" : "Host";
}

function extractGroupBindingCommand(
  message: IncomingChatMessage
): { code: string; cli: ChatCli; executionMode: ChatExecutionMode } | undefined {
  if (message.chatType !== "group" || !message.mentionsBot) {
    return undefined;
  }

  const strippedText = stripMentions(message.text);
  const parts = strippedText.split(/\s+/).filter(Boolean);
  const code = parts.find((part) => /^\d+$/.test(part));
  if (!code) {
    return undefined;
  }

  const cli = parts
    .map((part) => part.toLowerCase())
    .find((part): part is ChatCli => part === "codex" || part === "claude" || part === "kimi");
  const executionMode = parts
    .map((part) => part.toLowerCase())
    .find((part): part is ChatExecutionMode => part === "host" || part === "docker");

  if (parts.length === 1 && code === parts[0]) {
    return {
      code,
      cli: "codex",
      executionMode: "host"
    };
  }

  if (parts.length > 3) {
    return undefined;
  }

  return {
    code,
    cli: cli ?? "codex",
    executionMode: executionMode ?? "host"
  };
}

function parseScheduleCommand(message: IncomingChatMessage): ScheduleCommand | undefined {
  const commandText = stripMentions(message.text);
  const matched = commandText.match(SCHEDULE_COMMAND);
  if (!matched) {
    return undefined;
  }

  const action = matched[2]?.trim();
  if (!action || /^(列表|list|ls)$/i.test(action)) {
    return {
      kind: "list"
    };
  }

  if (/^(帮助|help)$/i.test(action)) {
    return {
      kind: "help",
      detail: "请使用“定时任务 添加 <cron> | <任务内容>”或“定时任务 列表”。"
    };
  }

  const addMatch = action.match(/^(添加|add)\s+(.+)$/i);
  if (addMatch) {
    const payload = addMatch[2];
    if (!payload) {
      return {
        kind: "help",
        detail: "添加命令格式不对。请使用：定时任务 添加 0 9 * * 1-5 | 生成工作日报"
      };
    }
    const separatorIndex = payload.search(/\s*[|｜]\s*/);
    if (separatorIndex < 0) {
      return {
        kind: "help",
        detail: "添加命令格式不对。请使用：定时任务 添加 0 9 * * 1-5 | 生成工作日报"
      };
    }

    const cron = payload.slice(0, separatorIndex).trim();
    const prompt = payload.slice(separatorIndex + 1).replace(/^[|｜]\s*/, "").trim();
    if (!cron || !prompt) {
      return {
        kind: "help",
        detail: "添加命令格式不对。请使用：定时任务 添加 0 9 * * 1-5 | 生成工作日报"
      };
    }

    return {
      kind: "add",
      cron,
      prompt
    };
  }

  const deleteMatch = action.match(/^(删除|delete|del|rm)\s+(\d+)$/i);
  if (deleteMatch) {
    return {
      kind: "delete",
      taskId: deleteMatch[2]!
    };
  }

  const pauseMatch = action.match(/^(暂停|pause|stop)\s+(\d+)$/i);
  if (pauseMatch) {
    return {
      kind: "pause",
      taskId: pauseMatch[2]!
    };
  }

  const resumeMatch = action.match(/^(启用|恢复|resume|enable)\s+(\d+)$/i);
  if (resumeMatch) {
    return {
      kind: "resume",
      taskId: resumeMatch[2]!
    };
  }

  return {
    kind: "help",
    detail: "不支持这个定时任务命令。可用操作：列表、添加、暂停、启用、删除。"
  };
}

function renderScheduleHelp(): string {
  return [
    "这个群支持这些定时任务命令：",
    "1. @机器人 定时任务 添加 0 9 * * 1-5 | 生成工作日报",
    "2. @机器人 定时任务 暂停 1",
    "3. @机器人 定时任务 启用 1",
    "4. @机器人 定时任务 删除 1",
    "5. @机器人 定时任务",
    "",
    "定时任务当前使用显式 cron，不再走单独的群控制线程。"
  ].join("\n");
}

function renderControlHelp(defaultWorkspace: string): string {
  return [
    "群里可以直接发普通消息，也可以 @机器人。",
    "@机器人 不会再切到单独控制线程；它会继续走这个群当前绑定的会话。",
    "",
    "常见命令：",
    "1. 私聊机器人发送 工作区，先拿目录编号",
    "2. 群里发 @机器人 12",
    "3. 群里发 @机器人 claude 12",
    "4. 群里发 @机器人 docker 12",
    "5. 群里发 @机器人 新会话",
    "6. 群里发 @机器人 定时任务 添加 0 9 * * 1-5 | 生成工作日报",
    "",
    "执行模式默认是 host；如果明确说 docker，就会进入受限容器模式。",
    `工作区根目录是 ${defaultWorkspace}，只列一级子目录。`
  ].join("\n");
}

function renderWorkspaceCatalogMessage(
  entries: Awaited<ReturnType<ChatWorkspaceResolver["listCatalog"]>>,
  defaultWorkspace: string
): string {
  return entries.length === 0
    ? [
        `当前在 ${defaultWorkspace} 下没有可绑定的子目录。`,
        "请先创建一级子目录后，再回来 @机器人 查看工作区。"
      ].join("\n")
    : [
        `可绑定的工作区编号如下，根目录是 ${defaultWorkspace}：`,
        ...entries.map((entry) => `${entry.code}. ${entry.workspace}`),
        "",
        "支持的 CLI：codex / claude / kimi",
        "你可以直接说：",
        "@机器人 把这个群绑定到 codex 的 2 号目录",
        "@机器人 把这个群切到 claude 的 Quant"
      ].join("\n");
}

function buildThreadReplyMetadata(_message: IncomingChatMessage): {
  replyToMessageId?: string;
  replyInThread?: boolean;
} {
  return {};
}

function summarizeMessagePreview(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.slice(0, 160);
}

function normalizeExecutionMode(value: ChatExecutionMode | undefined): ChatExecutionMode {
  return value === "docker" ? "docker" : "host";
}

function isHumanMessage(message: IncomingChatMessage): boolean {
  return (
    message.senderType !== "system" &&
    message.senderType !== "app" &&
    message.senderType !== "bot"
  );
}

function resolveChatDisplayName(
  message: IncomingChatMessage,
  existingSession?: ChatSession
): string | undefined {
  const existingDisplayName = existingSession?.chatDisplayName ?? existingSession?.chatName;

  if (message.chatType === "group") {
    return message.chatName ?? existingDisplayName;
  }

  if (message.chatType === "p2p") {
    if (message.chatName) {
      return message.chatName;
    }

    if (
      message.senderType !== "system" &&
      message.senderType !== "app" &&
      message.senderType !== "bot" &&
      message.senderName.trim()
    ) {
      return message.senderName;
    }

    return existingDisplayName;
  }

  return message.chatName ?? existingDisplayName;
}

function buildSessionMetadataPatch(
  message: IncomingChatMessage,
  existingSession?: ChatSession,
  observedAt = new Date().toISOString()
): Pick<
  ChatSession,
  | "chatType"
  | "chatName"
  | "chatDisplayName"
  | "lastInboundAt"
  | "lastSenderId"
  | "lastSenderName"
  | "lastMessageId"
  | "lastMessagePreview"
  | "lastUserMessagePreview"
> {
  const messagePreview = summarizeMessagePreview(message.text);
  const lastUserMessagePreview = isHumanMessage(message)
    ? messagePreview ?? existingSession?.lastUserMessagePreview
    : existingSession?.lastUserMessagePreview;

  return {
    chatType: message.chatType || existingSession?.chatType,
    chatName: message.chatName ?? existingSession?.chatName,
    chatDisplayName: resolveChatDisplayName(message, existingSession),
    lastInboundAt: observedAt,
    lastSenderId: message.senderId || existingSession?.lastSenderId,
    lastSenderName: message.senderName || existingSession?.lastSenderName,
    lastMessageId: message.messageId || existingSession?.lastMessageId,
    lastMessagePreview: messagePreview ?? existingSession?.lastMessagePreview,
    lastUserMessagePreview
  };
}

function renderScheduleList(tasks: ScheduledTaskRecord[]): string {
  if (tasks.length === 0) {
    return [renderScheduleHelp(), "", "这个群目前还没有定时任务。"].join("\n");
  }

  return [
    "这个群当前的定时任务：",
    ...tasks.map((task) =>
      [
        `${task.taskId}. ${task.status === "enabled" ? "启用" : "暂停"} | ${task.cron}`,
        `下次触发：${task.status === "enabled" ? formatScheduleTime(task.nextRunAt) : "已暂停"}`,
        `任务内容：${task.prompt}`,
        task.lastTriggeredAt ? `上次触发：${formatScheduleTime(task.lastTriggeredAt)}` : undefined,
        task.lastError ? `最近错误：${task.lastError}` : undefined
      ]
        .filter(Boolean)
        .join("\n")
    ),
    "",
    renderScheduleHelp()
  ].join("\n\n");
}

function isNewSessionCommand(message: IncomingChatMessage): boolean {
  return NEW_SESSION_COMMAND.test(stripMentions(message.text));
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
    private readonly scheduleService: ChatScheduleService,
    private readonly defaultWorkspace: string,
    private readonly logger: LoggerLike,
    private readonly groupControlAgent: GroupControlAgent = {
      async interpret() {
        return {
          kind: "help",
          detail: "这个环境还没有配置群控制 agent。"
        };
      }
    }
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
    this.touchExistingSession(message);

    if (await this.handleControlMessage(message)) {
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
      await this.sendTextNotice(message.chatId, workspaceResolution.detail, {
        messageId: message.messageId,
        context: "发送工作区配置提示失败"
      });
      return;
    }

    if (
      existingSession?.activeRunId &&
      this.canSteer({
        session: existingSession,
        cli: workspaceResolution.cli,
        workspaceId: workspaceResolution.workspaceId,
        executionMode: workspaceResolution.executionMode,
        message
      }) &&
      existingSession.workspaceId === workspaceResolution.workspaceId &&
      existingSession.cli === workspaceResolution.cli &&
      normalizeExecutionMode(existingSession.executionMode) === workspaceResolution.executionMode
    ) {
      await this.dispatchActiveOrNew(existingSession, message, {
        cli: workspaceResolution.cli,
        workspaceId: workspaceResolution.workspaceId,
        executionMode: workspaceResolution.executionMode
      });
      return;
    }

    await this.handleMessage(message, workspaceResolution);
  }

  private async handleMessage(
    message: IncomingChatMessage,
    routing?: {
      workspaceId: string;
      cli: ChatCli;
      executionMode: ChatExecutionMode;
    }
  ): Promise<void> {
    const existingSession = this.sessionStore.get(message.chatId);
    const resolvedWorkspaceId = routing?.workspaceId ?? existingSession?.workspaceId ?? this.defaultWorkspace;
    const resolvedCli = routing?.cli ?? existingSession?.cli ?? "codex";
    const resolvedExecutionMode =
      routing?.executionMode ?? normalizeExecutionMode(existingSession?.executionMode);
    const reusableSession =
      existingSession?.workspaceId === resolvedWorkspaceId &&
      existingSession.cli === resolvedCli &&
      normalizeExecutionMode(existingSession.executionMode) === resolvedExecutionMode
        ? existingSession
        : undefined;
    const threadId = reusableSession
      ? await this.codexWorker.ensureThread({
          session: reusableSession,
          cli: resolvedCli,
          workspaceId: resolvedWorkspaceId,
          executionMode: resolvedExecutionMode,
          message
        })
      : `pending:${message.chatId}:${Date.now()}`;
    const observedAt = new Date().toISOString();

    this.sessionStore.save({
      chatId: message.chatId,
      threadId,
      cli: resolvedCli,
      workspaceId: resolvedWorkspaceId,
      executionMode: resolvedExecutionMode,
      ...buildSessionMetadataPatch(message, reusableSession ?? existingSession, observedAt),
      activeRunId: reusableSession?.activeRunId,
      activeTurnId: reusableSession?.activeTurnId,
      updatedAt: observedAt
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
        cli: resolvedCli,
        workspaceId: resolvedWorkspaceId,
        executionMode: resolvedExecutionMode,
        message,
        threadId
      })) {
        if (event.kind === "turn_bound") {
          this.sessionStore.bindTurn(message.chatId, event.turnId, run.runId);
          continue;
        }

        const result = this.projector.apply(run.runId, event);
        this.sessionStore.updateBoundRun(message.chatId, run.runId, {
          threadId: result.run.threadId,
          cli: resolvedCli,
          workspaceId: resolvedWorkspaceId,
          executionMode: resolvedExecutionMode
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
      this.sessionStore.releaseRun(message.chatId, run.runId);
    }
  }

  private async steerMessage(messageSession: ReturnType<SessionStore["get"]>, message: IncomingChatMessage) {
    if (!messageSession?.activeRunId || !messageSession.activeTurnId) {
      await this.handleMessage(message);
      return;
    }

    const workspaceId = messageSession.workspaceId ?? this.defaultWorkspace;
    const executionMode = normalizeExecutionMode(messageSession.executionMode);
    this.sessionStore.updateBoundRun(
      message.chatId,
      messageSession.activeRunId,
      buildSessionMetadataPatch(message, messageSession)
    );
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
        cli: messageSession.cli,
        workspaceId,
        executionMode,
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
    routing: {
      workspaceId: string;
      cli: ChatCli;
      executionMode: ChatExecutionMode;
    }
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

    await this.handleMessage(message, routing);
  }

  getDebugState() {
    return {
      sessions: this.sessionStore.list(),
      runs: this.runStore.list(),
      items: this.conversationStore.list(),
      scheduledTasks: this.scheduleService.list()
    };
  }

  async triggerScheduledTask(task: ScheduledTaskRecord): Promise<ScheduledTaskTriggerResult> {
    const message = this.createScheduledTaskMessage(task);
    const existingSession = this.sessionStore.get(task.chatId);
    const workspaceResolution = await this.workspaceResolver.resolve({
      message,
      session: existingSession
    });

    if (!workspaceResolution.ok) {
      const pauseMessage = [
        `定时任务 ${task.taskId} 已自动暂停，因为它当前没有可用工作区。`,
        workspaceResolution.detail,
        `修复后在群里发送“定时任务 启用 ${task.taskId}”即可恢复。`
      ].join("\n");
      await this.sendTextNotice(task.chatId, pauseMessage, {
        messageId: message.messageId,
        context: "发送定时任务暂停提示失败"
      });
      return {
        outcome: "pause",
        reason: workspaceResolution.detail
      };
    }

    if (
      existingSession?.activeRunId &&
      this.canSteer({
        session: existingSession,
        cli: workspaceResolution.cli,
        workspaceId: workspaceResolution.workspaceId,
        executionMode: workspaceResolution.executionMode,
        message
      }) &&
      existingSession.workspaceId === workspaceResolution.workspaceId &&
      existingSession.cli === workspaceResolution.cli &&
      normalizeExecutionMode(existingSession.executionMode) === workspaceResolution.executionMode
    ) {
      await this.dispatchActiveOrNew(existingSession, message, {
        cli: workspaceResolution.cli,
        workspaceId: workspaceResolution.workspaceId,
        executionMode: workspaceResolution.executionMode
      });
      return {
        outcome: "triggered"
      };
    }

    await this.handleMessage(message, workspaceResolution);
    return {
      outcome: "triggered"
    };
  }

  private async handleControlMessage(message: IncomingChatMessage): Promise<boolean> {
    if (message.chatType === "p2p" && isWorkspaceCatalogCommand(message.text)) {
      const entries = await this.workspaceResolver.listCatalog();
      const content = renderWorkspaceCatalogMessage(entries, this.defaultWorkspace);
      await this.sendTextNotice(message.chatId, content, {
        messageId: message.messageId,
        context: "发送工作区配置提示失败"
      });
      return true;
    }

    if (isNewSessionCommand(message)) {
      await this.handleNewSessionCommand(message);
      return true;
    }

    const scheduleCommand = parseScheduleCommand(message);
    if (scheduleCommand) {
      await this.handleScheduleCommand(message, scheduleCommand);
      return true;
    }

    const bindingCommand = extractGroupBindingCommand(message);
    if (!bindingCommand) {
      return false;
    }

    const result = await this.workspaceResolver.bindGroupWorkspace({
      chatId: message.chatId,
      cli: bindingCommand.cli,
      executionMode: bindingCommand.executionMode,
      code: bindingCommand.code
    });
    if (!result.ok) {
      await this.sendTextNotice(message.chatId, result.detail, {
        messageId: message.messageId,
        context: "发送工作区配置提示失败"
      });
      return true;
    }

    await this.sendTextNotice(
      message.chatId,
      [
        `已将这个群绑定到 ${renderExecutionModeLabel(result.executionMode)} 模式的 ${renderCliLabel(result.cli)} CLI 工作区 ${result.entry.code}: ${result.entry.workspace}`,
        `后续这个群里的任务都会通过 ${result.executionMode} / ${result.cli} 从 ${result.entry.workspaceId} 启动。`
      ].join("\n"),
      {
        messageId: message.messageId,
        context: "发送工作区配置提示失败"
      }
    );
    return true;
  }

  private async handleGroupMentionControlMessage(message: IncomingChatMessage): Promise<void> {
    const replyMetadata = buildThreadReplyMetadata(message);
    const existingSession = this.sessionStore.get(message.chatId);
    const currentBindingResolution = await this.workspaceResolver.resolve({
      message,
      session: existingSession
    });
    const catalog = await this.workspaceResolver.listCatalog();

    let intent: GroupControlIntent;
    try {
      intent = await this.groupControlAgent.interpret(message, {
        catalog,
        scheduledTasks: this.scheduleService.listByChat(message.chatId),
        currentBinding: currentBindingResolution.ok
          ? {
              configured: true,
              cli: currentBindingResolution.cli,
              executionMode: currentBindingResolution.executionMode,
              workspaceId: currentBindingResolution.workspaceId
            }
          : {
              configured: false,
              detail: currentBindingResolution.detail
            }
      });
    } catch (error) {
      await this.sendTextNotice(
        message.chatId,
        [
          error instanceof Error ? `配置 agent 处理失败：${error.message}` : "配置 agent 处理失败。",
          "",
          renderControlHelp(this.defaultWorkspace)
        ].join("\n"),
        {
          messageId: message.messageId,
          context: "发送配置 agent 失败提示失败",
          ...replyMetadata
        }
      );
      return;
    }

    switch (intent.kind) {
      case "list_workspaces":
        await this.sendTextNotice(
          message.chatId,
          renderWorkspaceCatalogMessage(catalog, this.defaultWorkspace),
          {
            messageId: message.messageId,
            context: "发送工作区目录列表失败",
            ...replyMetadata
          }
        );
        return;
      case "show_binding":
        await this.sendTextNotice(
          message.chatId,
          currentBindingResolution.ok
            ? [
                "这个群当前已经绑定工作区。",
                `CLI：${currentBindingResolution.cli}`,
                `模式：${currentBindingResolution.executionMode}`,
                `工作区：${currentBindingResolution.workspaceId}`
              ].join("\n")
            : currentBindingResolution.detail,
          {
            messageId: message.messageId,
            context: "发送当前绑定状态失败",
            ...replyMetadata
          }
        );
        return;
      case "bind_workspace": {
        const result = await this.workspaceResolver.bindGroupWorkspace({
          chatId: message.chatId,
          cli: intent.cli,
          executionMode: intent.executionMode,
          code: intent.code
        });
        await this.sendTextNotice(
          message.chatId,
          result.ok
            ? [
                `已将这个群绑定到 ${renderExecutionModeLabel(result.executionMode)} 模式的 ${renderCliLabel(result.cli)} CLI 工作区 ${result.entry.code}: ${result.entry.workspace}`,
                `后续普通群消息会通过 ${result.executionMode} / ${result.cli} 从 ${result.entry.workspaceId} 启动。`,
                "群里 @机器人的普通消息也会继续走这个群当前绑定的会话。"
              ].join("\n")
            : [result.detail, "", renderWorkspaceCatalogMessage(catalog, this.defaultWorkspace)].join("\n"),
          {
            messageId: message.messageId,
            context: "发送工作区配置提示失败",
            ...replyMetadata
          }
        );
        return;
      }
      case "list_schedules":
        await this.sendTextNotice(message.chatId, renderScheduleList(this.scheduleService.listByChat(message.chatId)), {
          messageId: message.messageId,
          context: "发送定时任务列表失败",
          ...replyMetadata
        });
        return;
      case "create_schedule":
        await this.handleScheduleCommand(
          message,
          {
            kind: "add",
            cron: intent.cron,
            prompt: intent.prompt
          },
          replyMetadata
        );
        return;
      case "pause_schedule":
        await this.handleScheduleCommand(
          message,
          {
            kind: "pause",
            taskId: intent.taskId
          },
          replyMetadata
        );
        return;
      case "resume_schedule":
        await this.handleScheduleCommand(
          message,
          {
            kind: "resume",
            taskId: intent.taskId
          },
          replyMetadata
        );
        return;
      case "delete_schedule":
        await this.handleScheduleCommand(
          message,
          {
            kind: "delete",
            taskId: intent.taskId
          },
          replyMetadata
        );
        return;
      case "new_session":
        await this.handleNewSessionCommand(message, replyMetadata);
        return;
      case "help":
      default:
        await this.sendTextNotice(
          message.chatId,
          [intent.detail, "", renderControlHelp(this.defaultWorkspace), "", renderScheduleHelp()].join("\n"),
          {
            messageId: message.messageId,
            context: "发送配置帮助失败",
            ...replyMetadata
          }
        );
    }
  }

  private async handleScheduleCommand(
    message: IncomingChatMessage,
    command: ScheduleCommand,
    replyMetadata: {
      replyToMessageId?: string;
      replyInThread?: boolean;
    } = {}
  ): Promise<void> {
    if (message.chatType !== "group") {
      await this.sendTextNotice(message.chatId, "请在目标群里管理这个群自己的定时任务。", {
        messageId: message.messageId,
        context: "发送定时任务提示失败",
        ...replyMetadata
      });
      return;
    }

    if (command.kind === "help") {
      await this.sendTextNotice(message.chatId, [command.detail, "", renderScheduleHelp()].join("\n"), {
        messageId: message.messageId,
        context: "发送定时任务提示失败",
        ...replyMetadata
      });
      return;
    }

    if (command.kind === "list") {
      await this.sendTextNotice(message.chatId, renderScheduleList(this.scheduleService.listByChat(message.chatId)), {
        messageId: message.messageId,
        context: "发送定时任务列表失败",
        ...replyMetadata
      });
      return;
    }

    if (command.kind === "add") {
      const routing = await this.ensureGroupWorkspaceAvailable(message, replyMetadata);
      if (!routing) {
        return;
      }

      const result = this.scheduleService.createTask({
        chatId: message.chatId,
        cron: command.cron,
        prompt: command.prompt,
        createdById: message.senderId,
        createdByName: message.senderName
      });
      const content = result.ok
        ? [
          `已创建这个群的定时任务 ${result.task.taskId}。`,
          `cron：${result.task.cron}`,
          `下次触发：${formatScheduleTime(result.task.nextRunAt)}`,
          `CLI：${routing.cli}`,
          `模式：${routing.executionMode}`,
          `工作区：${routing.workspaceId}`,
          `任务内容：${result.task.prompt}`
        ].join("\n")
        : [result.detail, "", renderScheduleHelp()].join("\n");
      await this.sendTextNotice(message.chatId, content, {
        messageId: message.messageId,
        context: "发送定时任务创建结果失败",
        ...replyMetadata
      });
      return;
    }

    if (command.kind === "delete") {
      const result = this.scheduleService.deleteTask(message.chatId, command.taskId);
      const content = result.ok
        ? `已删除这个群的定时任务 ${result.task.taskId}。`
        : result.detail;
      await this.sendTextNotice(message.chatId, content, {
        messageId: message.messageId,
        context: "发送定时任务删除结果失败",
        ...replyMetadata
      });
      return;
    }

    if (command.kind === "pause") {
      const result = this.scheduleService.pauseTask(message.chatId, command.taskId);
      const content = result.ok
        ? `已暂停这个群的定时任务 ${result.task.taskId}。`
        : result.detail;
      await this.sendTextNotice(message.chatId, content, {
        messageId: message.messageId,
        context: "发送定时任务暂停结果失败",
        ...replyMetadata
      });
      return;
    }

    const routing = await this.ensureGroupWorkspaceAvailable(message, replyMetadata);
    if (!routing) {
      return;
    }

    const result = this.scheduleService.resumeTask(message.chatId, command.taskId);
    const content = result.ok
      ? [
          `已启用这个群的定时任务 ${result.task.taskId}。`,
          `下次触发：${formatScheduleTime(result.task.nextRunAt)}`,
          `CLI：${routing.cli}`,
          `模式：${routing.executionMode}`,
          `工作区：${routing.workspaceId}`
        ].join("\n")
      : result.detail;
    await this.sendTextNotice(message.chatId, content, {
      messageId: message.messageId,
      context: "发送定时任务启用结果失败",
      ...replyMetadata
    });
  }

  private async handleNewSessionCommand(
    message: IncomingChatMessage,
    replyMetadata: {
      replyToMessageId?: string;
      replyInThread?: boolean;
    } = {}
  ): Promise<void> {
    const existingSession = this.sessionStore.get(message.chatId);
    let interruptedActiveRun = false;

    if (existingSession?.activeRunId) {
      const interruption = await this.interruptActiveRunForNewSession(existingSession, message);
      if (!interruption.ok) {
        await this.sendTextNotice(message.chatId, interruption.detail, {
          messageId: message.messageId,
          context: "发送新会话提示失败",
          ...replyMetadata
        });
        return;
      }
      interruptedActiveRun = interruption.interrupted;
    }

    const workspaceResolution = await this.workspaceResolver.resolve({
      message,
      session: existingSession
    });
    if (!workspaceResolution.ok) {
      await this.sendTextNotice(
        message.chatId,
        workspaceResolution.detail,
        {
          messageId: message.messageId,
          context: "发送工作区配置提示失败",
          ...replyMetadata
        }
      );
      return;
    }

    const threadId = await this.codexWorker.ensureThread({
      cli: workspaceResolution.cli,
      workspaceId: workspaceResolution.workspaceId,
      executionMode: workspaceResolution.executionMode,
      message
    });
    this.sessionStore.save({
      chatId: message.chatId,
      threadId,
      cli: workspaceResolution.cli,
      workspaceId: workspaceResolution.workspaceId,
      executionMode: workspaceResolution.executionMode,
      ...buildSessionMetadataPatch(message, existingSession),
      activeRunId: undefined,
      activeTurnId: undefined,
      updatedAt: new Date().toISOString()
    });

    await this.sendTextNotice(
      message.chatId,
      [
        interruptedActiveRun ? "已结束这个群当前的活跃任务，并创建新的会话。" : "已为这个群创建新的会话。",
        `CLI：${workspaceResolution.cli}`,
        `模式：${workspaceResolution.executionMode}`,
        threadId.startsWith("pending:")
          ? "新 thread 会在下一条消息真正创建。"
          : `新 thread：${threadId}`,
        `工作区：${workspaceResolution.workspaceId}`,
        "后续消息和定时任务都会进入这条新会话。"
      ].join("\n"),
      {
        messageId: message.messageId,
        context: "发送新会话提示失败",
        ...replyMetadata
      }
    );
  }

  private async interruptActiveRunForNewSession(
    existingSession: ChatSession,
    message: IncomingChatMessage
  ): Promise<
    | {
        ok: true;
        interrupted: boolean;
      }
    | {
        ok: false;
        detail: string;
      }
  > {
    if (!existingSession.activeRunId) {
      return {
        ok: true,
        interrupted: false
      };
    }

    const turnId = existingSession.activeTurnId ?? (await this.waitForActiveTurnId(message.chatId, existingSession.activeRunId));
    const latestSession = this.sessionStore.get(message.chatId);
    if (!latestSession?.activeRunId || latestSession.activeRunId !== existingSession.activeRunId) {
      return {
        ok: true,
        interrupted: false
      };
    }

    if (!turnId) {
      return {
        ok: false,
        detail: "这个群当前任务还在启动，暂时拿不到 turn id。请稍后再发一次“新会话”。"
      };
    }

    if (!this.codexWorker.interruptTurn) {
      return {
        ok: false,
        detail: `${renderCliLabel(existingSession.cli)} 当前不支持在活跃任务中直接新建会话。`
      };
    }

    try {
      await this.codexWorker.interruptTurn({
        session: latestSession,
        cli: latestSession.cli,
        workspaceId: latestSession.workspaceId,
        executionMode: normalizeExecutionMode(latestSession.executionMode),
        message,
        threadId: latestSession.threadId,
        turnId
      });
      this.runStore.setStatus(existingSession.activeRunId, "failed", "已被“新会话”中断。");
      this.sessionStore.releaseRun(message.chatId, existingSession.activeRunId);
      return {
        ok: true,
        interrupted: true
      };
    } catch (error) {
      return {
        ok: false,
        detail:
          error instanceof Error ? `结束当前活跃任务失败：${error.message}` : "结束当前活跃任务失败。"
      };
    }
  }

  private async waitForActiveTurnId(chatId: string, runId: string): Promise<string | undefined> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const session = this.sessionStore.get(chatId);
      if (!session?.activeRunId || session.activeRunId !== runId) {
        return undefined;
      }
      if (session.activeTurnId) {
        return session.activeTurnId;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return this.sessionStore.get(chatId)?.activeRunId === runId
      ? this.sessionStore.get(chatId)?.activeTurnId
      : undefined;
  }

  private async ensureGroupWorkspaceAvailable(
    message: IncomingChatMessage,
    replyMetadata: {
      replyToMessageId?: string;
      replyInThread?: boolean;
    } = {}
  ): Promise<
    | {
        workspaceId: string;
        cli: ChatCli;
        executionMode: ChatExecutionMode;
      }
    | undefined
  > {
    const workspaceResolution = await this.workspaceResolver.resolve({
      message,
      session: this.sessionStore.get(message.chatId)
    });
    if (workspaceResolution.ok) {
      return {
        workspaceId: workspaceResolution.workspaceId,
        cli: workspaceResolution.cli,
        executionMode: workspaceResolution.executionMode
      };
    }

    await this.sendTextNotice(message.chatId, workspaceResolution.detail, {
      messageId: message.messageId,
      context: "发送工作区配置提示失败",
      ...replyMetadata
    });
    return undefined;
  }

  private touchExistingSession(message: IncomingChatMessage): void {
    const existingSession = this.sessionStore.get(message.chatId);
    if (!existingSession) {
      return;
    }

    if (existingSession.activeRunId) {
      this.sessionStore.updateBoundRun(
        message.chatId,
        existingSession.activeRunId,
        buildSessionMetadataPatch(message, existingSession)
      );
      return;
    }

    this.sessionStore.save({
      ...existingSession,
      ...buildSessionMetadataPatch(message, existingSession),
      updatedAt: new Date().toISOString()
    });
  }

  private canSteer(context: {
    session?: ChatSession;
    cli: ChatCli;
    workspaceId: string;
    executionMode: ChatExecutionMode;
    message: IncomingChatMessage;
  }): boolean {
    return (
      this.codexWorker.supportsSteer?.({
        session: context.session,
        cli: context.cli,
        workspaceId: context.workspaceId,
        executionMode: context.executionMode,
        message: context.message
      }) ?? Boolean(this.codexWorker.steerTurn)
    );
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

  private createScheduledTaskMessage(task: ScheduledTaskRecord): IncomingChatMessage {
    return {
      chatId: task.chatId,
      chatType: "group",
      messageId: `scheduled:${task.chatId}:${task.taskId}:${Date.now()}`,
      senderId: "system:scheduler",
      senderName: "scheduler",
      senderType: "system",
      text: [
        `这是群里的定时任务 ${task.taskId} 自动触发。`,
        `cron：${task.cron}`,
        "",
        task.prompt
      ].join("\n"),
      mentionsBot: false,
      raw: {
        scheduledTaskId: task.taskId
      }
    };
  }

  private async sendTextNotice(
    chatId: string,
    content: string,
    metadata: {
      messageId?: string;
      context: string;
      replyToMessageId?: string;
      replyInThread?: boolean;
    }
  ): Promise<void> {
    try {
      await this.feishuClient.sendText({
        chatId,
        content,
        replyToMessageId: metadata.replyToMessageId,
        replyInThread: metadata.replyInThread
      });
    } catch (error) {
      this.logger.error(
        {
          chatId,
          messageId: metadata.messageId,
          error: error instanceof Error ? error.message : String(error)
        },
        metadata.context
      );
    }
  }
}
