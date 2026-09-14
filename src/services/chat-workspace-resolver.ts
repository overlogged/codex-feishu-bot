import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  CHAT_CLI_VALUES,
  type ChatCli,
  type IncomingChatMessage,
  type ChatSession
} from "../domain/types.js";

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
      cli?: string;
      provider?: string;
      model?: string;
      thinking?: string;
    }
>;

export interface ChatWorkspaceCatalogEntry {
  code: string;
  workspace: string;
  workspaceId: string;
}

interface ParsedChatBinding {
  workspace?: string;
  cli?: ChatCli;
  rawCli?: string;
  provider?: string;
  model?: string;
  thinking?: string;
}

export type ChatWorkspaceResolution =
  | {
      ok: true;
      workspaceId: string;
      cli: ChatCli;
      provider?: string;
      model?: string;
      thinking?: string;
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
  listCatalog(): Promise<ChatWorkspaceCatalogEntry[]>;
  lookupCatalogEntry(code: string): Promise<ChatWorkspaceCatalogEntry | undefined>;
  bindGroupWorkspace(input: {
    chatId: string;
    cli: ChatCli;
    code: string;
    provider?: string;
    model?: string;
    thinking?: string;
  }): Promise<
    | {
        ok: true;
        entry: ChatWorkspaceCatalogEntry;
        cli: ChatCli;
        provider?: string;
        model?: string;
        thinking?: string;
        configFilePath: string;
      }
    | {
        ok: false;
        reason:
          | "invalid_code"
          | "catalog_empty"
          | "config_invalid"
          | "unsupported_codex_model"
          | "unsupported_codex_thinking";
        detail: string;
        configFilePath: string;
      }
  >;
}

const SKIPPED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "artifacts",
  "tmp",
  "temp",
  "vendor",
  "target",
  "__pycache__"
]);

const SUPPORTED_CHAT_CLIS = new Set<ChatCli>(CHAT_CLI_VALUES);

export const DEFAULT_CODEX_BINDING_MODEL = "gpt-6-astra";
export const DEFAULT_CODEX_BINDING_THINKING = "high";
export const CODEX_BINDING_MODELS = ["gpt-6-astra", "gpt-5.6-sol"] as const;
export const CODEX_BINDING_THINKING_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
] as const;

function normalizeCodexBindingModel(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return DEFAULT_CODEX_BINDING_MODEL;
  }

  const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (["6", "gpt6", "gpt-6", "gpt6-astra", "gpt-6-astra"].includes(normalized)) {
    return "gpt-6-astra";
  }

  if (
    [
      "5.6",
      "5.6-sol",
      "5.6-soul",
      "gpt5.6",
      "gpt-5.6",
      "gpt5.6-sol",
      "gpt-5.6-sol",
      "gpt5.6-soul",
      "gpt-5.6-soul"
    ].includes(normalized)
  ) {
    return "gpt-5.6-sol";
  }

  return undefined;
}

function normalizeCodexBindingThinking(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return DEFAULT_CODEX_BINDING_THINKING;
  }

  const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  const aliases: Record<string, string> = {
    low: "low",
    "低": "low",
    medium: "medium",
    med: "medium",
    "中": "medium",
    high: "high",
    "高": "high",
    "嗨": "high",
    xhigh: "xhigh",
    "x-high": "xhigh",
    "extra-high": "xhigh",
    "极高": "xhigh",
    max: "max",
    maximum: "max",
    ultra: "ultra",
    "超强": "ultra",
    "最高": "max",
    "最大": "max"
  };
  return aliases[normalized];
}

function resolveCodexBindingSettings(input: { model?: string; thinking?: string }):
  | {
      ok: true;
      model: string;
      thinking: string;
    }
  | {
      ok: false;
      field: "model" | "thinking";
      value: string;
    } {
  const model = normalizeCodexBindingModel(input.model);
  if (!model) {
    return {
      ok: false,
      field: "model",
      value: input.model?.trim() ?? ""
    };
  }

  const thinking = normalizeCodexBindingThinking(input.thinking);
  if (!thinking) {
    return {
      ok: false,
      field: "thinking",
      value: input.thinking?.trim() ?? ""
    };
  }

  return {
    ok: true,
    model,
    thinking
  };
}

