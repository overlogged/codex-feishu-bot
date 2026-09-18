import type {
  ChatCli,
  ChatSession,
  CodexEvent,
  IncomingChatMessage,
  ScheduledTaskRecord
} from "../domain/types.js";
import type { CodexWorker } from "../integrations/codex/codex-worker.js";
import { PI_DS_FLASH_MODEL } from "../integrations/codex/pi-rpc-worker.js";
import {
  readThreadTranscript,
  renderTranscriptExcerpt,
  unwrapUserVisibleText
} from "../integrations/codex/thread-transcript.js";
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
import {
  renderSessionResumeLine,
  type SessionResumeCliCommands
} from "./session-resume-command.js";
import { UsageStatsService } from "./usage-stats-service.js";
import { formatTimeOfDay, parseTimeOfDay } from "./token-daily-report-service.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

const WORKSPACE_CATALOG_COMMAND = /^(工作区|workspace|workspaces)$/i;
// 长任务被 steer 时给用户一个可见回执，避免看起来“没反应”。
const STEER_ACKNOWLEDGEMENT_THRESHOLD_MS = 15_000;
const SCHEDULE_COMMAND = /^(定时任务|schedule|schedules)(?:\s+(.+))?$/i;
const NEW_SESSION_COMMAND = /^(新会话|new\s+session|reset\s+session)$/i;
const TOOL_CARDS_COMMAND = /^(工具卡片|tool\s*cards?)(?:\s+(开|开启|on|关|关闭|off|状态|status))?$/i;
const QUOTA_COMMAND = /^(额度|余量|用量|token|tokens|usage|quota|stats)$/i;

type ToolCardsCommandAction = "on" | "off" | "status";

type TokenDailyReportCommand =
  | { action: "status" }
  | { action: "on" }
  | { action: "off" }
  | { action: "set_time"; time: string };

const TOKEN_DAILY_REPORT_COMMAND =
  /^(?:(打开|开启|启用|关闭|停用|取消|设置|修改|调整)\s*)?(?:token|tokens|额度|用量|消耗)\s*(?:日报|报告|daily)(?:\s*(?:时间|发送时间))?(?:\s*(开|开启|打开|启用|on|关|关闭|停用|取消|off|状态|status))?(?:\s*(\d{1,2}:\d{2}))?$/i;

/**
 * 只识别「整句就是 token 日报指令」的消息，避免群里的普通任务消息因为
 * 提到“token 日报”被误判成开关指令。
 */
export function parseTokenDailyReportCommand(
  message: IncomingChatMessage
): TokenDailyReportCommand | undefined {
  const text = stripMentions(message.text).trim();
  if (!text || text.length > 40) {
    return undefined;
  }

  const matched = text.match(TOKEN_DAILY_REPORT_COMMAND);
  if (!matched) {
    return undefined;
  }

  const leading = (matched[1] ?? "").toLowerCase();
  const trailing = (matched[2] ?? "").toLowerCase();
  const time = matched[3];
  const verb = leading || trailing;

  if (["关闭", "停用", "取消", "off"].includes(verb)) {
    return { action: "off" };
  }

  if (["打开", "开启", "启用", "on"].includes(verb)) {
    return { action: "on" };
  }

  if (time) {
    return { action: "set_time", time };
  }

  return { action: "status" };
}

function parseToolCardsCommand(message: IncomingChatMessage): ToolCardsCommandAction | undefined {
  const matched = stripMentions(message.text).trim().match(TOOL_CARDS_COMMAND);
  if (!matched) {
    return undefined;
  }

  const action = (matched[2] ?? "状态").toLowerCase();
  if (action === "开" || action === "开启" || action === "on") {
    return "on";
  }
  if (action === "关" || action === "关闭" || action === "off") {
    return "off";
  }
  return "status";
}

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
    case "dsh":
      return "DSH";
    case "codex":
    default:
      return "Codex";
  }
}

