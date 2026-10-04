import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { devinProcessEnv } from "../integrations/codex/devin-acp-worker.js";

export interface DevinUsageSummary {
  date: string;
  totalTokens: number;
  totalCost: number | null;
  topModels: Array<{ modelName: string; totalTokens: number; cost: number | null }>;
}
export interface DevinUsageReader { readDaily(): Promise<DevinUsageSummary[] | null>; }
type Price = { input: number; output: number; read: number; write: number | null };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const numeric = (v: unknown): number => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;

export function parseDevinPrices(raw: string): Map<string, Price> {
  const data: unknown = JSON.parse(raw);
  const prices = new Map<string, Price>();
  if (!record(data) || !Array.isArray(data.families)) return prices;
  for (const family of data.families) {
    if (!record(family) || !Array.isArray(family.variants)) continue;
    for (const variant of family.variants) {
      if (!record(variant) || typeof variant.model_uid !== "string") continue;
      if (variant.cost_tier === "Free") {
        prices.set(variant.model_uid, { input: 0, output: 0, read: 0, write: 0 });
        continue;
      }
      if (typeof variant.cost_summary !== "string") continue;
      const rate = (label: string) => {
        const match = variant.cost_summary!.toString().match(new RegExp(`\\$([\\d.]+)\\s*\\/\\s*1M\\s+${label}(?:\\s*[·|]|$)`, "i"));
        return match && Number.isFinite(Number(match[1])) ? Number(match[1]) : null;
      };
      const input = rate("Input"), output = rate("Output"), read = rate("Cached input");
      if (input === null || output === null || read === null) continue;
      // Anthropic 5-minute cache writes cost 1.25x base input. Devin does not expose TTL.
      // https://www.anthropic.com/claude-opus-5-5 (verified 2026-09-29)
      const write = rate("Cache writes?") ?? (variant.model_uid.startsWith("claude-") ? input * 1.25 : null);
      prices.set(variant.model_uid, { input, output, read, write });
    }
  }
  return prices;
}

export interface DevinUsageRow { session_id: string; node_id: number; created_at: number; metadata: string; }
export function aggregateDevinUsage(rows: DevinUsageRow[], prices: Map<string, Price>): DevinUsageSummary[] {
  const seen = new Set<string>();
  const days = new Map<string, Map<string, { tokens: number; cost: number | null }>>();
  for (const row of rows) {
    let metadata: unknown;
    try { metadata = JSON.parse(row.metadata); } catch { continue; }
    if (!record(metadata) || !record(metadata.metrics)) continue;
    const m = metadata.metrics;
    const model = typeof metadata.generation_model === "string" ? metadata.generation_model : "unknown";
    const timestamp = typeof metadata.created_at === "string" ? new Date(metadata.created_at) : new Date(row.created_at * 1000);
    if (!Number.isFinite(timestamp.getTime())) continue;
    // Copies created by tool-result updates and session forks retain the original request metadata.
    const id = typeof metadata.request_id === "string" && metadata.request_id
      ? JSON.stringify([metadata.request_id, model, metadata.started_generation_at ?? metadata.created_at ?? null])
      : JSON.stringify([row.session_id, model, metadata.started_generation_at ?? metadata.created_at ?? row.node_id]);
    if (seen.has(id)) continue;
    seen.add(id);
    const input = numeric(m.input_tokens), output = numeric(m.output_tokens);
    const read = numeric(m.cache_read_tokens), write = numeric(m.cache_creation_tokens);
    const tokens = input + output + read + write;
    if (!tokens) continue;
    const price = prices.get(model);
    const cost = price && (write === 0 || price.write !== null)
      ? (input * price.input + output * price.output + read * price.read + write * (price.write ?? 0)) / 1_000_000 : null;
    const date = `${timestamp.getFullYear()}-${String(timestamp.getMonth()+1).padStart(2,"0")}-${String(timestamp.getDate()).padStart(2,"0")}`;
    let models = days.get(date);
    if (!models) { models = new Map(); days.set(date, models); }
    const previous = models.get(model) ?? { tokens: 0, cost: 0 };
    models.set(model, { tokens: previous.tokens + tokens, cost: previous.cost === null || cost === null ? null : previous.cost + cost });
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, models]) => {
    const topModels = [...models].map(([modelName, value]) => ({ modelName, totalTokens: value.tokens, cost: value.cost }))
      .sort((a,b) => b.totalTokens-a.totalTokens);
    return { date, totalTokens: topModels.reduce((n,m) => n+m.totalTokens,0),
      totalCost: topModels.some(m => m.cost === null) ? null : topModels.reduce((n,m) => n+m.cost!,0), topModels };
  });
}

/** Only usage metadata is selected; never load prompts, credentials or tool output. */
export class LocalDevinUsageReader implements DevinUsageReader {
  private cache?: { at: number; rows: DevinUsageSummary[] | null };
  private inflight?: Promise<DevinUsageSummary[] | null>;
  private prices?: { at: number; values: Map<string, Price> };
  constructor(private readonly options: { database: string; command: string; proxy?: string; cacheMs: number },
    private readonly logger?: { warn(data: unknown, message: string): void }) {}

  readDaily(): Promise<DevinUsageSummary[] | null> {
    if (this.cache && Date.now() - this.cache.at < this.options.cacheMs) return Promise.resolve(this.cache.rows);
    if (this.inflight) return this.inflight;
    this.inflight = this.load().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }
  private async load(): Promise<DevinUsageSummary[] | null> {
    let rows: DevinUsageSummary[] | null = null;
    try {
      if (!this.prices || Date.now() - this.prices.at > 3_600_000) {
        try {
          const { stdout } = await promisify(execFile)(this.options.command, ["models", "list", "--format", "json"],
            { timeout: 20_000, maxBuffer: 4*1024*1024, env: devinProcessEnv(this.options.proxy) });
          this.prices = { at: Date.now(), values: parseDevinPrices(stdout) };
        } catch {
          this.logger?.warn({}, "Devin 模型价格读取失败；保留已有价格，无价格的模型显示未知");
        }
      }
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(this.options.database, { readOnly: true });
      try {
        db.exec("PRAGMA busy_timeout=1000");
        const records = db.prepare(`SELECT session_id, node_id, created_at,
          json_extract(chat_message, '$.metadata') AS metadata FROM message_nodes
          WHERE json_valid(chat_message) AND json_extract(chat_message, '$.role') = 'assistant'
          AND json_type(chat_message, '$.metadata.metrics') = 'object' ORDER BY row_id DESC`).all();
        rows = aggregateDevinUsage(records as unknown as DevinUsageRow[], this.prices?.values ?? new Map());
      } finally { db.close(); }
    } catch (error) {
      this.logger?.warn({ error: error instanceof Error ? error.message : String(error) }, "Devin 本地用量读取失败");
    }
    this.cache = { at: Date.now(), rows };
    return rows;
  }
}
