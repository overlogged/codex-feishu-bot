import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { IncomingChatMessage, ChatSession } from "../domain/types.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

type ChatWorkspaceBindingRecord = Record<
  string,
  | string
  | {
      workspace?: string;
    }
>;

export type ChatWorkspaceResolution =
  | {
      ok: true;
      workspaceId: string;
    }
  | {
      ok: false;
      reason:
        | "group_workspace_unconfigured"
        | "group_workspace_invalid"
        | "group_workspace_missing";
      configFilePath: string;
      chatId: string;
      configuredWorkspace?: string;
      resolvedWorkspace?: string;
      detail: string;
    };

export interface ChatWorkspaceResolver {
  resolve(input: {
    message: IncomingChatMessage;
    session?: ChatSession;
  }): Promise<ChatWorkspaceResolution>;
}

function parseBindingWorkspace(
  value: string | { workspace?: string } | undefined
): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  if (value && typeof value.workspace === "string") {
    const trimmed = value.workspace.trim();
    return trimmed || undefined;
  }

  return undefined;
}

function renderExample(chatId: string): string {
  return JSON.stringify(
    {
      [chatId]: {
        workspace: "overlogged/projects/example"
      }
    },
    null,
    2
  );
}

function isWithinWorkspaceRoot(workspaceRoot: string, resolvedWorkspace: string): boolean {
  const relativePath = relative(workspaceRoot, resolvedWorkspace);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export class FileBackedChatWorkspaceResolver implements ChatWorkspaceResolver {
  constructor(
    private readonly defaultWorkspace: string,
    private readonly configFilePath: string,
    private readonly logger?: LoggerLike
  ) {}

  async resolve(input: {
    message: IncomingChatMessage;
    session?: ChatSession;
  }): Promise<ChatWorkspaceResolution> {
    const { message, session } = input;
    if (message.chatType !== "group") {
      return {
        ok: true,
        workspaceId: session?.workspaceId ?? this.defaultWorkspace
      };
    }

    let raw: string;
    try {
      raw = await readFile(this.configFilePath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {
          ok: false,
          reason: "group_workspace_unconfigured",
          configFilePath: this.configFilePath,
          chatId: message.chatId,
          detail: [
            "这个群还没有配置工作区，任务不会启动。",
            `请先在 ${this.configFilePath} 里为 chatId ${message.chatId} 绑定一个已存在目录。`,
            "示例：",
            renderExample(message.chatId)
          ].join("\n")
        };
      }
      throw error;
    }

    let bindings: ChatWorkspaceBindingRecord;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("配置文件顶层必须是 JSON 对象");
      }
      bindings = parsed as ChatWorkspaceBindingRecord;
    } catch (error) {
      this.logger?.warn(
        {
          chatId: message.chatId,
          configFilePath: this.configFilePath,
          error: error instanceof Error ? error.message : String(error)
        },
        "群工作区配置文件无法解析"
      );
      return {
        ok: false,
        reason: "group_workspace_invalid",
        configFilePath: this.configFilePath,
        chatId: message.chatId,
        detail: [
          `工作区配置文件 ${this.configFilePath} 无法解析，任务不会启动。`,
          `请修正这个文件后，再在群 ${message.chatId} 里重试。`
        ].join("\n")
      };
    }

    const configuredWorkspace = parseBindingWorkspace(bindings[message.chatId]);
    if (!configuredWorkspace) {
      return {
        ok: false,
        reason: "group_workspace_unconfigured",
        configFilePath: this.configFilePath,
        chatId: message.chatId,
        detail: [
          "这个群还没有配置工作区，任务不会启动。",
          `请先在 ${this.configFilePath} 里为 chatId ${message.chatId} 绑定一个已存在目录。`,
          "示例：",
          renderExample(message.chatId)
        ].join("\n")
      };
    }

    const resolvedWorkspace = isAbsolute(configuredWorkspace)
      ? configuredWorkspace
      : resolve(this.defaultWorkspace, configuredWorkspace);

    if (!isWithinWorkspaceRoot(this.defaultWorkspace, resolvedWorkspace)) {
      return {
        ok: false,
        reason: "group_workspace_invalid",
        configFilePath: this.configFilePath,
        chatId: message.chatId,
        configuredWorkspace,
        resolvedWorkspace,
        detail: [
          `这个群配置的工作区是 ${resolvedWorkspace}，但它不在映射根 ${this.defaultWorkspace} 下面，任务不会启动。`,
          `请把 ${this.configFilePath} 里的 workspace 改成 ${this.defaultWorkspace} 下的子目录后再重试。`
        ].join("\n")
      };
    }

    try {
      const workspaceStat = await stat(resolvedWorkspace);
      if (!workspaceStat.isDirectory()) {
        return {
          ok: false,
          reason: "group_workspace_missing",
          configFilePath: this.configFilePath,
          chatId: message.chatId,
          configuredWorkspace,
          resolvedWorkspace,
          detail: [
            `这个群配置的工作区是 ${resolvedWorkspace}，但它不是目录，任务不会启动。`,
            `请修正 ${this.configFilePath}，或者先创建正确的目录后再重试。`
          ].join("\n")
        };
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {
          ok: false,
          reason: "group_workspace_missing",
          configFilePath: this.configFilePath,
          chatId: message.chatId,
          configuredWorkspace,
          resolvedWorkspace,
          detail: [
            `这个群配置的工作区是 ${resolvedWorkspace}，但目录不存在，任务不会启动。`,
            `请先创建目录，或者修正 ${this.configFilePath} 后再重试。`
          ].join("\n")
        };
      }
      throw error;
    }

    return {
      ok: true,
      workspaceId: resolvedWorkspace
    };
  }
}
