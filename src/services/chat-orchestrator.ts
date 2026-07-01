import type {
  ChatCli,
  ChatExecutionMode,
  ChatSession,
  CodexEvent,
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
  getScheduledTaskKind,
  type ScheduledTaskTriggerResult
} from "./chat-schedule-service.js";
import {
  type GroupControlAgent,
  type GroupControlIntent
} from "./group-control-agent.js";
import type {
  ChatWorkspaceResolution,
  ChatWorkspaceResolver
} from "./chat-workspace-resolver.js";
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
      kind: "add_once";
      prompt: string;
      runAt?: string;
    }
  | {
      kind: "update";
      taskId: string;
      cron?: string;
      prompt?: string;
    }
  | {
      kind: "delete" | "pause" | "resume";
      taskId: string;
    }
  | {
      kind: "help";
      detail: string;
    };

type ChatRouting = {
  workspaceId: string;
  cli: ChatCli;
  executionMode: ChatExecutionMode;
  provider?: string;
  model?: string;
  thinking?: string;
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
    case "pi":
      return "Pi";
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
): {
  code: string;
  cli: ChatCli;
  executionMode: ChatExecutionMode;
  provider?: string;
  model?: string;
  thinking?: string;
} | undefined {
  if (message.chatType !== "group" || !message.mentionsBot) {
    return undefined;
  }

  const strippedText = stripMentions(message.text);
  const normalizedText = strippedText.toLowerCase();
  const parts = strippedText.split(/\s+/).filter(Boolean);
  const code = parts.find((part) => /^\d+$/.test(part));
  if (!code) {
    return undefined;
  }

  const lowerParts = parts.map((part) => part.toLowerCase());
  const cliCandidate = lowerParts.find((part) =>
    ["codex", "claude", "kimi", "pi", "deepseek", "ds", "ds4"].includes(part)
  );
  const executionModeCandidate = lowerParts.find((part) =>
    ["host", "docker", "dodocker", "do-docker"].includes(part)
  );
  const executionMode: ChatExecutionMode | undefined =
    executionModeCandidate === "host"
      ? "host"
      : executionModeCandidate
        ? "docker"
        : undefined;

  const cli: ChatCli =
    cliCandidate === "deepseek" ||
    cliCandidate === "ds" ||
    cliCandidate === "ds4" ||
    cliCandidate === "pi"
      ? "pi"
      : cliCandidate === "claude"
        ? "claude"
        : cliCandidate === "codex"
          ? "codex"
          : "kimi";

  const model: string | undefined =
    normalizedText.includes("ds4 flash") || normalizedText.includes("v4 flash")
    ? "deepseek-v4-flash"
    : normalizedText.includes("ds4 pro") ||
        normalizedText.includes("v4 pro") ||
        normalizedText.includes("deepseek") ||
        normalizedText.includes("ds4") ||
        lowerParts.includes("ds")
      ? "deepseek-v4-pro"
      : undefined;

  if (parts.length === 1 && code === parts[0]) {
    return {
      code,
      cli: "codex",
      executionMode: "host"
    };
  }

  if (parts.length > 5) {
    return undefined;
  }

  return {
    code,
    cli,
    executionMode: executionMode ?? "host",
    model
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
      detail: "请使用“定时任务 添加 <cron> | <任务内容>”、“定时任务 临时 添加 <时间> | <任务内容>”或“定时任务 列表”。"
    };
  }

  const oneTimeMatch = action.match(/^(临时任务|临时|一次性|一次任务|once)(?:\s+(?:添加|add))?(?:\s+(.+))?$/i);
  if (oneTimeMatch) {
    const payload = oneTimeMatch[2];
    if (!payload) {
      return {
        kind: "help",
        detail: "临时任务命令格式不对。请使用：定时任务 临时 添加 2026-07-01 18:30 | 检查线上状态"
      };
    }

    const separatorIndex = payload.search(/\s*[|｜]\s*/);
    if (separatorIndex < 0) {
      return {
        kind: "help",
        detail: "临时任务命令格式不对。请使用：定时任务 临时 添加 2026-07-01 18:30 | 检查线上状态"
      };
    }

    const runAt = payload.slice(0, separatorIndex).trim() || undefined;
    const prompt = payload.slice(separatorIndex + 1).replace(/^[|｜]\s*/, "").trim();
    if (!prompt) {
      return {
        kind: "help",
        detail: "临时任务内容不能为空。请使用：定时任务 临时 添加 2026-07-01 18:30 | 检查线上状态"
      };
    }

    return {
      kind: "add_once",
      runAt,
      prompt
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
    detail: "不支持这个定时任务命令。可用操作：列表、添加、临时添加、暂停、启用、删除。"
  };
}