function extractGroupBindingCommand(
  message: IncomingChatMessage
): {
  code: string;
  cli: ChatCli;
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
    ["codex", "claude", "kimi", "pi", "dsh", "deepseek", "ds", "ds4"].includes(part)
  );

  // ds / deepseek 默认交给 dsh（DeepSeek Harness）；显式 pi 时才走 pi。
  const cli: ChatCli =
    cliCandidate === "deepseek" || cliCandidate === "ds" || cliCandidate === "ds4"
      ? "dsh"
      : cliCandidate === "pi"
        ? "pi"
        : cliCandidate === "dsh"
          ? "dsh"
          : cliCandidate === "claude"
            ? "claude"
            : cliCandidate === "codex"
              ? "codex"
              : "codex";

  // dsh 的模型/provider 由 profile 配置决定，这里不再注入 model/thinking。
  const model: string | undefined =
    cli === "dsh"
      ? undefined
      : /(?:gpt\s*-?\s*6|gpt6|gpt-6|astra)/i.test(normalizedText)
        ? "gpt-6-astra"
        : /(?:gpt\s*-?\s*)?5\.6(?:\s*-?\s*(?:sol|soul))?/i.test(normalizedText)
          ? "gpt-5.6-sol"
          : normalizedText.includes("ds4.1 flash") ||
              normalizedText.includes("v4.1 flash") ||
              normalizedText.includes("ds4 flash") ||
              normalizedText.includes("v4 flash")
            ? PI_DS_FLASH_MODEL
            : normalizedText.includes("ds4 pro") ||
          normalizedText.includes("v4 pro")
                ? PI_DS_FLASH_MODEL
                : normalizedText.includes("deepseek") ||
          normalizedText.includes("ds4.1") ||
          normalizedText.includes("ds4") ||
          lowerParts.includes("ds")
                  ? PI_DS_FLASH_MODEL
                  : undefined;
  const thinkingCandidate = lowerParts.find((part) =>
    ["low", "medium", "high", "xhigh", "max", "ultra"].includes(part)
  );
  const thinking = cli === "dsh" ? undefined : thinkingCandidate;

  if (parts.length === 1 && code === parts[0]) {
    return {
      code,
      cli: "codex"
    };
  }

  if (parts.length > 8) {
    return undefined;
  }

  return {
    code,
    cli,
    model,
    thinking
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
    "4. 群里发 @机器人 codex GPT6 high 12",
    "5. 群里发 @机器人 codex 5.6 Sol xhigh 12",
    "6. 群里发 @机器人 pi ds4 flash 12",
    "7. 群里发 @机器人 新会话",
    "8. 群里发 @机器人 设置 goal 为 每次先检查测试再改代码",
    "9. 群里发 @机器人 清除 goal",
    "10. 群里发 @机器人 定时任务 添加 0 9 * * 1-5 | 生成工作日报",
    "11. 群里发 @机器人 临时任务：今天 18:30 检查线上流水线",
    "12. 群里发 @机器人 工具卡片 开（默认关闭，开启后同步工具调用过程）",
    "",
    "也支持自然语言，比如“把这个群切到 codex 的 12 号目录”“看看这个群现在绑到哪”。",
    "如果一句话里有多个配置动作，也会按顺序执行，比如“先暂停 1，再把 2 改成工作日 9 点发日报”。",
    "Codex 默认是 GPT-6 Astra + high；也可选 GPT-5.6 Sol，并指定 low / medium / high / xhigh / max / ultra。",
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
        "@机器人 把这个群切到 codex GPT6 high 2 号目录",
        "@机器人 把这个群切到 codex 5.6 Sol xhigh 2 号目录",
        "@机器人 把这个群切到 pi ds4 flash 2 号目录",
        "@机器人 pi 2 号目录",
        "@机器人 DS4 Flash 2 号目录",
        "@机器人 DeepSeek V4.1 Flash 2 号目录"
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

function truncateHandoffText(value: string, maxLength = 200): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
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
  patch: Partial<Pick<ChatSession, "controlThreadId" | "controlCli" | "controlReplyToMessageId">>,
  defaultWorkspace: string,
  observedAt = new Date().toISOString()
): ChatSession {
  return {
    chatId: message.chatId,
    threadId: existingSession?.threadId ?? `pending:group-session:${message.chatId}:unconfigured`,
    cli: existingSession?.cli ?? "codex",
    workspaceId: existingSession?.workspaceId ?? defaultWorkspace,
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
          threadId: "pending:group-control:missing",
          cli: "codex"
        };
      }
    },
    private readonly resumeCliCommands: SessionResumeCliCommands = {},
    private readonly usageStatsService?: UsageStatsService,
    private readonly tokenDailyReportDefaultTime = "23:00"
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
      existingSession.cli === workspaceResolution.cli;

    if (matchesActiveSession) {
      if (
        this.canSteer({
          session: existingSession,
          cli: workspaceResolution.cli,
          workspaceId: workspaceResolution.workspaceId,
          message
        })
      ) {
        await this.dispatchActiveOrNew(existingSession, message, {
          cli: workspaceResolution.cli,
          workspaceId: workspaceResolution.workspaceId
        });
        return;
      }

      if (this.canInterruptForLatestMessage(workspaceResolution.cli)) {
        await this.interruptActiveRunForLatestMessage(existingSession, message, {
          cli: workspaceResolution.cli,
          workspaceId: workspaceResolution.workspaceId
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
    const resolvedProvider = routing?.provider ?? existingSession?.provider;
    const resolvedModel = routing?.model ?? existingSession?.model;
    const resolvedThinking = routing?.thinking ?? existingSession?.thinking;
    const reusableSession =
      existingSession?.workspaceId === resolvedWorkspaceId &&
      existingSession.cli === resolvedCli
        ? existingSession
        : undefined;
    const initialThreadId = reusableSession?.threadId ?? `pending:${message.chatId}:${Date.now()}`;
    const handoff = reusableSession
      ? undefined
      : await this.buildCliSwitchHandoff(existingSession, {
          cli: resolvedCli
        });
    const turnMessage = handoff
      ? {
          ...message,
          text: [
            `[系统交接说明] 本会话由此前的 ${handoff.previousLabel} 处理，现在切换到 ${handoff.nextLabel}。`,
            handoff.summary
              ? "以下是从上一个执行环境恢复的上下文，请在后续工作中延续这些背景："
              : "上一个执行环境的上下文无法恢复，请把这次对话当作新的开端，必要时向用户确认之前的进展。",
            ...(handoff.summary ? [handoff.summary] : []),
            "---",
            "用户的新消息：",
            message.text
          ].join("\n")
        }
      : message;
    const observedAt = new Date().toISOString();

    this.sessionStore.save({
      chatId: message.chatId,
      threadId: initialThreadId,
      cli: resolvedCli,
      workspaceId: resolvedWorkspaceId,
      provider: resolvedProvider,
      model: resolvedModel,
      thinking: resolvedThinking,
      controlThreadId: existingSession?.controlThreadId,
      controlCli: existingSession?.controlCli,
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

    if (handoff) {
      await this.sendTextNotice(
        message.chatId,
        handoff.summary
          ? `已从 ${handoff.previousLabel} 切换到 ${handoff.nextLabel}，并恢复了之前的上下文。`
          : `已从 ${handoff.previousLabel} 切换到 ${handoff.nextLabel}，之前的上下文无法恢复，将重新开始。`,
        {
          messageId: message.messageId,
          context: "发送执行环境切换提示失败"
        }
      );
    }

    try {
      const threadId = reusableSession
        ? await this.codexWorker.ensureThread({
            session: this.sessionStore.get(message.chatId),
            cli: resolvedCli,
            workspaceId: resolvedWorkspaceId,
            provider: resolvedProvider,
            model: resolvedModel,
            thinking: resolvedThinking,
            message: turnMessage
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
          provider: resolvedProvider,
          model: resolvedModel,
          thinking: resolvedThinking
        },
        this.codexWorker.runTurn({
          session: this.sessionStore.get(message.chatId),
          cli: resolvedCli,
          workspaceId: resolvedWorkspaceId,
          provider: resolvedProvider,
          model: resolvedModel,
          thinking: resolvedThinking,
          message: turnMessage,
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

  private async buildCliSwitchHandoff(
    existingSession: ChatSession | undefined,
    routing: {
      cli: ChatCli;
    }
  ): Promise<
    | {
        previousLabel: string;
        nextLabel: string;
        summary?: string;
      }
    | undefined
  > {
    if (!existingSession) {
      return undefined;
    }

    const cliChanged = existingSession.cli !== routing.cli;
    if (!cliChanged) {
      return undefined;
    }

    const previousLabel = renderCliLabel(existingSession.cli);
    const nextLabel = renderCliLabel(routing.cli);

    if (existingSession.threadId.startsWith("pending:")) {
      return {
        previousLabel,
        nextLabel
      };
    }

    const summary =
      (await this.recoverPreviousSessionContext(existingSession)) ??
      this.buildConversationFallbackSummary(existingSession.chatId);

    return {
      previousLabel,
      nextLabel,
      summary
    };
  }

  private async recoverPreviousSessionContext(session: ChatSession): Promise<string | undefined> {
    const transcript = await readThreadTranscript({
      cli: session.cli,
      threadId: session.threadId,
      workspaceId: session.workspaceId
    });
    if (transcript) {
      const excerpt = renderTranscriptExcerpt(transcript);
      if (excerpt) {
        this.logger.info(
          {
            chatId: session.chatId,
            cli: session.cli,
            threadId: session.threadId,
            transcriptMessages: transcript.length
          },
          "已从旧线程的会话文件中恢复交接上下文"
        );
        return ["以下是从上一个执行环境的会话文件中恢复的最近对话记录：", excerpt].join("\n");
      }
    }

    return this.summarizePreviousSessionThread(session);
  }

  private async summarizePreviousSessionThread(session: ChatSession): Promise<string | undefined> {
    const handoffMessage: IncomingChatMessage = {
      chatId: session.chatId,
      chatType: session.chatType ?? "group",
      messageId: `session-handoff:${session.chatId}:${Date.now()}`,
      senderId: "system:cli-handoff",
      senderName: "cli-handoff",
      senderType: "system",
      text: [
        "这个会话即将迁移到另一个 CLI / 执行环境，这是一次上下文交接。",
        "请用中文简要总结到目前为止的上下文：用户的目标、已完成的工作、关键决定、待办事项和重要文件（300 字以内）。",
        "不要调用任何工具，不要修改任何文件，只返回纯文本摘要。"
      ].join("\n"),
      mentionsBot: false,
      raw: {}
    };

    let summary: string | undefined;
    let lastError: string | undefined;
    try {
      for await (const event of this.codexWorker.runTurn({
        cli: session.cli,
        workspaceId: session.workspaceId,
        provider: session.provider,
        model: session.model,
        thinking: session.thinking,
        message: handoffMessage,
        threadId: session.threadId
      })) {
        if (event.kind === "assistant_message_completed" && event.text.trim()) {
          summary = event.text;
        }

        if (event.kind === "error") {
          lastError = event.message;
        }
      }
    } catch (error) {
      this.logger.warn(
        {
          chatId: session.chatId,
          cli: session.cli,
          threadId: session.threadId,
          error: error instanceof Error ? error.message : String(error)
        },
        "旧线程交接摘要失败，将退回到本地对话记录"
      );
      return undefined;
    }

    if (lastError) {
      this.logger.warn(
        {
          chatId: session.chatId,
          cli: session.cli,
          threadId: session.threadId,
          error: lastError
        },
        "旧线程交接摘要未成功，将退回到本地对话记录"
      );
      return undefined;
    }

    return summary?.trim() || undefined;
  }

  private buildConversationFallbackSummary(chatId: string): string | undefined {
    const assistantItems = this.conversationStore
      .list()
      .filter(
        (item) =>
          item.chatId === chatId &&
          item.kind === "assistant_text" &&
          item.phase === "completed" &&
          typeof item.content === "string" &&
          item.content.trim()
      )
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(-6);

    const lastUserMessage = this.sessionStore.get(chatId)?.lastUserMessagePreview;
    if (assistantItems.length === 0 && !lastUserMessage) {
      return undefined;
    }

    return [
      "以下是本地对话记录里的最近内容：",
      lastUserMessage
        ? `最近的用户消息：${truncateHandoffText(unwrapUserVisibleText(lastUserMessage))}`
        : undefined,
      assistantItems.length > 0 ? "最近的助手输出：" : undefined,
      ...assistantItems.map(
        (item) =>
          `- [${item.source === "final_answer" ? "最终答复" : "过程摘要"}] ${truncateHandoffText(item.content ?? "")}`
      )
    ]
      .filter(Boolean)
      .join("\n");
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

  private async steerMessage(
    messageSession: ReturnType<SessionStore["get"]>,
    message: IncomingChatMessage,
    routing?: ChatRouting
  ) {
    if (!messageSession?.activeRunId || !messageSession.activeTurnId) {
      await this.handleMessage(message);
      return;
    }

    const workspaceId = messageSession.workspaceId ?? this.defaultWorkspace;
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

    const activeRun = this.runStore.get(messageSession.activeRunId);
    const activeRunElapsedMs = activeRun
      ? Date.now() - new Date(activeRun.startedAt).getTime()
      : 0;

    try {
      await this.codexWorker.steerTurn?.({
        session: messageSession,
        cli: messageSession.cli,
        workspaceId,
        provider: messageSession.provider,
        model: messageSession.model,
        thinking: messageSession.thinking,
        message,
        threadId: messageSession.threadId,
        turnId: messageSession.activeTurnId
      });

      if (activeRunElapsedMs >= STEER_ACKNOWLEDGEMENT_THRESHOLD_MS) {
        await this.sendTextNotice(
          message.chatId,
          "已收到你的新消息，正在把它交给当前仍在执行的任务。",
          {
            messageId: message.messageId,
            context: "发送 steer 回执失败"
          }
        );
      }
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);

      if ((error as { code?: string } | undefined)?.code === "KIMI_TURN_BLOCKED_WAIT") {
        this.logger.info(
          {
            chatId: message.chatId,
            messageId: message.messageId,
            threadId: messageSession.threadId,
            turnId: messageSession.activeTurnId,
            activeRunId: messageSession.activeRunId
          },
          "Kimi turn 正阻塞在等待后台任务，steer 无法立即生效，改为中断后以最新消息接管"
        );
        await this.interruptActiveRunForLatestMessage(
          messageSession,
          message,
          routing ?? {
            cli: messageSession.cli,
            workspaceId
          }
        );
        return;
      }

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
        await this.steerMessage(session, message, routing);
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
        context: "发送最新消息接管提示失败"
      });
      return;
    }

    const interruptionMessage = "当前任务已被后续消息中断。";

    await this.codexWorker.interruptTurn({
      session: existingSession,
      cli: existingSession.cli,
      workspaceId: existingSession.workspaceId,
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
      existingSession.workspaceId === workspaceResolution.workspaceId &&
      existingSession.cli === workspaceResolution.cli
    ) {
      if (
        this.canSteer({
          session: existingSession,
          cli: workspaceResolution.cli,
          workspaceId: workspaceResolution.workspaceId,
          provider: workspaceResolution.provider,
          model: workspaceResolution.model,
          thinking: workspaceResolution.thinking,
          message
        })
      ) {
        await this.dispatchActiveOrNew(existingSession, message, {
          cli: workspaceResolution.cli,
          workspaceId: workspaceResolution.workspaceId,
          provider: workspaceResolution.provider,
          model: workspaceResolution.model,
          thinking: workspaceResolution.thinking
        });
        return {
          outcome: "triggered"
        };
      }

      // CLI 不支持 steer（例如 Kimi ACP）时不要并发起新 turn，否则会被
      // 拒绝为 "another turn is already in progress"。交给下一个轮询周期重试。
      this.logger?.info(
        {
          chatId: task.chatId,
          taskId: task.taskId,
          cli: workspaceResolution.cli,
          activeRunId: existingSession.activeRunId
        },
        "定时任务触发时该群仍有活跃任务且 CLI 不支持 steer，本轮跳过"
      );
      return {
        outcome: "busy"
      };
    }

    await this.handleMessage(message, workspaceResolution);
    return {
      outcome: "triggered"
    };
  }

  private async handleControlMessage(message: IncomingChatMessage): Promise<boolean> {
    const toolCardsAction = parseToolCardsCommand(message);
    if (toolCardsAction) {
      await this.handleToolCardsCommand(message, toolCardsAction);
      return true;
    }

    if (
      this.usageStatsService &&
      QUOTA_COMMAND.test(stripMentions(message.text)) &&
      (message.chatType !== "group" || message.mentionsBot)
    ) {
      await this.handleQuotaCommand(message);
      return true;
    }

    const tokenReportCommand =
      message.chatType !== "group" || message.mentionsBot
        ? parseTokenDailyReportCommand(message)
        : undefined;
    if (tokenReportCommand) {
      await this.handleTokenDailyReportCommand(message, tokenReportCommand);
      return true;
    }

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

    const modelSuffix = [result.model, result.thinking ? `thinking=${result.thinking}` : undefined]
      .filter(Boolean)
      .map((value) => ` / ${value}`)
      .join("");
    await this.sendTextNotice(
      message.chatId,
      [
        `已将这个群绑定到 ${renderCliLabel(result.cli)} CLI 工作区 ${result.entry.code}: ${result.entry.workspace}${modelSuffix}`,
        `后续这个群里的任务都会通过 ${result.cli} 从 ${result.entry.workspaceId} 启动。`
      ].join("\n"),
      {
        messageId: message.messageId,
        context: "发送工作区配置提示失败"
      }
    );
    return true;
  }

  private async handleTokenDailyReportCommand(
    message: IncomingChatMessage,
    command: TokenDailyReportCommand
  ): Promise<void> {
    const session = this.sessionStore.get(message.chatId);
    const defaultTime = this.tokenDailyReportDefaultTime;

    if (command.action === "status") {
      const enabled = session?.tokenDailyReportEnabled === true;
      const time = formatTimeOfDay(session?.tokenDailyReportTime, defaultTime);
      await this.sendTextNotice(
        message.chatId,
        [
          `这个会话的 token 日报当前是${enabled ? "开启" : "关闭"}状态（默认关闭）。`,
          `发送时间：${time}（本地时区）。`,
          "发送“打开 token 日报”“关闭 token 日报”，或“token 日报 23:30”调整时间。"
        ].join("\n"),
        {
          messageId: message.messageId,
          context: "发送 token 日报状态提示失败"
        }
      );
      return;
    }

    if (!session) {
      await this.sendTextNotice(
        message.chatId,
        "这个会话还没有任务记录，先绑定工作区或先聊一句，再设置 token 日报开关。",
        {
          messageId: message.messageId,
          context: "发送 token 日报设置提示失败"
        }
      );
      return;
    }

    if (command.action === "set_time") {
      if (!parseTimeOfDay(command.time)) {
        await this.sendTextNotice(message.chatId, "时间格式不正确，请用 HH:mm，例如 23:30。", {
          messageId: message.messageId,
          context: "发送 token 日报设置提示失败"
        });
        return;
      }

      const time = formatTimeOfDay(command.time, defaultTime);
      this.sessionStore.save({
        ...session,
        tokenDailyReportTime: time,
        updatedAt: new Date().toISOString()
      });
      await this.sendTextNotice(
        message.chatId,
        `已把 token 日报发送时间设为 ${time}（本地时区）。`,
        {
          messageId: message.messageId,
          context: "发送 token 日报设置提示失败"
        }
      );
      return;
    }

    const enabled = command.action === "on";
    this.sessionStore.save({
      ...session,
      tokenDailyReportEnabled: enabled,
      tokenDailyReportTime: session.tokenDailyReportTime ?? defaultTime,
      tokenDailyReportLastSentDate: enabled ? session.tokenDailyReportLastSentDate : undefined,
      updatedAt: new Date().toISOString()
    });
    await this.sendTextNotice(
      message.chatId,
      enabled
        ? `已为这个会话开启 token 日报，每天 ${formatTimeOfDay(
            session.tokenDailyReportTime,
            defaultTime
          )} 会发送当天的 token 消耗。`
        : "已为这个会话关闭 token 日报。",
      {
        messageId: message.messageId,
        context: "发送 token 日报设置提示失败"
      }
    );
  }

  private async handleQuotaCommand(message: IncomingChatMessage): Promise<void> {
    if (!this.usageStatsService) {
      return;
    }

    let report: string;
    try {
      report = await this.usageStatsService.buildReport();
    } catch (error) {
      this.logger.error(
        {
          chatId: message.chatId,
          messageId: message.messageId,
          error: error instanceof Error ? error.message : String(error)
        },
        "生成额度用量统计失败"
      );
      report = "额度用量统计暂时生成失败，请稍后再试。";
    }

    await this.sendTextNotice(message.chatId, report, {
      messageId: message.messageId,
      context: "发送额度用量统计失败",
      ...buildControlReplyMetadata(message)
    });
  }

  private async handleToolCardsCommand(
    message: IncomingChatMessage,
    action: ToolCardsCommandAction
  ): Promise<void> {
    const session = this.sessionStore.get(message.chatId);

    if (action === "status") {
      const enabled = session?.toolCardsEnabled === true;
      await this.sendTextNotice(
        message.chatId,
        `这个会话的工具卡片当前是${enabled ? "开启" : "关闭"}状态（默认关闭）。发送“工具卡片 开”或“工具卡片 关”切换。`,
        {
          messageId: message.messageId,
          context: "发送工具卡片状态提示失败"
        }
      );
      return;
    }

    if (!session) {
      await this.sendTextNotice(
        message.chatId,
        "这个会话还没有任务记录，先绑定工作区或先聊一句，再设置工具卡片开关。",
        {
          messageId: message.messageId,
          context: "发送工具卡片设置提示失败"
        }
      );
      return;
    }

    const enabled = action === "on";
    this.sessionStore.save({
      ...session,
      toolCardsEnabled: enabled,
      updatedAt: new Date().toISOString()
    });
    await this.sendTextNotice(
      message.chatId,
      enabled
        ? "已为这个会话开启工具卡片推送，后续工具调用的命令、输出和涉及文件都会以卡片形式同步到这里。"
        : "已为这个会话关闭工具卡片推送，后续只发送思考和最终答复。",
      {
        messageId: message.messageId,
        context: "发送工具卡片设置提示失败"
      }
    );
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
          controlThreadId,
          controlThreadCli:
            existingSession?.controlCli ?? (existingSession?.controlThreadId ? "codex" : undefined)
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
            controlCli: result.cli,
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
      session.workspaceId !== binding.workspaceId
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
                `工作区：${currentBindingResolution.workspaceId}`,
                `模型：${currentBindingResolution.model ?? "使用运行时默认值"}`,
                `思考深度：${currentBindingResolution.thinking ?? "使用运行时默认值"}`,
                `Codex native goal：${currentBindingResolution.cli === "codex" ? nativeGoal ?? "未设置" : "当前不是 Codex 绑定"}`,
                renderSessionResumeLine(
                  currentBindingResolution,
                  this.sessionStore.get(message.chatId),
                  this.resumeCliCommands
                )
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
      case "show_quota": {
        if (!this.usageStatsService) {
          await this.sendTextNotice(
            message.chatId,
            "当前环境未配置额度用量统计服务。",
            {
              messageId: message.messageId,
              context: "发送额度用量统计失败",
              ...replyMetadata
            }
          );
          return;
        }
        await this.sendTextNotice(
          message.chatId,
          await this.usageStatsService.buildReport(),
          {
            messageId: message.messageId,
            context: "发送额度用量统计失败",
            ...replyMetadata
          }
        );
        return;
      }
      case "bind_workspace": {
        const result = await this.workspaceResolver.bindGroupWorkspace({
          chatId: message.chatId,
          cli: intent.cli,
          code: intent.code,
          provider: intent.provider,
          model: intent.model,
          thinking: intent.thinking
        });
        await this.sendTextNotice(
          message.chatId,
          result.ok
            ? [
                `已将这个群绑定到 ${renderCliLabel(result.cli)} CLI 工作区 ${result.entry.code}: ${result.entry.workspace}${result.model ? ` / ${result.model}` : ""}${result.thinking ? ` / thinking=${result.thinking}` : ""}`,
                `后续普通群消息会通过 ${result.cli} 从 ${result.entry.workspaceId} 启动。`,
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
      provider: currentBindingResolution.provider,
      model: currentBindingResolution.model,
      thinking: currentBindingResolution.thinking,
      controlThreadId: existingSession?.controlThreadId,
      controlCli: existingSession?.controlCli,
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
          provider: currentBindingResolution.provider,
          model: currentBindingResolution.model,
          thinking: currentBindingResolution.thinking
        },
        this.codexWorker.runGoal({
          session: this.sessionStore.get(message.chatId),
          cli: "codex",
          workspaceId: currentBindingResolution.workspaceId,
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
      message
    });
    this.sessionStore.save({
      chatId: message.chatId,
      threadId,
      cli: workspaceResolution.cli,
      workspaceId: workspaceResolution.workspaceId,
      provider: workspaceResolution.provider,
      model: workspaceResolution.model,
      thinking: workspaceResolution.thinking,
      controlThreadId: existingSession?.controlThreadId,
      controlCli: existingSession?.controlCli,
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
        cli: workspaceResolution.cli
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
        provider: context.provider,
        model: context.model,
        thinking: context.thinking,
        message: context.message
      }) ?? Boolean(this.codexWorker.steerTurn)
    );
  }

  private canInterruptForLatestMessage(cli: ChatCli): boolean {
    return (
      (cli === "kimi" || cli === "pi" || cli === "claude" || cli === "dsh") &&
      Boolean(this.codexWorker.interruptTurn)
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
