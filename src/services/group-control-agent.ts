import { randomUUID } from "node:crypto";

import type { ChatCli, CodexEvent, IncomingChatMessage, ScheduledTaskRecord } from "../domain/types.js";
import type { ChatWorkspaceCatalogEntry } from "./chat-workspace-resolver.js";
import type { CodexWorker } from "../integrations/codex/codex-worker.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

export type GroupControlIntent =
  | {
      kind: "help";
      detail: string;
    }
  | {
      kind: "list_workspaces";
    }
  | {
      kind: "show_binding";
    }
  | {
      kind: "bind_workspace";
      cli: ChatCli;
      code: string;
    }
  | {
      kind: "list_schedules";
    }
  | {
      kind: "create_schedule";
      cron: string;
      prompt: string;
    }
  | {
      kind: "pause_schedule" | "resume_schedule" | "delete_schedule";
      taskId: string;
    }
  | {
      kind: "new_session";
    };

export interface GroupControlContext {
  catalog: ChatWorkspaceCatalogEntry[];
  scheduledTasks: ScheduledTaskRecord[];
  currentBinding:
    | {
        configured: true;
        cli: ChatCli;
        workspaceId: string;
      }
    | {
        configured: false;
        detail: string;
      };
}

export interface GroupControlAgent {
  interpret(message: IncomingChatMessage, context: GroupControlContext): Promise<GroupControlIntent>;
}

function stripMentions(text: string): string {
  return text.replace(/@\S+/g, " ").trim();
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/i)?.[1];
  if (fenced) {
    candidates.unshift(fenced.trim());
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  throw new Error("控制 agent 没有返回可解析的 JSON。");
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`控制 agent 返回缺少 ${key}。`);
  }

  return value.trim();
}

function normalizeCli(value: string): ChatCli {
  const normalized = value.trim().toLowerCase();
  if (normalized === "codex" || normalized === "claude" || normalized === "kimi") {
    return normalized;
  }

  throw new Error(`控制 agent 返回了不支持的 CLI：${value}`);
}

function parseIntent(raw: string): GroupControlIntent {
  const parsed = parseJsonObject(raw);
  const kind = requireString(parsed, "kind");

  switch (kind) {
    case "list_workspaces":
    case "show_binding":
    case "list_schedules":
    case "new_session":
      return {
        kind
      };
    case "bind_workspace":
      return {
        kind,
        cli: normalizeCli(requireString(parsed, "cli")),
        code: requireString(parsed, "code")
      };
    case "create_schedule":
      return {
        kind,
        cron: requireString(parsed, "cron"),
        prompt: requireString(parsed, "prompt")
      };
    case "pause_schedule":
    case "resume_schedule":
    case "delete_schedule":
      return {
        kind,
        taskId: requireString(parsed, "taskId")
      };
    case "help":
      return {
        kind,
        detail: requireString(parsed, "detail")
      };
    default:
      throw new Error(`控制 agent 返回了不支持的动作：${kind}`);
  }
}

function renderCatalog(entries: ChatWorkspaceCatalogEntry[]): string {
  if (entries.length === 0) {
    return "- 当前没有可绑定的子目录";
  }

  return entries.map((entry) => `- ${entry.code}: ${entry.workspace} (${entry.workspaceId})`).join("\n");
}

function renderScheduledTasks(tasks: ScheduledTaskRecord[]): string {
  if (tasks.length === 0) {
    return "- 当前没有定时任务";
  }

  return tasks
    .map(
      (task) =>
        `- ${task.taskId}: ${task.status} | cron=${task.cron} | prompt=${JSON.stringify(task.prompt)}`
    )
    .join("\n");
}