function renderScheduleHelp(): string {
  return [
    "这个群支持这些定时任务命令：",
    "1. @机器人 定时任务 添加 0 9 * * 1-5 | 生成工作日报",
    "2. @机器人 临时任务：今天 18:30 检查线上流水线",
    "3. @机器人 定时任务 临时 添加 2026-07-01 18:30 | 检查线上状态",
    "4. @机器人 定时任务 暂停 1",
    "5. @机器人 定时任务 启用 1",
    "6. @机器人 定时任务 删除 1",
    "7. @机器人 定时任务",
    "",
    "这些命令都会进入这个群自己的配置线程。",
    "也支持自然语言连着说多个动作，例如“暂停 1，再把 2 改成工作日 9 点发日报”。"
  ].join("\n");
}

function renderControlHelp(defaultWorkspace: string): string {
  return [
    "群里直接发普通消息，就是项目会话。",
    "群里 @机器人，会进入这个群单独的配置线程，而且会持续复用。",
    "",
    "常见命令：",
    "1. 私聊机器人发送 工作区，先拿目录编号",
    "2. 群里发 @机器人 12",
    "3. 群里发 @机器人 claude 12",
    "4. 群里发 @机器人 docker 12",
    "5. 群里发 @机器人 docker codex 12",
    "6. 群里发 @机器人 docker pi ds4 flash 12",
    "7. 群里发 @机器人 新会话",
    "8. 群里发 @机器人 设置 goal 为 每次先检查测试再改代码",
    "9. 群里发 @机器人 清除 goal",
    "10. 群里发 @机器人 定时任务 添加 0 9 * * 1-5 | 生成工作日报",
    "11. 群里发 @机器人 临时任务：今天 18:30 检查线上流水线",
    "",
    "也支持自然语言，比如“把这个群切到 docker 的 codex 12 号目录”“看看这个群现在绑到哪”。",
    "如果一句话里有多个配置动作，也会按顺序执行，比如“先暂停 1，再把 2 改成工作日 9 点发日报”。",
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
        "支持的 CLI：codex / claude / kimi / pi",
        "你可以直接说：",
        "@机器人 把这个群绑定到 codex 的 2 号目录",
        "@机器人 把这个群切到 claude 的 Quant",
        "@机器人 把这个群切到 docker 的 codex 2 号目录",
        "@机器人 把这个群切到 docker 的 pi ds4 flash 2 号目录",
        "@机器人 pi 2 号目录",
        "@机器人 DS4 Pro 2 号目录",
        "@机器人 DS4 Flash 2 号目录",
        "@机器人 DeepSeek V4 Pro 2 号目录",
        "@机器人 DeepSeek V4 Flash 2 号目录"
      ].join("\n");
}

type TextNoticeReplyMetadata = {
  replyToMessageId?: string;
  replyInThread?: boolean;
  mentionSenderId?: string;
  mentionSenderName?: string;
};

type TextNoticeMetadata = TextNoticeReplyMetadata & {
  messageId?: string;
  context: string;
};