function parseBindingWorkspace(
  value:
    | string
    | {
        workspace?: string;
        cli?: string;
        provider?: string;
        model?: string;
        thinking?: string;
      }
    | undefined
): ParsedChatBinding {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return {
      workspace: trimmed || undefined,
      cli: "kimi"
    };
  }

  if (!value || typeof value !== "object") {
    return {};
  }

  const workspace =
    typeof value.workspace === "string" && value.workspace.trim()
      ? value.workspace.trim()
      : undefined;
  const cli =
    typeof value.cli === "string" && SUPPORTED_CHAT_CLIS.has(value.cli as ChatCli)
      ? (value.cli as ChatCli)
      : value.cli === undefined
        ? "kimi"
        : undefined;
  const provider =
    typeof value.provider === "string" && value.provider.trim() ? value.provider.trim() : undefined;
  const model =
    typeof value.model === "string" && value.model.trim() ? value.model.trim() : undefined;
  const thinking =
    typeof value.thinking === "string" && value.thinking.trim() ? value.thinking.trim() : undefined;

  return {
    workspace,
    cli,
    rawCli: typeof value.cli === "string" ? value.cli.trim() || undefined : undefined,
    provider,
    model,
    thinking
  };
}

function isWithinWorkspaceRoot(workspaceRoot: string, resolvedWorkspace: string): boolean {
  const relativePath = relative(workspaceRoot, resolvedWorkspace);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function sortBindings(bindings: ChatWorkspaceBindingRecord): ChatWorkspaceBindingRecord {
  return Object.fromEntries(Object.entries(bindings).sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeBindings(bindings: ChatWorkspaceBindingRecord): {
  bindings: ChatWorkspaceBindingRecord;
  changed: boolean;
} {
  let changed = false;
  const nextEntries = Object.entries(bindings).map(([chatId, value]) => {
    if (typeof value === "string") {
      changed = true;
      return [
        chatId,
        {
          workspace: value,
          cli: "kimi"
        }
      ] as const;
    }

    if (!value || typeof value !== "object") {
      return [chatId, value] as const;
    }

    if (typeof value.workspace === "string" && value.workspace.trim() && value.cli === undefined) {
      changed = true;
      return [
        chatId,
        {
          workspace: value.workspace.trim(),
          cli: value.cli ?? "kimi"
        }
      ] as const;
    }

    return [chatId, value] as const;
  });

  return {
    bindings: Object.fromEntries(nextEntries),
    changed
  };
}

function shouldIncludeDirectory(name: string): boolean {
  return !name.startsWith(".") && !SKIPPED_DIRECTORY_NAMES.has(name);
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
        workspaceId: session?.workspaceId ?? this.defaultWorkspace,
        cli: "codex",
        provider: undefined,
        model: undefined,
        thinking: undefined
      };
    }

    const bindingsResult = await this.readBindings();
    if (!bindingsResult.ok) {
      if (bindingsResult.reason === "missing") {
        return {
          ok: false,
          reason: "group_workspace_unconfigured",
          configFilePath: this.configFilePath,
          chatId: message.chatId,
          detail: [
            "这个群还没有绑定工作区，任务不会启动。",
            "直接在群里 @机器人 说“看看有哪些工作区”或“把这个群绑定到 codex 的 Quant”。"
          ].join("\n")
        };
      }

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

    const bindings = bindingsResult.bindings;

    const configuredBinding = parseBindingWorkspace(bindings[message.chatId]);
    if (!configuredBinding.workspace) {
      return {
        ok: false,
        reason: "group_workspace_unconfigured",
        configFilePath: this.configFilePath,
        chatId: message.chatId,
        detail: [
          "这个群还没有绑定工作区，任务不会启动。",
          "直接在群里 @机器人 说“看看有哪些工作区”或“把这个群绑定到 codex 的 Quant”。"
        ].join("\n")
      };
    }

    if (!configuredBinding.cli) {
      return {
        ok: false,
        reason: "group_workspace_invalid",
        configFilePath: this.configFilePath,
        chatId: message.chatId,
        configuredWorkspace: configuredBinding.workspace,
        detail: [
          `这个群配置的 CLI 是 ${configuredBinding.rawCli ?? "空值"}，但当前只支持 ${CHAT_CLI_VALUES.join(" / ")}。`,
          `请修正 ${this.configFilePath} 里的 cli 字段后再重试。`
        ].join("\n")
      };
    }

    const resolvedWorkspace = isAbsolute(configuredBinding.workspace)
      ? configuredBinding.workspace
      : resolve(this.defaultWorkspace, configuredBinding.workspace);

    if (!isWithinWorkspaceRoot(this.defaultWorkspace, resolvedWorkspace)) {
      return {
        ok: false,
        reason: "group_workspace_invalid",
        configFilePath: this.configFilePath,
        chatId: message.chatId,
        configuredWorkspace: configuredBinding.workspace,
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
          configuredWorkspace: configuredBinding.workspace,
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
          configuredWorkspace: configuredBinding.workspace,
          resolvedWorkspace,
          detail: [
            `这个群配置的工作区是 ${resolvedWorkspace}，但目录不存在，任务不会启动。`,
            `请先创建目录，或者修正 ${this.configFilePath} 后再重试。`
          ].join("\n")
        };
      }
      throw error;
    }

    const codexSettings =
      configuredBinding.cli === "codex"
        ? resolveCodexBindingSettings({
            model: configuredBinding.model,
            thinking: configuredBinding.thinking
          })
        : undefined;
    if (codexSettings && !codexSettings.ok) {
      const supported =
        codexSettings.field === "model"
          ? CODEX_BINDING_MODELS.join(" / ")
          : CODEX_BINDING_THINKING_LEVELS.join(" / ");
      return {
        ok: false,
        reason: "group_workspace_invalid",
        configFilePath: this.configFilePath,
        chatId: message.chatId,
        configuredWorkspace: configuredBinding.workspace,
        resolvedWorkspace,
        detail: `这个群配置的 Codex ${codexSettings.field} 是 ${codexSettings.value || "空值"}，支持值为 ${supported}。`
      };
    }

    return {
      ok: true,
      workspaceId: resolvedWorkspace,
      cli: configuredBinding.cli,
      provider: configuredBinding.provider,
      model: codexSettings?.model ?? configuredBinding.model,
      thinking: codexSettings?.thinking ?? configuredBinding.thinking
    };
  }

  async listCatalog(): Promise<ChatWorkspaceCatalogEntry[]> {
    const workspaces = await this.scanCatalog();
    return workspaces.map((workspace, index) => ({
      code: String(index + 1),
      workspace,
      workspaceId: resolve(this.defaultWorkspace, workspace)
    }));
  }

  async lookupCatalogEntry(code: string): Promise<ChatWorkspaceCatalogEntry | undefined> {
    const trimmedCode = code.trim();
    if (!/^\d+$/.test(trimmedCode)) {
      return undefined;
    }

    const entries = await this.listCatalog();
    return entries.find((entry) => entry.code === trimmedCode);
  }

  async bindGroupWorkspace(
    input: {
      chatId: string;
      cli: ChatCli;
      code: string;
      provider?: string;
      model?: string;
      thinking?: string;
    }
  ): Promise<
    | {
        ok: true;
        entry: ChatWorkspaceCatalogEntry;
        cli: ChatCli;
        provider?: string;
        model?: string;
        thinking?: string;
        configFilePath: string;
      }
    | {
        ok: false;
        reason:
          | "invalid_code"
          | "catalog_empty"
          | "config_invalid"
          | "unsupported_codex_model"
          | "unsupported_codex_thinking";
        detail: string;
        configFilePath: string;
      }
  > {
    const codexSettings =
      input.cli === "codex"
        ? resolveCodexBindingSettings({
            model: input.model,
            thinking: input.thinking
          })
        : undefined;
    if (codexSettings && !codexSettings.ok) {
      const isModel = codexSettings.field === "model";
      const supported = isModel
        ? CODEX_BINDING_MODELS.join(" / ")
        : CODEX_BINDING_THINKING_LEVELS.join(" / ");
      return {
        ok: false,
        reason: isModel ? "unsupported_codex_model" : "unsupported_codex_thinking",
        detail: `Codex ${codexSettings.field} ${codexSettings.value || "空值"} 不受支持。可选值：${supported}。`,
        configFilePath: this.configFilePath
      };
    }

    const resolvedModel = codexSettings?.model ?? input.model;
    const resolvedThinking = codexSettings?.thinking ?? input.thinking;

    const entries = await this.listCatalog();
    if (entries.length === 0) {
      return {
        ok: false,
        reason: "catalog_empty",
        detail: [
          `当前在 ${this.defaultWorkspace} 下没有找到可绑定的子目录。`,
          "请先创建目录后，再私聊机器人发送“工作区”获取编号。"
        ].join("\n"),
        configFilePath: this.configFilePath
      };
    }

    const entry = entries.find((item) => item.code === input.code.trim());
    if (!entry) {
      return {
        ok: false,
        reason: "invalid_code",
        detail: [
          `编号 ${input.code.trim()} 不存在。`,
          "请先私聊机器人发送“工作区”查看最新编号，再回到群里 @机器人 发送编号。"
        ].join("\n"),
        configFilePath: this.configFilePath
      };
    }

    const bindingsResult = await this.readBindings({ allowMissing: true });
    if (!bindingsResult.ok) {
      return {
        ok: false,
        reason: "config_invalid",
        detail: [
          `工作区配置文件 ${this.configFilePath} 无法解析，暂时不能写入绑定。`,
          "请先修正这个文件后再重试。"
        ].join("\n"),
        configFilePath: this.configFilePath
      };
    }

    const bindings: ChatWorkspaceBindingRecord = {
      ...bindingsResult.bindings,
      [input.chatId]: {
        workspace: entry.workspace,
        cli: input.cli,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(resolvedThinking ? { thinking: resolvedThinking } : {})
      }
    };

    await mkdir(dirname(this.configFilePath), {
      recursive: true
    });
    await writeFile(
      this.configFilePath,
      `${JSON.stringify(sortBindings(bindings), null, 2)}\n`,
      "utf8"
    );

    return {
      ok: true,
      entry,
      cli: input.cli,
      provider: input.provider,
      model: resolvedModel,
      thinking: resolvedThinking,
      configFilePath: this.configFilePath
    };
  }

  private async readBindings(options?: { allowMissing?: boolean }): Promise<
    | {
        ok: true;
        bindings: ChatWorkspaceBindingRecord;
      }
    | {
        ok: false;
        reason: "missing" | "invalid";
      }
  > {
    let raw: string;
    try {
      raw = await readFile(this.configFilePath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        if (options?.allowMissing) {
          return {
            ok: true,
            bindings: {}
          };
        }

        return {
          ok: false,
          reason: "missing"
        };
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("配置文件顶层必须是 JSON 对象");
      }
      const normalized = normalizeBindings(parsed as ChatWorkspaceBindingRecord);
      if (normalized.changed) {
        await mkdir(dirname(this.configFilePath), {
          recursive: true
        });
        await writeFile(
          this.configFilePath,
          `${JSON.stringify(sortBindings(normalized.bindings), null, 2)}\n`,
          "utf8"
        );
      }
      return {
        ok: true,
        bindings: normalized.bindings
      };
    } catch (error) {
      this.logger?.warn(
        {
          configFilePath: this.configFilePath,
          error: error instanceof Error ? error.message : String(error)
        },
        "群工作区配置文件无法解析"
      );
      return {
        ok: false,
        reason: "invalid"
      };
    }
  }

  private async scanCatalog(): Promise<string[]> {
    const directoryEntries = await readdir(this.defaultWorkspace, {
      withFileTypes: true
    });
    const workspaces = await Promise.all(
      directoryEntries.map(async (entry) => {
        if (!shouldIncludeDirectory(entry.name)) {
          return undefined;
        }

        if (entry.isDirectory()) {
          return entry.name;
        }

        if (!entry.isSymbolicLink()) {
          return undefined;
        }

        const workspacePath = resolve(this.defaultWorkspace, entry.name);
        try {
          const workspaceStat = await stat(workspacePath);
          return workspaceStat.isDirectory() ? entry.name : undefined;
        } catch (error) {
          this.logger?.warn(
            {
              workspacePath,
              error: error instanceof Error ? error.message : String(error)
            },
            "符号链接工作区无法访问，已从目录列表中跳过"
          );
          return undefined;
        }
      })
    );

    return workspaces
      .filter((workspace): workspace is string => workspace !== undefined)
      .sort((left, right) => left.localeCompare(right));
  }
}