function buildInterpreterPrompt(message: IncomingChatMessage, context: GroupControlContext): string {
  const strippedMessage = stripMentions(message.text);
  const currentBinding = context.currentBinding.configured
    ? `已绑定，cli=${context.currentBinding.cli}，workspace=${context.currentBinding.workspaceId}`
    : `未绑定。${context.currentBinding.detail}`;

  return [
    "这是一个群聊配置控制面的内部解析请求。",
    "不要调用任何工具，不要修改任何文件，不要发送任何飞书消息。",
    "只返回一个 JSON 对象，不要输出 Markdown，不要加解释。",
    "",
    "你的职责：把群里 @机器人的配置类消息解析成结构化动作。",
    "所有群里的 @机器人 消息都保留给配置控制面使用，不用于普通项目任务。",
    "如果用户是在群里 @机器人 提项目任务或闲聊，返回 help，并明确提示“群里 @机器人 只用于配置，请直接发普通消息处理项目任务”。",
    "",
    "可返回的 kind：",
    '- {"kind":"list_workspaces"}',
    '- {"kind":"show_binding"}',
    '- {"kind":"bind_workspace","cli":"codex|claude|kimi","code":"<目录编号>"}',
    '- {"kind":"list_schedules"}',
    '- {"kind":"create_schedule","cron":"<5段 cron>","prompt":"<任务内容>"}',
    '- {"kind":"pause_schedule","taskId":"<编号>"}',
    '- {"kind":"resume_schedule","taskId":"<编号>"}',
    '- {"kind":"delete_schedule","taskId":"<编号>"}',
    '- {"kind":"new_session"}',
    '- {"kind":"help","detail":"<给用户的简短说明>"}',
    "",
    "规则：",
    "- schedule 只支持循环 cron，不支持一次性“明天/两个小时后”。这类需求返回 help。",
    "- 可以把自然语言时间转成 cron，例如“工作日早上 9 点” -> 0 9 * * 1-5。",
    "- 可以根据当前定时任务列表把“第一个/日报那条”解析成 taskId。",
    "- 绑定工作区时，必须从下面给出的目录编号里选 code。",
    "- 如果用户只说“工作区”“有哪些目录”，返回 list_workspaces。",
    "- 如果用户问当前这个群绑到哪里，返回 show_binding。",
    "- 如果用户说“新会话”“重开会话”，返回 new_session。",
    "- 如果信息不足或不适合执行，返回 help。",
    "",
    `当前群 chatId: ${message.chatId}`,
    "当前群工作区绑定：",
    currentBinding,
    "",
    "可绑定工作区目录：",
    renderCatalog(context.catalog),
    "",
    "当前群定时任务：",
    renderScheduledTasks(context.scheduledTasks),
    "",
    "用户原始消息：",
    message.text,
    "",
    "用户消息（已去掉 @提及）：",
    strippedMessage || "(空)"
  ].join("\n");
}

export class CodexGroupControlAgent implements GroupControlAgent {
  constructor(
    private readonly codexWorker: CodexWorker,
    private readonly defaultWorkspace: string,
    private readonly logger?: LoggerLike
  ) {}

  async interpret(message: IncomingChatMessage, context: GroupControlContext): Promise<GroupControlIntent> {
    const internalMessage: IncomingChatMessage = {
      chatId: message.chatId,
      chatType: message.chatType,
      messageId: `control:${message.messageId}`,
      senderId: "system:group-control-agent",
      senderName: "group-control-agent",
      senderType: "system",
      tenantKey: message.tenantKey,
      text: buildInterpreterPrompt(message, context),
      mentionsBot: false,
      raw: {
        sourceMessageId: message.messageId
      }
    };

    const threadId = `pending:group-control:${message.chatId}:${randomUUID()}`;

    let finalAnswer: string | undefined;
    let lastError: string | undefined;

    for await (const event of this.codexWorker.runTurn({
      cli: "codex",
      workspaceId: this.defaultWorkspace,
      message: internalMessage,
      threadId
    })) {
      if (event.kind === "assistant_message_completed") {
        finalAnswer = event.text;
      }

      if (event.kind === "error") {
        lastError = event.message;
      }
    }

    if (lastError) {
      throw new Error(lastError);
    }

    if (!finalAnswer?.trim()) {
      throw new Error("控制 agent 没有返回可见结果。");
    }

    this.logger?.info(
      {
        chatId: message.chatId,
        messageId: message.messageId,
        finalAnswerPreview: finalAnswer.slice(0, 200)
      },
      "群配置控制 agent 已返回结构化结果"
    );
    return parseIntent(finalAnswer);
  }
}