function escapeFeishuTextValue(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeFeishuAttributeValue(value: string): string {
  return escapeFeishuTextValue(value).replaceAll('"', "&quot;");
}

function renderMentionTag(senderId: string, senderName: string): string {
  return `<at user_id="${escapeFeishuAttributeValue(senderId)}">${escapeFeishuTextValue(
    senderName
  )}</at>`;
}

function buildControlReplyMetadata(message: IncomingChatMessage): TextNoticeReplyMetadata {
  if (message.chatType === "group" && message.mentionsBot && message.senderId) {
    return {
      mentionSenderId: message.senderId,
      mentionSenderName: message.senderName.trim() || "你"
    };
  }

  return {
    mentionSenderId: undefined,
    mentionSenderName: undefined
  };
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

function buildControlSessionPatch(
  message: IncomingChatMessage,
  existingSession: ChatSession | undefined,
  patch: Partial<Pick<ChatSession, "controlThreadId" | "controlReplyToMessageId">>,
  defaultWorkspace: string,
  observedAt = new Date().toISOString()
): ChatSession {
  return {
    chatId: message.chatId,
    threadId: existingSession?.threadId ?? `pending:group-session:${message.chatId}:unconfigured`,
    cli: existingSession?.cli ?? "codex",
    workspaceId: existingSession?.workspaceId ?? defaultWorkspace,
    executionMode: normalizeExecutionMode(existingSession?.executionMode),
    ...existingSession,
    ...patch,
    chatType: message.chatType || existingSession?.chatType,
    chatName: message.chatName ?? existingSession?.chatName,
    chatDisplayName: resolveChatDisplayName(message, existingSession),
    lastInboundAt: existingSession?.lastInboundAt,
    lastSenderId: existingSession?.lastSenderId,
    lastSenderName: existingSession?.lastSenderName,
    lastMessageId: existingSession?.lastMessageId,
    lastMessagePreview: existingSession?.lastMessagePreview,
    lastUserMessagePreview: existingSession?.lastUserMessagePreview,
    updatedAt: observedAt
  };
}

function renderScheduledTaskSchedule(task: ScheduledTaskRecord): string {
  if (getScheduledTaskKind(task) === "once") {
    return `临时 | ${formatScheduleTime(task.runAt ?? task.nextRunAt)}`;
  }

  return `循环 | ${task.cron ?? "未设置 cron"}`;
}

function renderScheduleList(tasks: ScheduledTaskRecord[]): string {
  if (tasks.length === 0) {
    return [renderScheduleHelp(), "", "这个群目前还没有定时任务。"].join("\n");
  }

  return [
    "这个群当前的定时任务：",
    ...tasks.map((task) =>
      [
        `${task.taskId}. ${task.status === "enabled" ? "启用" : "暂停"} | ${renderScheduledTaskSchedule(task)}`,
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
          intents: [
            {
              kind: "help",
              detail: "这个环境还没有配置群控制 agent。"
            }
          ],
          threadId: "pending:group-control:missing"
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
    if (await this.handleControlMessage(message)) {
      return;
    }

    this.touchExistingSession(message);

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

    const matchesActiveSession =
      existingSession?.activeRunId &&
      existingSession.workspaceId === workspaceResolution.workspaceId &&
      existingSession.cli === workspaceResolution.cli &&
      normalizeExecutionMode(existingSession.executionMode) === workspaceResolution.executionMode;

    if (matchesActiveSession) {
      if (
        this.canSteer({
          session: existingSession,
          cli: workspaceResolution.cli,
          workspaceId: workspaceResolution.workspaceId,
          executionMode: workspaceResolution.executionMode,
          message
        })
      ) {
        await this.dispatchActiveOrNew(existingSession, message, {
          cli: workspaceResolution.cli,
          workspaceId: workspaceResolution.workspaceId,
          executionMode: workspaceResolution.executionMode
        });
        return;
      }

      if (this.canInterruptForLatestMessage(workspaceResolution.cli)) {
        await this.interruptActiveRunForLatestMessage(existingSession, message, {
          cli: workspaceResolution.cli,
          workspaceId: workspaceResolution.workspaceId,
          executionMode: workspaceResolution.executionMode
        });
        return;
      }
    }

    await this.handleMessage(message, workspaceResolution);
  }

  private async handleMessage(
    message: IncomingChatMessage,
    routing?: ChatRouting
  ): Promise<void> {
    const existingSession = this.sessionStore.get(message.chatId);
    const resolvedWorkspaceId = routing?.workspaceId ?? existingSession?.workspaceId ?? this.defaultWorkspace;
    const resolvedCli = routing?.cli ?? existingSession?.cli ?? "kimi";
    const resolvedExecutionMode =
      routing?.executionMode ?? normalizeExecutionMode(existingSession?.executionMode);
    const resolvedProvider = routing?.provider ?? existingSession?.provider;
    const resolvedModel = routing?.model ?? existingSession?.model;
    const resolvedThinking = routing?.thinking ?? existingSession?.thinking;
    const reusableSession =
      existingSession?.workspaceId === resolvedWorkspaceId &&
      existingSession.cli === resolvedCli &&
      normalizeExecutionMode(existingSession.executionMode) === resolvedExecutionMode
        ? existingSession
        : undefined;
    const initialThreadId = reusableSession?.threadId ?? `pending:${message.chatId}:${Date.now()}`;
    const observedAt = new Date().toISOString();

    this.sessionStore.save({
      chatId: message.chatId,
      threadId: initialThreadId,
      cli: resolvedCli,
      workspaceId: resolvedWorkspaceId,
      executionMode: resolvedExecutionMode,
      provider: resolvedProvider,
      model: resolvedModel,
      thinking: resolvedThinking,
      controlThreadId: existingSession?.controlThreadId,
      controlReplyToMessageId: existingSession?.controlReplyToMessageId,
      ...buildSessionMetadataPatch(message, reusableSession ?? existingSession, observedAt),
      activeRunId: reusableSession?.activeRunId,
      activeTurnId: reusableSession?.activeTurnId,
      updatedAt: observedAt
    });

    const run = this.runStore.create({
      chatId: message.chatId,
      threadId: initialThreadId,
      sourceMessageId: message.messageId
    });

    this.sessionStore.attachRun(message.chatId, run.runId);

    try {
      const threadId = reusableSession
        ? await this.codexWorker.ensureThread({
            session: this.sessionStore.get(message.chatId),
            cli: resolvedCli,
            workspaceId: resolvedWorkspaceId,
            executionMode: resolvedExecutionMode,
            provider: resolvedProvider,
            model: resolvedModel,
            thinking: resolvedThinking,
            message
          })
        : initialThreadId;

      if (threadId !== initialThreadId) {
        this.runStore.update(run.runId, {
          threadId
        });
        this.sessionStore.updateBoundRun(message.chatId, run.runId, {
          threadId,
          cli: resolvedCli,
          workspaceId: resolvedWorkspaceId,
          executionMode: resolvedExecutionMode,
          provider: resolvedProvider,
          model: resolvedModel,
          thinking: resolvedThinking
        });
      }

      await this.projectCodexEvents(
        message,
        run,
        {
          cli: resolvedCli,
          workspaceId: resolvedWorkspaceId,
          executionMode: resolvedExecutionMode,
          provider: resolvedProvider,
          model: resolvedModel,
          thinking: resolvedThinking
        },
        this.codexWorker.runTurn({
          session: this.sessionStore.get(message.chatId),
          cli: resolvedCli,
          workspaceId: resolvedWorkspaceId,
          executionMode: resolvedExecutionMode,
          provider: resolvedProvider,
          model: resolvedModel,
          thinking: resolvedThinking,
          message,
          threadId
        })
      );
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

  private async projectCodexEvents(
    message: IncomingChatMessage,
    run: ReturnType<RunStore["create"]>,
    routing: ChatRouting,
    events: AsyncIterable<CodexEvent>
  ): Promise<void> {
    for await (const event of events) {
      if (event.kind === "turn_bound") {
        this.sessionStore.bindTurn(message.chatId, event.turnId, run.runId);
        continue;
      }

      const result = this.projector.apply(run.runId, event);
      this.sessionStore.updateBoundRun(message.chatId, run.runId, {
        threadId: result.run.threadId,
        cli: routing.cli,
        workspaceId: routing.workspaceId,
        executionMode: routing.executionMode,
        provider: routing.provider,
        model: routing.model,
        thinking: routing.thinking
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
        provider: messageSession.provider,
        model: messageSession.model,
        thinking: messageSession.thinking,
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
    routing: ChatRouting
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

  private async interruptActiveRunForLatestMessage(
    existingSession: ChatSession,
    message: IncomingChatMessage,
    routing: ChatRouting
  ): Promise<void> {
    const activeRunId = existingSession.activeRunId;
    if (!activeRunId || !this.codexWorker.interruptTurn) {
      await this.handleMessage(message, routing);
      return;
    }

    const turnId =
      existingSession.activeTurnId ?? (await this.waitForActiveTurnId(message.chatId, activeRunId));
    if (!turnId) {
      await this.sendTextNotice(message.chatId, "这个群当前任务还在启动，暂时无法切换到最新消息。请稍后再发一次。", {
        messageId: message.messageId,
        context: "发送 Kimi 最新消息接管提示失败"
      });
      return;
    }

    const interruptionMessage = "当前任务已被后续消息中断。";

    await this.codexWorker.interruptTurn({
      session: existingSession,
      cli: existingSession.cli,
      workspaceId: existingSession.workspaceId,
      executionMode: normalizeExecutionMode(existingSession.executionMode),
      provider: existingSession.provider,
      model: existingSession.model,
      thinking: existingSession.thinking,
      message,
      threadId: existingSession.threadId,
      turnId,
      interruptionMessage
    });

    this.runStore.setStatus(activeRunId, "failed", interruptionMessage);
    this.sessionStore.releaseRun(message.chatId, activeRunId);
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
        provider: workspaceResolution.provider,
        model: workspaceResolution.model,
        thinking: workspaceResolution.thinking,
        message
      }) &&
      existingSession.workspaceId === workspaceResolution.workspaceId &&
      existingSession.cli === workspaceResolution.cli &&
      normalizeExecutionMode(existingSession.executionMode) === workspaceResolution.executionMode
    ) {
      await this.dispatchActiveOrNew(existingSession, message, {
        cli: workspaceResolution.cli,
        workspaceId: workspaceResolution.workspaceId,
        executionMode: workspaceResolution.executionMode,
        provider: workspaceResolution.provider,
        model: workspaceResolution.model,
        thinking: workspaceResolution.thinking
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
    if (message.chatType === "group" && message.mentionsBot) {
      await this.handleGroupMentionControlMessage(message);
      return true;
    }

    if (message.chatType === "p2p" && isWorkspaceCatalogCommand(message.text)) {
      const entries = await this.workspaceResolver.listCatalog();
      const content = renderWorkspaceCatalogMessage(entries, this.defaultWorkspace);
      await this.sendTextNotice(message.chatId, content, {
        messageId: message.messageId,
        context: "发送工作区配置提示失败"
      });
      return true;
    }

    if (message.chatType !== "group" && isNewSessionCommand(message)) {
      await this.handleNewSessionCommand(message);
      return true;
    }

    const scheduleCommand = message.chatType === "group" ? undefined : parseScheduleCommand(message);
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
      code: bindingCommand.code,
      provider: bindingCommand.provider,
      model: bindingCommand.model,
      thinking: bindingCommand.thinking
    });
    if (!result.ok) {
      await this.sendTextNotice(message.chatId, result.detail, {
        messageId: message.messageId,
        context: "发送工作区配置提示失败"
      });
      return true;
    }

    const modelSuffix = result.model ? ` / ${result.model}` : "";
    await this.sendTextNotice(
      message.chatId,
      [
        `已将这个群绑定到 ${renderExecutionModeLabel(result.executionMode)} 模式的 ${renderCliLabel(result.cli)} CLI 工作区 ${result.entry.code}: ${result.entry.workspace}${modelSuffix}`,
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
    const existingSession = this.sessionStore.get(message.chatId);
    const replyMetadata = buildControlReplyMetadata(message);
    const catalog = await this.workspaceResolver.listCatalog();

    let intents: GroupControlIntent[];
    let controlThreadId = existingSession?.controlThreadId;
    try {
      const currentBindingResolution = await this.workspaceResolver.resolve({
        message,
        session: existingSession
      });
      const currentNativeGoal = await this.readNativeCodexGoalObjective(
        message,
        currentBindingResolution,
        existingSession
      );
      const result = await this.groupControlAgent.interpret(
        message,
        {
          catalog,
          scheduledTasks: this.scheduleService.listByChat(message.chatId),
          goal: currentNativeGoal,
          currentBinding: currentBindingResolution.ok
            ? {
                configured: true,
                cli: currentBindingResolution.cli,
                executionMode: currentBindingResolution.executionMode,
                workspaceId: currentBindingResolution.workspaceId,
                provider: currentBindingResolution.provider,
                model: currentBindingResolution.model,
                thinking: currentBindingResolution.thinking
              }
            : {
                configured: false,
                detail: currentBindingResolution.detail
              }
        },
        {
          controlThreadId
        }
      );
      intents = result.intents;
      controlThreadId = result.threadId;
      this.sessionStore.save(
        buildControlSessionPatch(
          message,
          existingSession,
          {
            controlThreadId,
            controlReplyToMessageId: existingSession?.controlReplyToMessageId
          },
          this.defaultWorkspace
        )
      );
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

    let metadataForNextReply = replyMetadata;
    for (const intent of intents) {
      await this.executeGroupControlIntent(message, intent, catalog, metadataForNextReply);
      metadataForNextReply = {};
    }
  }

  private getNativeGoalThreadId(
    binding: ChatWorkspaceResolution,
    session: ChatSession | undefined
  ): string | undefined {
    if (
      !binding.ok ||
      binding.cli !== "codex" ||
      !session?.threadId ||
      session.threadId.startsWith("pending:") ||
      session.cli !== "codex" ||
      session.workspaceId !== binding.workspaceId ||
      normalizeExecutionMode(session.executionMode) !== binding.executionMode
    ) {
      return undefined;
    }

    return session.threadId;
  }

  private async readNativeCodexGoalObjective(
    message: IncomingChatMessage,
    binding: ChatWorkspaceResolution,
    session: ChatSession | undefined
  ): Promise<string | undefined> {
    const threadId = this.getNativeGoalThreadId(binding, session);
    if (!threadId || !binding.ok || !this.codexWorker.getGoal) {
      return undefined;
    }

    try {
      const goal = await this.codexWorker.getGoal({
        session,
        cli: "codex",
        workspaceId: binding.workspaceId,
        executionMode: binding.executionMode,
        provider: binding.provider,
        model: binding.model,
        thinking: binding.thinking,
        message,
        threadId
      });
      return goal?.objective?.trim() || undefined;
    } catch (error) {
      this.logger.warn(
        {
          chatId: message.chatId,
          messageId: message.messageId,
          threadId,
          error: error instanceof Error ? error.message : String(error)
        },
        "读取 Codex native goal 失败，按未设置处理"
      );
      return undefined;
    }
  }

  private async executeGroupControlIntent(
    message: IncomingChatMessage,
    intent: GroupControlIntent,
    catalog: Awaited<ReturnType<ChatWorkspaceResolver["listCatalog"]>>,
    replyMetadata: TextNoticeReplyMetadata
  ): Promise<void> {
    const currentBindingResolution = await this.workspaceResolver.resolve({
      message,
      session: this.sessionStore.get(message.chatId)
    });

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
      case "show_binding": {
        const nativeGoal = await this.readNativeCodexGoalObjective(
          message,
          currentBindingResolution,
          this.sessionStore.get(message.chatId)
        );
        await this.sendTextNotice(
          message.chatId,
          currentBindingResolution.ok
            ? [
                "这个群当前已经绑定工作区。",
                `CLI：${currentBindingResolution.cli}`,
                `模式：${currentBindingResolution.executionMode}`,
                `工作区：${currentBindingResolution.workspaceId}`,
                `Codex native goal：${currentBindingResolution.cli === "codex" ? nativeGoal ?? "未设置" : "当前不是 Codex 绑定"}`
              ].join("\n")
            : [
                currentBindingResolution.detail,
                "Codex native goal：未设置"
              ].join("\n"),
          {
            messageId: message.messageId,
            context: "发送当前绑定状态失败",
            ...replyMetadata
          }
        );
        return;
      }
      case "bind_workspace": {
        const result = await this.workspaceResolver.bindGroupWorkspace({
          chatId: message.chatId,
          cli: intent.cli,
          executionMode: intent.executionMode,
          code: intent.code,
          provider: intent.provider,
          model: intent.model,
          thinking: intent.thinking
        });
        await this.sendTextNotice(
          message.chatId,
          result.ok
            ? [
                `已将这个群绑定到 ${renderExecutionModeLabel(result.executionMode)} 模式的 ${renderCliLabel(result.cli)} CLI 工作区 ${result.entry.code}: ${result.entry.workspace}${result.model ? ` / ${result.model}` : ""}`,
                `后续普通群消息会通过 ${result.executionMode} / ${result.cli} 从 ${result.entry.workspaceId} 启动。`,
                "群里 @机器人的消息会继续进入这个群单独复用的配置线程。"
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
        await this.sendTextNotice(
          message.chatId,
          renderScheduleList(this.scheduleService.listByChat(message.chatId)),
          {
            messageId: message.messageId,
            context: "发送定时任务列表失败",
            ...replyMetadata
          }
        );
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
      case "create_one_time_schedule":
        await this.handleScheduleCommand(
          message,
          {
            kind: "add_once",
            runAt: intent.runAt,
            prompt: intent.prompt
          },
          replyMetadata
        );
        return;
      case "update_schedule":
        await this.handleScheduleCommand(
          message,
          {
            kind: "update",
            taskId: intent.taskId,
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
      case "set_goal":
        await this.handleSetGoalCommand(message, intent.goal, currentBindingResolution, replyMetadata);
        return;
      case "clear_goal":
        await this.handleClearGoalCommand(message, currentBindingResolution, replyMetadata);
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

  private async handleSetGoalCommand(
    message: IncomingChatMessage,
    goal: string,
    currentBindingResolution: ChatWorkspaceResolution,
    replyMetadata: TextNoticeReplyMetadata
  ): Promise<void> {
    const normalizedGoal = goal.trim();
    if (!normalizedGoal) {
      await this.sendTextNotice(message.chatId, "goal 不能为空。", {
        messageId: message.messageId,
        context: "发送 goal 设置提示失败",
        ...replyMetadata
      });
      return;
    }

    if (!currentBindingResolution.ok) {
      await this.sendTextNotice(
        message.chatId,
        [currentBindingResolution.detail, "Codex native goal 需要先把这个群绑定到 Codex 工作区。"].join("\n"),
        {
          messageId: message.messageId,
          context: "发送 goal 设置结果失败",
          ...replyMetadata
        }
      );
      return;
    }

    if (currentBindingResolution.cli !== "codex") {
      await this.sendTextNotice(
        message.chatId,
        `Codex native goal 只支持 Codex。当前群绑定的是 ${renderCliLabel(currentBindingResolution.cli)}，请先切到 Codex。`,
        {
          messageId: message.messageId,
          context: "发送 goal 设置结果失败",
          ...replyMetadata
        }
      );
      return;
    }

    if (!this.codexWorker.runGoal) {
      await this.sendTextNotice(message.chatId, "当前 Codex worker 不支持 native goal。", {
        messageId: message.messageId,
        context: "发送 goal 设置结果失败",
        ...replyMetadata
      });
      return;
    }

    const existingSession = this.sessionStore.get(message.chatId);
    if (existingSession?.activeRunId) {
      await this.sendTextNotice(message.chatId, "这个群当前有 Codex 任务正在运行，请等它结束后再设置 native goal。", {
        messageId: message.messageId,
        context: "发送 goal 设置结果失败",
        ...replyMetadata
      });
      return;
    }

    const observedAt = new Date().toISOString();
    const initialSession = this.sessionStore.save({
      chatId: message.chatId,
      threadId: existingSession?.threadId ?? `pending:${message.chatId}:${Date.now()}`,
      cli: "codex",
      workspaceId: currentBindingResolution.workspaceId,
      executionMode: currentBindingResolution.executionMode,
      provider: currentBindingResolution.provider,
      model: currentBindingResolution.model,
      thinking: currentBindingResolution.thinking,
      controlThreadId: existingSession?.controlThreadId,
      controlReplyToMessageId: existingSession?.controlReplyToMessageId,
      ...buildSessionMetadataPatch(message, existingSession, observedAt),
      activeRunId: undefined,
      activeTurnId: undefined,
      updatedAt: observedAt
    });

    let threadId: string;
    try {
      threadId = await this.codexWorker.ensureThread({
        session: initialSession,
        cli: "codex",
        workspaceId: currentBindingResolution.workspaceId,
        executionMode: currentBindingResolution.executionMode,
        provider: currentBindingResolution.provider,
        model: currentBindingResolution.model,
        thinking: currentBindingResolution.thinking,
        message
      });
    } catch (error) {
      await this.sendTextNotice(
        message.chatId,
        `无法恢复或创建 Codex thread，native goal 未设置：${error instanceof Error ? error.message : String(error)}`,
        {
          messageId: message.messageId,
          context: "发送 goal 设置结果失败",
          ...replyMetadata
        }
      );
      return;
    }

    if (threadId !== initialSession.threadId) {
      this.sessionStore.save({
        ...initialSession,
        threadId,
        updatedAt: new Date().toISOString()
      });
    }

    await this.sendTextNotice(
      message.chatId,
      [
        "已调用 Codex native /goal 设置目标，并开始执行 goal turn。",
        `Goal：${normalizedGoal}`,
        `Thread：${threadId}`
      ].join("\n"),
      {
        messageId: message.messageId,
        context: "发送 goal 设置结果失败",
        ...replyMetadata
      }
    );

    const run = this.runStore.create({
      chatId: message.chatId,
      threadId,
      sourceMessageId: message.messageId
    });
    this.sessionStore.attachRun(message.chatId, run.runId);

    try {
      await this.projectCodexEvents(
        message,
        run,
        {
          cli: "codex",
          workspaceId: currentBindingResolution.workspaceId,
          executionMode: currentBindingResolution.executionMode,
          provider: currentBindingResolution.provider,
          model: currentBindingResolution.model,
          thinking: currentBindingResolution.thinking
        },
        this.codexWorker.runGoal({
          session: this.sessionStore.get(message.chatId),
          cli: "codex",
          workspaceId: currentBindingResolution.workspaceId,
          executionMode: currentBindingResolution.executionMode,
          provider: currentBindingResolution.provider,
          model: currentBindingResolution.model,
          thinking: currentBindingResolution.thinking,
          message,
          threadId,
          objective: normalizedGoal
        })
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "设置 Codex native goal 时发生未知错误";
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
          threadId,
          error: messageText
        },
        "处理 Codex native goal 失败"
      );
    } finally {
      await this.deliveryService.flushRun(run.runId).catch((error) => {
        this.logger.error(
          {
            runId: run.runId,
            chatId: message.chatId,
            error: error instanceof Error ? error.message : String(error)
          },
          "刷新 native goal run 对应的飞书消息失败"
        );
      });
      this.sessionStore.releaseRun(message.chatId, run.runId);
    }
  }

  private async handleClearGoalCommand(
    message: IncomingChatMessage,
    currentBindingResolution: ChatWorkspaceResolution,
    replyMetadata: TextNoticeReplyMetadata
  ): Promise<void> {
    if (!currentBindingResolution.ok) {
      await this.sendTextNotice(
        message.chatId,
        [currentBindingResolution.detail, "Codex native goal 需要先把这个群绑定到 Codex 工作区。"].join("\n"),
        {
          messageId: message.messageId,
          context: "发送 goal 清除结果失败",
          ...replyMetadata
        }
      );
      return;
    }

    if (currentBindingResolution.cli !== "codex") {
      await this.sendTextNotice(
        message.chatId,
        `Codex native goal 只支持 Codex。当前群绑定的是 ${renderCliLabel(currentBindingResolution.cli)}，没有清除 ${renderCliLabel(currentBindingResolution.cli)} 上下文。`,
        {
          messageId: message.messageId,
          context: "发送 goal 清除结果失败",
          ...replyMetadata
        }
      );
      return;
    }

    if (!this.codexWorker.clearGoal) {
      await this.sendTextNotice(message.chatId, "当前 Codex worker 不支持 native goal clear。", {
        messageId: message.messageId,
        context: "发送 goal 清除结果失败",
        ...replyMetadata
      });
      return;
    }

    const existingSession = this.sessionStore.get(message.chatId);
    const threadId = this.getNativeGoalThreadId(currentBindingResolution, existingSession);
    if (!threadId) {
      await this.sendTextNotice(message.chatId, "这个群当前还没有可清除 native goal 的 Codex thread。", {
        messageId: message.messageId,
        context: "发送 goal 清除结果失败",
        ...replyMetadata
      });
      return;
    }

    let cleared: boolean;
    try {
      cleared = await this.codexWorker.clearGoal({
        session: existingSession,
        cli: "codex",
        workspaceId: currentBindingResolution.workspaceId,
        executionMode: currentBindingResolution.executionMode,
        provider: currentBindingResolution.provider,
        model: currentBindingResolution.model,
        thinking: currentBindingResolution.thinking,
        message,
        threadId
      });
    } catch (error) {
      await this.sendTextNotice(
        message.chatId,
        `调用 Codex native /goal clear 失败：${error instanceof Error ? error.message : String(error)}`,
        {
          messageId: message.messageId,
          context: "发送 goal 清除结果失败",
          ...replyMetadata
        }
      );
      return;
    }

    await this.sendTextNotice(
      message.chatId,
      cleared
        ? "已调用 Codex native /goal clear 清除当前 thread 的 goal。"
        : "Codex native /goal clear 已执行，但当前 thread 没有可清除的 goal。",
      {
        messageId: message.messageId,
        context: "发送 goal 清除结果失败",
        ...replyMetadata
      }
    );
  }

  private async handleScheduleCommand(
    message: IncomingChatMessage,
    command: ScheduleCommand,
    replyMetadata: TextNoticeReplyMetadata = {}
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
          `cron：${result.task.cron ?? command.cron}`,
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

    if (command.kind === "add_once") {
      const routing = await this.ensureGroupWorkspaceAvailable(message, replyMetadata);
      if (!routing) {
        return;
      }

      const result = this.scheduleService.createOneTimeTask({
        chatId: message.chatId,
        runAt: command.runAt,
        prompt: command.prompt,
        createdById: message.senderId,
        createdByName: message.senderName
      });
      const content = result.ok
        ? [
            `已创建这个群的临时任务 ${result.task.taskId}。`,
            `执行时间：${formatScheduleTime(result.task.nextRunAt)}`,
            "执行一次后会自动删除。",
            `CLI：${routing.cli}`,
            `模式：${routing.executionMode}`,
            `工作区：${routing.workspaceId}`,
            `任务内容：${result.task.prompt}`
          ].join("\n")
        : [result.detail, "", renderScheduleHelp()].join("\n");
      await this.sendTextNotice(message.chatId, content, {
        messageId: message.messageId,
        context: "发送临时任务创建结果失败",
        ...replyMetadata
      });
      return;
    }

    if (command.kind === "update") {
      const result = this.scheduleService.updateTask({
        chatId: message.chatId,
        taskId: command.taskId,
        cron: command.cron,
        prompt: command.prompt
      });
      const content = result.ok
        ? [
            `已更新这个群的定时任务 ${result.task.taskId}。`,
            `计划：${renderScheduledTaskSchedule(result.task)}`,
            `状态：${result.task.status === "enabled" ? "启用中" : "已暂停"}`,
            `下次触发：${formatScheduleTime(result.task.nextRunAt)}`,
            `任务内容：${result.task.prompt}`
          ].join("\n")
        : [result.detail, "", renderScheduleHelp()].join("\n");
      await this.sendTextNotice(message.chatId, content, {
        messageId: message.messageId,
        context: "发送定时任务更新结果失败",
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
    replyMetadata: TextNoticeReplyMetadata = {}
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
      provider: workspaceResolution.provider,
      model: workspaceResolution.model,
      thinking: workspaceResolution.thinking,
      controlThreadId: existingSession?.controlThreadId,
      controlReplyToMessageId: existingSession?.controlReplyToMessageId,
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
      const interruptionMessage = "当前任务已被“新会话”中断。";
      await this.codexWorker.interruptTurn({
        session: latestSession,
        cli: latestSession.cli,
        workspaceId: latestSession.workspaceId,
        executionMode: normalizeExecutionMode(latestSession.executionMode),
        message,
        threadId: latestSession.threadId,
        turnId,
        interruptionMessage
      });
      this.runStore.setStatus(existingSession.activeRunId, "failed", interruptionMessage);
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
    replyMetadata: TextNoticeReplyMetadata = {}
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
    provider?: string;
    model?: string;
    thinking?: string;
    message: IncomingChatMessage;
  }): boolean {
    return (
      this.codexWorker.supportsSteer?.({
        session: context.session,
        cli: context.cli,
        workspaceId: context.workspaceId,
        executionMode: context.executionMode,
        provider: context.provider,
        model: context.model,
        thinking: context.thinking,
        message: context.message
      }) ?? Boolean(this.codexWorker.steerTurn)
    );
  }

  private canInterruptForLatestMessage(cli: ChatCli): boolean {
    return cli === "kimi" && Boolean(this.codexWorker.interruptTurn);
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
    const isOneTimeTask = getScheduledTaskKind(task) === "once";
    const scheduleLines = isOneTimeTask
      ? [
          `这是群里的临时任务 ${task.taskId} 自动触发。`,
          "这个任务执行一次后会自动删除。",
          `计划时间：${formatScheduleTime(task.runAt ?? task.nextRunAt)}`
        ]
      : [
          `这是群里的定时任务 ${task.taskId} 自动触发。`,
          `cron：${task.cron ?? "未设置 cron"}`
        ];

    return {
      chatId: task.chatId,
      chatType: "group",
      messageId: `scheduled:${task.chatId}:${task.taskId}:${Date.now()}`,
      senderId: "system:scheduler",
      senderName: "scheduler",
      senderType: "system",
      text: [
        ...scheduleLines,
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
    metadata: TextNoticeMetadata
  ): Promise<void> {
    const prefixedContent =
      metadata.mentionSenderId && metadata.mentionSenderName
        ? `${renderMentionTag(metadata.mentionSenderId, metadata.mentionSenderName)}\n${content}`
        : content;

    try {
      await this.feishuClient.sendText({
        chatId,
        content: prefixedContent,
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
