import { getProviderCatalog } from "./provider-catalog.js";
import { readFileSync } from "node:fs";
import { z } from "zod";

const schema = z.object({
  defaultModel: z.string().trim().min(1),
  defaultThinking: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]),
  models: z.array(z.object({
    id: z.string().trim().min(1),
    aliases: z.array(z.string().trim().min(1)).default([])
  })).min(1)
});
export type CodexModelCatalog = z.infer<typeof schema>;
const normalize = (value: string) => value.trim().toLowerCase().replace(/[\s_]+/g, "-");

export class CodexModelCatalogFile {
  private current?: CodexModelCatalog;
  private source?: string;
  private warned = false;

  constructor(private readonly path: string) {}

  read(): CodexModelCatalog {
    try {
      const source = readFileSync(this.path, "utf8");
      if (source === this.source && this.current) return this.current;
      const catalog = schema.parse(JSON.parse(source));
      if (!catalog.models.some((model) => model.id === catalog.defaultModel)) {
        throw new Error("defaultModel must be a configured model ID");
      }
      const names = new Map<string, string>();
      const ids = new Set<string>();
      for (const model of catalog.models) {
        if (ids.has(model.id)) throw new Error(`Duplicate model ID: ${model.id}`);
        ids.add(model.id);
        for (const alias of [model.id, ...model.aliases]) {
          const key = normalize(alias);
          if (names.has(key) && names.get(key) !== model.id) {
            throw new Error(`Ambiguous model alias: ${alias}`);
          }
          names.set(key, model.id);
        }
      }
      this.current = catalog;
      this.source = source;
      this.warned = false;
      return catalog;
    } catch (error) {
      if (!this.current) throw new Error(`Cannot load Codex model catalog ${this.path}`, { cause: error });
      if (!this.warned) console.warn(`Invalid Codex model catalog ${this.path}; keeping last valid configuration`);
      this.warned = true;
      return this.current;
    }
  }
}

const catalogs = new Map<string, CodexModelCatalogFile>();
export function getCodexModelCatalog(): CodexModelCatalog {
  if (!process.env.CODEX_BINDING_MODELS_FILE) {
    return schema.parse(getProviderCatalog().backends.codex);
  }
  const path = process.env.CODEX_BINDING_MODELS_FILE;
  let file = catalogs.get(path);
  if (!file) {
    file = new CodexModelCatalogFile(path);
    catalogs.set(path, file);
  }
  return file.read();
}

export function normalizeCodexBindingModel(value?: string): string | undefined {
  const catalog = getCodexModelCatalog();
  if (!value?.trim()) return catalog.defaultModel;
  return catalog.models.find((model) => [model.id, ...model.aliases].some((alias) => normalize(alias) === normalize(value)))?.id;
}

export function findCodexBindingModel(text: string): string | undefined {
  const normalized = `-${normalize(text)}-`;
  return getCodexModelCatalog().models.flatMap((model) =>
    [model.id, ...model.aliases].filter((alias) => !/^\d+$/.test(alias)).map((alias) => ({ id: model.id, alias: normalize(alias) }))
  ).sort((a, b) => b.alias.length - a.alias.length)
    .find(({ alias }) => normalized.includes(`-${alias}-`))?.id;
}
