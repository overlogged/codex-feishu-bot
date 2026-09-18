import { randomUUID } from "node:crypto";

import type {
  ChatCli,
  CodexEvent,
  IncomingChatMessage,
  ScheduledTaskRecord
} from "../domain/types.js";
import type { ChatWorkspaceCatalogEntry } from "./chat-workspace-resolver.js";
import type { CodexWorker } from "../integrations/codex/codex-worker.js";
import {
  readThreadTranscript,
  renderTranscriptExcerpt
} from "../integrations/codex/thread-transcript.js";

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
      kind: "show_quota";
    }
  | {
      kind: "bind_workspace";
      cli: ChatCli;
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
      kind: "create_one_time_schedule";
      prompt: string;
      runAt?: string;
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

export interface GroupControlInterpretOptions {
  controlThreadId?: string;
  controlThreadCli?: ChatCli;
}

export interface GroupControlAgent {
  interpret(
    message: IncomingChatMessage,
    context: GroupControlContext,
    options?: GroupControlInterpretOptions
  ): Promise<{
    intents: GroupControlIntent[];
    threadId: string;
    cli: ChatCli;
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
    normalized === "dsh"
  ) {
    return normalized;
  }

  // ds / deepseek 默认交给 dsh（DeepSeek Harness）；glm / openmodel 仍走 pi。
  if (normalized === "deepseek" || normalized === "ds" || normalized === "ds4") {
    return "dsh";
  }

  if (normalized === "glm" || normalized === "openmodel") {
    return "pi";
  }

  throw new Error(`控制 agent 返回了不支持的 CLI：${value}`);
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
    case "show_quota":
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
    case "bind_workspace": {
      const cli = normalizeCli(requireString(parsed, "cli"));
      return {
        kind,
        cli,
        code: requireString(parsed, "code"),
        // dsh 的模型/provider 由 profile 配置决定，忽略控制 agent 可能多填的字段。
        provider: cli === "dsh" ? undefined : optionalString(parsed, "provider"),
        model: cli === "dsh" ? undefined : optionalString(parsed, "model"),
        thinking: cli === "dsh" ? undefined : optionalString(parsed, "thinking")
      };
    }
    case "create_schedule":
      return {
        kind,
        cron: requireString(parsed, "cron"),
        prompt: requireString(parsed, "prompt")
      };
    case "create_one_time_schedule":
      return {
        kind,
        prompt: requireString(parsed, "prompt"),
        runAt: optionalString(parsed, "runAt")
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
    .map((task) => {
      const kind = task.kind === "once" ? "once" : "recurring";
      const schedule = kind === "once" ? `runAt=${task.runAt ?? task.nextRunAt ?? "未计划"}` : `cron=${task.cron ?? "未设置"}`;
      return `- ${task.taskId}: ${task.status} | ${kind} | ${schedule} | prompt=${JSON.stringify(task.prompt)}`;
    })
    .join("\n");
}

function formatLocalDateTime(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function buildInterpreterPrompt(
  message: IncomingChatMessage,
  context: GroupControlContext,
  handoff?: {
    fromCli: ChatCli;
    summary: string;
  }
): string {
  const strippedMessage = stripMentions(message.text);
  const currentGoal = context.goal?.trim() || "(未设置或当前不是 Codex 绑定)";
  const currentBinding = context.currentBinding.configured
    ? [
        `已绑定，cli=${context.currentBinding.cli}`,
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
    '- {"kind":"show_quota"}',
    '- {"kind":"bind_workspace","cli":"codex|claude|kimi|pi|deepseek|ds","code":"<目录编号>"[,"provider":"<可选 provider>","model":"<可选模型>","thinking":"<可选 thinking>"]}',
    '- {"kind":"list_schedules"}',
    '- {"kind":"create_schedule","cron":"<5段 cron>","prompt":"<任务内容>"}',
    '- {"kind":"create_one_time_schedule","prompt":"<任务内容>"[,"runAt":"<ISO 8601 时间>"]}',
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
    "- create_schedule 只用于循环定时任务，必须返回 5 段 cron。",
    "- 用户说“临时任务”“一次性任务”“只执行一次”“执行一次后删除”“某个时间点执行一次”时，返回 create_one_time_schedule。",
    "- create_one_time_schedule 如果用户指定了时间，把自然语言或相对时间转成 ISO 8601 runAt；如果用户没有指定时间，省略 runAt，运行时会尽快执行一次。",
    "- 解析相对时间时以当前时间（Asia/Shanghai）为基准。",
    "- 可以把自然语言时间转成 cron，例如“工作日早上 9 点” -> 0 9 * * 1-5。",
    "- 可以根据当前定时任务列表把“第一个/日报那条”解析成 taskId。",
    "- 一句话里可以同时包含多个配置动作、多个定时任务修改，或先查看再修改，请按顺序拆成 actions。",
    "- 用户说“改一下这个任务”“把 2 号改成工作日 9 点”这类，优先返回 update_schedule。",
    "- 用户说“撤销/取消/删掉某个定时任务”时，可根据语义返回 pause_schedule 或 delete_schedule。",
    "- 绑定工作区时，必须从下面给出的目录编号里选 code。",
    "- 绑定工作区时，如果用户没有明确指定 CLI，cli 默认返回 codex。",
    "- Codex 只支持两个模型选项：GPT-6 / GPT6 / Astra 对应 model=gpt-6-astra；GPT-5.6 Sol / 5.6 Sol / 5.6 Soul 对应 model=gpt-5.6-sol。",
    "- 绑定到 Codex 且用户没有指定模型时，model 默认返回 gpt-6-astra。",
    "- Codex 思考深度可指定 low / medium / high / xhigh / max / ultra；用户说低/中/高/嗨/极高/最高/超强时分别规范为对应英文值。",
    "- 绑定到 Codex 且用户没有指定思考深度时，thinking 默认返回 high。",
    "- 用户说 'deepseek'、'ds'、'ds4'、'ds4.1'、'DeepSeek V4 Flash'、'DS4 Flash'、'DeepSeek V4.1 Flash'、'DS4.1 Flash'、'DeepSeek V4 Pro'、'DS4 Pro' 时，cli 返回 dsh（DeepSeek Harness），不要填 model/provider，dsh 的模型由 profile 配置决定。",
    "- 用户说 'GLM'、'GLM Flash'、'GLM 5.3 Flash'、'glm flash'、'openmodel' 时，cli 应该返回 pi，provider 返回 openmodel，model 返回 glm-5.3-flash；GLM 只能绑定到 pi，不要给 codex/kimi/claude/dsh 填 glm 模型。",
    "- 用户明确说 'pi' 时 cli 返回 pi；用户说 'dsh' 时 cli 返回 dsh。绑定 dsh 时不要填 model、provider、thinking。",
    "- provider 字段只在用户明确指定时才填，否则省略（让运行时按环境变量或默认规则处理）。",
    "- 如果用户只说“工作区”“有哪些目录”，返回 list_workspaces。",
    "- 如果用户问当前这个群绑到哪里，返回 show_binding。",
    "- 如果用户问额度/token/用量/花费/剩余，返回 show_quota。",
    "- 如果用户说“新会话”“重开会话”，返回 new_session。",
    "- 如果用户说“设置 goal/目标/长期目标/当前目标 为 ...”，返回 set_goal，并把目标正文放进 goal。",
    "- 如果用户说“清除 goal/目标/长期目标/当前目标”，返回 clear_goal。",
    "- goal 指 Codex 原生 /goal 功能，只支持当前群绑定到 Codex 时执行；不要把它理解成普通 prompt 上下文。",
    "- 如果信息不足或不适合执行，返回 help。",
    "",
    `当前时间（Asia/Shanghai）：${formatLocalDateTime()}`,
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
    ...(handoff
      ? [
          "前序控制面交接摘要：",
          `这个群的配置线程之前运行在 ${handoff.fromCli} 上，以下是它交接的上下文摘要，仅供参考：`,
          handoff.summary,
          ""
        ]
      : []),
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
    private readonly cli: ChatCli = "codex",
    private readonly model?: string
  ) {}

  async interpret(
    message: IncomingChatMessage,
    context: GroupControlContext,
    options?: GroupControlInterpretOptions
  ): Promise<{
    intents: GroupControlIntent[];
    threadId: string;
    cli: ChatCli;
  }> {
    let handoff: { fromCli: ChatCli; summary: string } | undefined;
    let reusableControlThreadId = options?.controlThreadId;
    if (
      options?.controlThreadId &&
      options.controlThreadCli &&
      options.controlThreadCli !== this.cli
    ) {
      const summary = await this.buildControlHandoff(
        options.controlThreadCli,
        options.controlThreadId,
        message
      );
      handoff = summary
        ? {
            fromCli: options.controlThreadCli,
            summary
          }
        : undefined;
      reusableControlThreadId = undefined;
    }

    const internalMessage: IncomingChatMessage = {
      chatId: message.chatId,
      chatType: message.chatType,
      messageId: `control:${message.messageId}`,
      senderId: "system:group-control-agent",
      senderName: "group-control-agent",
      senderType: "system",
      tenantKey: message.tenantKey,
      text: buildInterpreterPrompt(message, context, handoff),
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
        workspaceId: this.defaultWorkspace,
        model: this.model,
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
        threadId: resolvedThreadId,
        cli: this.cli
      };
    };

    const initialThreadId =
      reusableControlThreadId ?? `pending:group-control:${message.chatId}:${randomUUID()}`;

    try {
      return await runControlTurn(initialThreadId);
    } catch (error) {
      if (!reusableControlThreadId || !isRecoverableControlThreadError(error)) {
        throw error;
      }

      this.logger?.warn(
        {
          chatId: message.chatId,
          messageId: message.messageId,
          controlThreadId: reusableControlThreadId,
          error: error instanceof Error ? error.message : String(error)
        },
        "群配置控制 thread 恢复失败，改为新建控制 thread"
      );

      return runControlTurn(`pending:group-control:${message.chatId}:${randomUUID()}`);
    };
  }

  private async buildControlHandoff(
    previousCli: ChatCli,
    previousThreadId: string,
    message: IncomingChatMessage
  ): Promise<string | undefined> {
    const transcript = await readThreadTranscript({
      cli: previousCli,
      threadId: previousThreadId,
      workspaceId: this.defaultWorkspace
    });
    if (transcript) {
      const excerpt = renderTranscriptExcerpt(transcript, {
        maxMessages: 8,
        perMessageMaxLength: 300,
        totalMaxLength: 2500
      });
      if (excerpt) {
        this.logger?.info(
          {
            chatId: message.chatId,
            messageId: message.messageId,
            previousCli,
            previousThreadId,
            transcriptMessages: transcript.length
          },
          "已从旧控制线程的会话文件中恢复交接上下文"
        );
        return ["以下是从旧控制线程的会话文件中恢复的最近记录：", excerpt].join("\n");
      }
    }

    return this.summarizePreviousControlThread(previousCli, previousThreadId, message);
  }

  private async summarizePreviousControlThread(
    previousCli: ChatCli,
    previousThreadId: string,
    message: IncomingChatMessage
  ): Promise<string | undefined> {
    const handoffMessage: IncomingChatMessage = {
      chatId: message.chatId,
      chatType: message.chatType,
      messageId: `control-handoff:${message.messageId}`,
      senderId: "system:group-control-agent",
      senderName: "group-control-agent",
      senderType: "system",
      tenantKey: message.tenantKey,
      text: [
        "这是一次控制面交接，这个群的配置线程即将迁移到另一个 CLI。",
        "请用中文简要总结这个配置线程到目前为止与用户达成的关键配置状态、最近的配置变更和未决事项（200 字以内）。",
        "不要调用任何工具，不要修改任何文件，只返回纯文本摘要。"
      ].join("\n"),
      mentionsBot: false,
      raw: {
        sourceMessageId: message.messageId
      }
    };

    let summary: string | undefined;
    try {
      for await (const event of this.codexWorker.runTurn({
        cli: previousCli,
        workspaceId: this.defaultWorkspace,
        message: handoffMessage,
        threadId: previousThreadId
      })) {
        if (event.kind === "assistant_message_completed" && event.text.trim()) {
          summary = event.text;
        }

        if (event.kind === "error") {
          throw new Error(event.message);
        }
      }
    } catch (error) {
      this.logger?.warn(
        {
          chatId: message.chatId,
          messageId: message.messageId,
          previousCli,
          previousThreadId,
          error: error instanceof Error ? error.message : String(error)
        },
        "旧控制线程交接摘要失败，将直接开启新的控制线程"
      );
      return undefined;
    }

    return summary?.trim() || undefined;
  }
}
