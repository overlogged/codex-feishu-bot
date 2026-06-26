import { randomUUID } from "node:crypto";

import type {
  ChatCli,
  ChatExecutionMode,
  CodexEvent,
  IncomingChatMessage,
  ScheduledTaskRecord
} from "../domain/types.js";
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
      executionMode: ChatExecutionMode;
      code: string;
      provider?: string;
      model?: string;
      thinking?: string;
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
      kind: "update_schedule";
      taskId: string;
      cron?: string;
      prompt?: string;
    }
  | {
      kind: "pause_schedule" | "resume_schedule" | "delete_schedule";
      taskId: string;
    }
  | {
      kind: "new_session";
    }
  | {
      kind: "set_goal";
      goal: string;
    }
  | {
      kind: "clear_goal";
    };

export interface GroupControlContext {
  catalog: ChatWorkspaceCatalogEntry[];
  scheduledTasks: ScheduledTaskRecord[];
  goal?: string;
  currentBinding:
    | {
        configured: true;
        cli: ChatCli;
        executionMode: ChatExecutionMode;
        workspaceId: string;
        provider?: string;
        model?: string;
        thinking?: string;
      }
    | {
        configured: false;
        detail: string;
      };
}

export interface GroupControlAgent {
  interpret(
    message: IncomingChatMessage,
    context: GroupControlContext,
    options?: {
      controlThreadId?: string;
    }
  ): Promise<{
    intents: GroupControlIntent[];
    threadId: string;
  }>;
}

function isRecoverableControlThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no rollout found for thread id/i.test(message) || /thread\/resume/i.test(message);
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
  if (
    normalized === "codex" ||
    normalized === "claude" ||
    normalized === "kimi" ||
    normalized === "pi" ||
    normalized === "deepseek" ||
    normalized === "ds" ||
    normalized === "ds4"
  ) {
    return normalized === "deepseek" || normalized === "ds" || normalized === "ds4"
      ? "pi"
      : normalized;
  }

  throw new Error(`控制 agent 返回了不支持的 CLI：${value}`);
}

