import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CHAT_CLI_VALUES, type ChatCli } from "../domain/types.js";

const name = z.string().trim().min(1);
const entry = z.object({ id: name, aliases: z.array(name).default([]) }).strict();
const backend = z.object({
  aliases: z.array(name).default([]),
  nativeSettings: z.boolean().default(false),
  defaultModel: name.optional(),
  defaultProvider: name.optional(),
  defaultThinking: name.optional(),
  providers: z.array(entry).default([]),
  models: z.array(entry.extend({
    provider: name.optional(),
    fallbackProvider: name.optional(),
    providerModels: z.record(name).default({})
  })).default([])
}).strict();
const schema = z.object({ backends: z.object({ codex: backend, claude: backend, kimi: backend, pi: backend, dsh: backend, mcode: backend, devin: backend }).strict() }).strict();
export type ProviderCatalog = z.infer<typeof schema>;
export const normalizeName = (value: string) => value.trim().toLowerCase().replace(/[\s_]+/g, "-");

function validateNames(entries: { id: string; aliases: string[] }[]): void {
  const aliases = new Map<string, string>();
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`Duplicate ID: ${entry.id}`);
    ids.add(entry.id);
    for (const name of [entry.id, ...entry.aliases]) {
      const key = normalizeName(name);
      if (aliases.has(key) && aliases.get(key) !== entry.id) throw new Error(`Ambiguous alias: ${name}`);
      aliases.set(key, entry.id);
    }
  }
}

export class ProviderCatalogFile {
  private current?: ProviderCatalog;
  private source?: string;
  private warned = false;
  constructor(private readonly path: string) {}
  read(): ProviderCatalog {
    try {
      const source = readFileSync(this.path, "utf8");
      if (this.current && source === this.source) return this.current;
      const config = schema.parse(JSON.parse(source));
      validateNames(CHAT_CLI_VALUES.map((id) => ({ id, aliases: config.backends[id].aliases })));
      for (const settings of Object.values(config.backends)) {
        if (settings.nativeSettings && (settings.defaultModel || settings.defaultProvider || settings.defaultThinking || settings.models.length)) throw new Error("nativeSettings cannot be combined with binding models/defaults");
        validateNames(settings.models);
        validateNames(settings.providers);
        if (settings.defaultModel && !settings.models.some((m) => m.id === settings.defaultModel)) throw new Error("Unknown defaultModel");
        const providers = new Set(settings.providers.map((p) => p.id));
        for (const id of [settings.defaultProvider, ...settings.models.flatMap((m) => [m.provider, m.fallbackProvider, ...Object.keys(m.providerModels)])]) {
          if (id && !providers.has(id)) throw new Error(`Unknown provider: ${id}`);
        }
      }
      const codex = config.backends.codex;
      if (!codex.defaultModel || !codex.defaultThinking || !["low", "medium", "high", "xhigh", "max", "ultra"].includes(codex.defaultThinking)) throw new Error("Invalid Codex defaults");
      // These CLIs use native account/provider configuration, not a per-turn provider flag.
      for (const cli of ["codex", "claude", "devin"] as const) {
        const settings = config.backends[cli];
        if (cli !== "codex" && settings.defaultThinking) throw new Error(`${cli} does not support a binding thinking default`);
        if (settings.defaultProvider || settings.models.some((m) => m.provider || m.fallbackProvider || Object.keys(m.providerModels).length)) throw new Error(`${cli} does not support per-binding providers`);
      }
      this.current = config;
      this.source = source;
      this.warned = false;
      return config;
    } catch (error) {
      if (!this.current) throw new Error(`Cannot load provider catalog ${this.path}`, { cause: error });
      if (!this.warned) console.warn(`Invalid provider catalog ${this.path}; keeping last valid configuration`);
      this.warned = true;
      return this.current;
    }
  }
}

const files = new Map<string, ProviderCatalogFile>();
export function getProviderCatalog(): ProviderCatalog {
  const path = process.env.CHAT_PROVIDER_CONFIG_FILE || fileURLToPath(new URL("../../config/providers.json", import.meta.url));
  let file = files.get(path);
  if (!file) { file = new ProviderCatalogFile(path); files.set(path, file); }
  return file.read();
}

export function normalizeCliName(value: string): ChatCli | undefined {
  return CHAT_CLI_VALUES.find((cli) => [cli, ...getProviderCatalog().backends[cli].aliases].some((alias) => normalizeName(alias) === normalizeName(value)));
}
export function normalizeProvider(cli: ChatCli, value?: string): string | undefined {
  if (!value) return undefined;
  return getProviderCatalog().backends[cli].providers.find((p) => [p.id, ...p.aliases].some((a) => normalizeName(a) === normalizeName(value)))?.id ?? value;
}
export function findConfiguredModel(cli: ChatCli, value: string, inText = false) {
  const text = normalizeName(value);
  return getProviderCatalog().backends[cli].models.flatMap((model) =>
    [model.id, ...model.aliases].filter((a) => !inText || !/^\d+$/.test(a)).map((alias) => ({ model, alias: normalizeName(alias) }))
  ).sort((a, b) => b.alias.length - a.alias.length)
    .find(({ alias }) => inText ? `-${text}-`.includes(`-${alias}-`) : text === alias)?.model;
}

export function resolveConfiguredSelection(cli: ChatCli, input: { model?: string; provider?: string; thinking?: string }, runtimeModel = false) {
  const settings = getProviderCatalog().backends[cli];
  if (settings.nativeSettings) return { model: undefined, provider: undefined, thinking: undefined };
  const requested = input.model ?? settings.defaultModel;
  const entry = requested ? findConfiguredModel(cli, requested) : undefined;
  const provider = entry?.provider ?? normalizeProvider(cli, input.provider) ?? settings.defaultProvider ?? (runtimeModel ? entry?.fallbackProvider : undefined);
  return {
    model: (runtimeModel && provider ? entry?.providerModels[provider] : undefined) ?? entry?.id ?? requested,
    provider,
    thinking: input.thinking ?? settings.defaultThinking
  };
}

export function renderProviderCatalogPrompt(): string {
  return `以下 CLI/provider/模型配置以本轮为准，覆盖历史规则。aliases 为别名；未配置默认值则省略相应字段，沿用 CLI 本机配置。nativeSettings=true 时不要返回 model/provider/thinking，使用 CLI 本机配置；其他非 Codex 模型允许传入后端原生 ID。providerModels 供 Pi/DSH 运行时转换，绑定返回模型 id。Claude provider 切换通过 switch_claude_provider（全局 CC Switch）执行，不写群绑定 provider。Kimi/DSH 的显式设置要求 ACP 会话支持对应配置项。\n${JSON.stringify(getProviderCatalog())}`;
}