function normalizeExecutionMode(value: string): ChatExecutionMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "host") {
    return "host";
  }

  if (normalized === "docker" || normalized === "dodocker" || normalized === "do-docker") {
    return "docker";
  }

  throw new Error(`控制 agent 返回了不支持的执行模式：${value}`);
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseIntentRecord(parsed: Record<string, unknown>): GroupControlIntent {
  const kind = requireString(parsed, "kind");

  switch (kind) {
    case "list_workspaces":
    case "show_binding":
    case "list_schedules":
    case "new_session":
    case "clear_goal":
      return {
        kind
      };
    case "set_goal":
      return {
        kind,
        goal: requireString(parsed, "goal")
      };
    case "bind_workspace":
      return {
        kind,
        cli: normalizeCli(requireString(parsed, "cli")),
        executionMode: normalizeExecutionMode(
          typeof parsed.executionMode === "string" ? parsed.executionMode : "host"
        ),
        code: requireString(parsed, "code"),
        provider: optionalString(parsed, "provider"),
        model: optionalString(parsed, "model"),
        thinking: optionalString(parsed, "thinking")
      };
    case "create_schedule":
      return {
        kind,
        cron: requireString(parsed, "cron"),
        prompt: requireString(parsed, "prompt")
      };
    case "update_schedule": {
      const cron = optionalString(parsed, "cron");
      const prompt = optionalString(parsed, "prompt");
      if (!cron && !prompt) {
        throw new Error("控制 agent 修改定时任务时，至少要提供 cron 或 prompt。");
      }

      return {
        kind,
        taskId: requireString(parsed, "taskId"),
        cron,
        prompt
      };
    }
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

function parseIntents(raw: string): GroupControlIntent[] {
  const parsed = parseJsonObject(raw);
  const actions = parsed.actions;
  if (Array.isArray(actions)) {
    if (actions.length === 0) {
      throw new Error("控制 agent 返回的 actions 不能为空。");
    }

    return actions.map((action, index) => {
      if (!action || typeof action !== "object" || Array.isArray(action)) {
        throw new Error(`控制 agent 返回的第 ${index + 1} 个动作不是对象。`);
      }

      return parseIntentRecord(action as Record<string, unknown>);
    });
  }

  return [parseIntentRecord(parsed)];
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
  const currentGoal = context.goal?.trim() || "(未设置或当前不是 Codex 绑定)";
  const currentBinding = context.currentBinding.configured
    ? [
        `已绑定，cli=${context.currentBinding.cli}`,
        `executionMode=${context.currentBinding.executionMode}`,
        `workspace=${context.currentBinding.workspaceId}`,
        context.currentBinding.model ? `model=${context.currentBinding.model}` : undefined,
        context.currentBinding.provider ? `provider=${context.currentBinding.provider}` : undefined,
        context.currentBinding.thinking ? `thinking=${context.currentBinding.thinking}` : undefined
      ]
        .filter(Boolean)
        .join("，")
    : `未绑定。${context.currentBinding.detail}`;

  return [
    "这是一个群聊配置控制面的内部解析请求。",
    "不要调用任何工具，不要修改任何文件，不要发送任何飞书消息。",
    "只返回 JSON，不要输出 Markdown，不要加解释。",
    "",
    "你的职责：把群里 @机器人的配置类消息解析成结构化动作。",
    "所有群里的 @机器人 消息都会进入这个群自己长期复用的配置线程，不用于普通项目任务。",
    "如果用户是在群里 @机器人 提项目任务或闲聊，返回 help，并明确提示“群里 @机器人 只用于配置，请直接发普通消息处理项目任务”。",
    "",
    "返回格式：",
    '- 单动作时可直接返回 {"kind":"..."}',
    '- 多动作时返回 {"actions":[{"kind":"..."}, {"kind":"..."}]}',
    "- 如果一句话里包含多步控制，请按用户表达顺序放进 actions。",
    "",
    "可返回的 kind：",
    '- {"kind":"list_workspaces"}',
    '- {"kind":"show_binding"}',
    '- {"kind":"bind_workspace","cli":"codex|claude|kimi|pi|deepseek|ds","executionMode":"host|docker","code":"<目录编号>"[,"provider":"<可选 provider>","model":"<可选模型>","thinking":"<可选 thinking>"]}',
    '- {"kind":"list_schedules"}',
    '- {"kind":"create_schedule","cron":"<5段 cron>","prompt":"<任务内容>"}',
    '- {"kind":"update_schedule","taskId":"<编号>","cron":"<可选 5段 cron>","prompt":"<可选 新任务内容>"}',
    '- {"kind":"pause_schedule","taskId":"<编号>"}',
    '- {"kind":"resume_schedule","taskId":"<编号>"}',
    '- {"kind":"delete_schedule","taskId":"<编号>"}',
    '- {"kind":"new_session"}',
    '- {"kind":"set_goal","goal":"<Codex 原生 /goal 要持续推进的目标>"}',
    '- {"kind":"clear_goal"}',
    '- {"kind":"help","detail":"<给用户的简短说明>"}',
    "",
    "规则：",
    "- schedule 只支持循环 cron，不支持一次性“明天/两个小时后”。这类需求返回 help。",
    "- 可以把自然语言时间转成 cron，例如“工作日早上 9 点” -> 0 9 * * 1-5。",
    "- 可以根据当前定时任务列表把“第一个/日报那条”解析成 taskId。",
    "- 一句话里可以同时包含多个配置动作、多个定时任务修改，或先查看再修改，请按顺序拆成 actions。",
    "- 用户说“改一下这个任务”“把 2 号改成工作日 9 点”这类，优先返回 update_schedule。",
    "- 用户说“撤销/取消/删掉某个定时任务”时，可根据语义返回 pause_schedule 或 delete_schedule。",
    "- 绑定工作区时，必须从下面给出的目录编号里选 code。",
    "- 绑定工作区时，如果用户没有明确指定 CLI，cli 默认返回 codex。",
    "- 如果用户没有明确提模式，executionMode 默认返回 host。",
    "- 如果用户明确说“docker 模式 / 容器模式 / dodocker”，executionMode 返回 docker。",
    "- docker 模式当前支持 codex / kimi / pi；如果用户说 claude + docker，返回 help 解释限制。",
    "- 用户说 'deepseek'、'ds'、'ds4'、'DeepSeek V4 Pro'、'DS4 Pro'、'DeepSeek V4 Flash'、'DS4 Flash' 时，cli 应该返回 pi，并在 model 里分别返回 deepseek-v4-pro 或 deepseek-v4-flash。",
    "- 用户说 'pi'、'ds' 或 'deepseek' 但没有指定模型时，不填 model；用户明确说 V4 Pro / V4 Flash / DS4 Pro / DS4 Flash 时，必须填上对应 model。",
    "- provider 字段只在用户明确指定时才填，否则省略（让运行时按环境变量或默认规则处理）。",
    "- 如果用户只说“工作区”“有哪些目录”，返回 list_workspaces。",
    "- 如果用户问当前这个群绑到哪里，返回 show_binding。",
    "- 如果用户说“新会话”“重开会话”，返回 new_session。",
    "- 如果用户说“设置 goal/目标/长期目标/当前目标 为 ...”，返回 set_goal，并把目标正文放进 goal。",
    "- 如果用户说“清除 goal/目标/长期目标/当前目标”，返回 clear_goal。",
    "- goal 指 Codex 原生 /goal 功能，只支持当前群绑定到 Codex 时执行；不要把它理解成普通 prompt 上下文。",
    "- 如果信息不足或不适合执行，返回 help。",
    "",
    `当前群 chatId: ${message.chatId}`,
    "当前群工作区绑定：",
    currentBinding,
    "",
    "当前群 Codex native goal：",
    currentGoal,
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
    private readonly logger?: LoggerLike,
    private readonly cli: ChatCli = "codex"
  ) {}

  async interpret(
    message: IncomingChatMessage,
    context: GroupControlContext,
    options?: {
      controlThreadId?: string;
    }
  ): Promise<{
    intents: GroupControlIntent[];
    threadId: string;
  }> {
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

    const runControlTurn = async (threadId: string) => {
      let finalAnswer: string | undefined;
      let lastError: string | undefined;
      let resolvedThreadId = threadId;

      for await (const event of this.codexWorker.runTurn({
        cli: this.cli,
        executionMode: "host",
        workspaceId: this.defaultWorkspace,
        message: internalMessage,
        threadId: resolvedThreadId
      })) {
        if (event.kind === "thread_bound") {
          resolvedThreadId = event.threadId;
        }

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
      return {
        intents: parseIntents(finalAnswer),
        threadId: resolvedThreadId
      };
    };

    const initialThreadId =
      options?.controlThreadId ?? `pending:group-control:${message.chatId}:${randomUUID()}`;

    try {
      return await runControlTurn(initialThreadId);
    } catch (error) {
      if (!options?.controlThreadId || !isRecoverableControlThreadError(error)) {
        throw error;
      }

      this.logger?.warn(
        {
          chatId: message.chatId,
          messageId: message.messageId,
          controlThreadId: options.controlThreadId,
          error: error instanceof Error ? error.message : String(error)
        },
        "群配置控制 thread 恢复失败，改为新建控制 thread"
      );

      return runControlTurn(`pending:group-control:${message.chatId}:${randomUUID()}`);
    };
  }
}
