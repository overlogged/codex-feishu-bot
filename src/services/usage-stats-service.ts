import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  CodexAccountUsage,
  CodexRateLimits,
  CodexRateLimitSnapshot,
  CodexWorker
} from "../integrations/codex/codex-worker.js";
import type { KimiQuota, KimiQuotaWindow } from "../integrations/kimi/kimi-quota-client.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

export interface KimiQuotaReader {
  readQuota(): Promise<KimiQuota | null>;
}

export interface UsageStatsServiceConfig {
  ccusageCommand: string;
  cacheMs: number;
  usdToCnyRate: number;
}

export type UsageStatsCommandRunner = (command: string, args: string[]) => Promise<string>;

export interface RateLimitWindowInfo {
  key: string;
  label: string;
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

interface CcusageModelBreakdown {
  modelName: string;
  totalTokens: number | null;
  cost: number | null;
}

interface CcusageMonthlySummary {
  month: string;
  totalTokens: number | null;
  totalCost: number | null;
  topModels: CcusageModelBreakdown[];
}

const CCUSAGE_CLIS = ["codex", "claude", "kimi", "pi"] as const;

const execFileAsync = promisify(execFile);

const defaultCommandRunner: UsageStatsCommandRunner = async (command, args) => {
  const { stdout } = await execFileAsync(command, args, {
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatTokenCount(value: number | null): string {
  if (value === null) {
    return "未知";
  }

  if (value >= 100_000_000) {
    return `${(value / 100_000_000).toFixed(2)} 亿`;
  }

  if (value >= 10_000) {
    return `${(value / 10_000).toFixed(1)} 万`;
  }

  return `${value}`;
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}

function formatWindowDuration(minutes: number | null): string | null {
  if (minutes === null || minutes <= 0) {
    return null;
  }

  if (minutes % 1440 === 0) {
    return `${minutes / 1440} 天`;
  }

  if (minutes % 60 === 0) {
    return `${minutes / 60} 小时`;
  }

  return `${minutes} 分钟`;
}

function formatResetTime(resetsAt: number | string | null): string | null {
  if (resetsAt === null) {
    return null;
  }

  const date = typeof resetsAt === "number" ? new Date(resetsAt * 1000) : new Date(resetsAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}月${day}日 ${hour}:${minute}`;
}

function renderCliLabel(cli: string): string {
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

export function collectRateLimitWindows(rateLimits: CodexRateLimits): RateLimitWindowInfo[] {
  const windows = new Map<string, RateLimitWindowInfo>();
  const snapshots: Array<CodexRateLimitSnapshot | null> = [rateLimits.rateLimits];
  if (rateLimits.rateLimitsByLimitId) {
    for (const snapshot of Object.values(rateLimits.rateLimitsByLimitId)) {
      snapshots.push(snapshot);
    }
  }

  for (const snapshot of snapshots) {
    if (!snapshot) {
      continue;
    }

    const snapshotName = snapshot.limitName?.trim() || snapshot.limitId || "额度";
    for (const kind of ["primary", "secondary"] as const) {
      const window = snapshot[kind];
      if (!window || typeof window.usedPercent !== "number") {
        continue;
      }

      const key = `${snapshot.limitId ?? snapshotName}:${kind}`;
      if (windows.has(key)) {
        continue;
      }

      const durationLabel = formatWindowDuration(window.windowDurationMins);
      windows.set(key, {
        key,
        label: durationLabel
          ? `${snapshotName} ${durationLabel}窗口`
          : `${snapshotName} ${kind === "primary" ? "主" : "次"}窗口`,
        usedPercent: window.usedPercent,
        windowDurationMins: window.windowDurationMins,
        resetsAt: window.resetsAt
      });
    }
  }

  return [...windows.values()];
}

function currentMonthKey(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${now.getFullYear()}-${month}`;
}

function parseCcusageModelBreakdowns(entry: Record<string, unknown>): CcusageModelBreakdown[] {
  const breakdowns: CcusageModelBreakdown[] = [];

  if (Array.isArray(entry.modelBreakdowns)) {
    for (const item of entry.modelBreakdowns) {
      const record = asRecord(item);
      if (!record || typeof record.modelName !== "string") {
        continue;
      }

      breakdowns.push({
        modelName: record.modelName,
        totalTokens:
          numberOrNull(record.totalTokens) ??
          ((numberOrNull(record.inputTokens) ?? 0) +
            (numberOrNull(record.outputTokens) ?? 0) +
            (numberOrNull(record.cacheReadTokens) ?? 0) +
            (numberOrNull(record.cacheCreationTokens) ?? 0) ||
            null),
        cost: numberOrNull(record.cost)
      });
    }
  } else {
    const models = asRecord(entry.models);
    if (models) {
      for (const [modelName, item] of Object.entries(models)) {
        const record = asRecord(item);
        if (!record) {
          continue;
        }

        breakdowns.push({
          modelName,
          totalTokens:
            numberOrNull(record.totalTokens) ??
            ((numberOrNull(record.inputTokens) ?? 0) +
              (numberOrNull(record.outputTokens) ?? 0) +
              (numberOrNull(record.cacheReadTokens) ?? 0) +
              (numberOrNull(record.cacheCreationTokens) ?? 0) ||
              null),
          cost: numberOrNull(record.cost)
        });
      }
    }
  }

  return breakdowns
    .sort((left, right) => (right.totalTokens ?? 0) - (left.totalTokens ?? 0))
    .slice(0, 3);
}

function parseCcusageMonthly(stdout: string): CcusageMonthlySummary[] {
  const parsed = asRecord(JSON.parse(stdout));
  if (!parsed || !Array.isArray(parsed.monthly)) {
    return [];
  }

  const summaries: CcusageMonthlySummary[] = [];
  for (const item of parsed.monthly) {
    const entry = asRecord(item);
    if (!entry || typeof entry.month !== "string" || !entry.month) {
      continue;
    }

    summaries.push({
      month: entry.month,
      totalTokens: numberOrNull(entry.totalTokens),
      totalCost: numberOrNull(entry.totalCost) ?? numberOrNull(entry.costUSD),
      topModels: parseCcusageModelBreakdowns(entry)
    });
  }

  return summaries;
}

export class UsageStatsService {
  private readonly ccusageCommand: string;
  private readonly cacheMs: number;
  private readonly usdToCnyRate: number;
  private readonly commandRunner: UsageStatsCommandRunner;
  private readonly kimiQuotaClient?: KimiQuotaReader;
  private ccusageCache:
    | {
        expiresAt: number;
        summaries: Map<string, CcusageMonthlySummary[] | null>;
      }
    | undefined;

  constructor(
    private readonly codexWorker: CodexWorker,
    config: UsageStatsServiceConfig,
    private readonly logger?: LoggerLike,
    commandRunner?: UsageStatsCommandRunner,
    kimiQuotaClient?: KimiQuotaReader
  ) {
    this.ccusageCommand = config.ccusageCommand;
    this.cacheMs = config.cacheMs;
    this.usdToCnyRate = config.usdToCnyRate;
    this.commandRunner = commandRunner ?? defaultCommandRunner;
    this.kimiQuotaClient = kimiQuotaClient;
  }

  async buildReport(): Promise<string> {
    const [rateLimitsLines, kimiQuotaLines, accountUsageLines, ccusageLines] = await Promise.all([
      this.buildRateLimitsSection(),
      this.buildKimiQuotaSection(),
      this.buildAccountUsageSection(),
      this.buildCcusageSection()
    ]);

    return [
      "额度与用量统计",
      "",
      "【Codex 账号额度（实时）】",
      ...rateLimitsLines,
      "",
      "【Kimi 账号额度（实时，含 k3 等全部模型）】",
      ...kimiQuotaLines,
      ...(accountUsageLines ? ["", "【Codex 累计用量】", ...accountUsageLines] : []),
      "",
      "【各 CLI 历史用量（本月，ccusage）】",
      ...ccusageLines,
      "",
      `费用为 ccusage 按公开定价估算（USD 按汇率 ${this.usdToCnyRate} 折算为人民币），仅供参考。`
    ].join("\n");
  }

  private formatCny(usd: number): string {
    return `¥${(usd * this.usdToCnyRate).toFixed(2)}`;
  }

  private renderKimiWindowLine(label: string, window: KimiQuotaWindow): string {
    const resetLabel = formatResetTime(window.resetAt);
    const percent = formatPercent(Math.round(window.usedRatio * 1000) / 10);
    return `${label}：已用 ${percent}%${resetLabel ? `（${resetLabel} 重置）` : ""}`;
  }

  private async buildKimiQuotaSection(): Promise<string[]> {
    if (!this.kimiQuotaClient) {
      return ["Kimi 额度暂不可用（需要本机 kimi 登录态）"];
    }

    const quota = await this.kimiQuotaClient.readQuota();
    if (!quota) {
      return ["Kimi 额度暂不可用（需要本机 kimi 登录态）"];
    }

    const lines: string[] = [];
    if (quota.limit5h) {
      lines.push(this.renderKimiWindowLine("5 小时窗口", quota.limit5h));
    }
    if (quota.limit7d) {
      lines.push(this.renderKimiWindowLine("7 天窗口", quota.limit7d));
    }
    if (quota.boosterWallet) {
      const balance = quota.boosterWallet.balanceCents / 100;
      lines.push(
        quota.boosterWallet.currency === "CNY"
          ? `加油包余额：¥${balance.toFixed(2)}`
          : `加油包余额：${balance.toFixed(2)} ${quota.boosterWallet.currency}`
      );
    }

    return lines.length > 0 ? lines : ["Kimi 额度暂不可用（需要本机 kimi 登录态）"];
  }

  private renderWindowLine(window: RateLimitWindowInfo): string {
    const resetLabel = formatResetTime(window.resetsAt);
    return `${window.label}：已用 ${formatPercent(window.usedPercent)}%${
      resetLabel ? `（${resetLabel} 重置）` : ""
    }`;
  }

  private async buildRateLimitsSection(): Promise<string[]> {
    if (!this.codexWorker.readRateLimits) {
      return ["额度接口暂不可用（当前 worker 不支持）"];
    }

    const rateLimits = await this.codexWorker.readRateLimits();
    if (!rateLimits) {
      return ["额度接口暂不可用"];
    }

    const lines: string[] = [];
    const snapshot = rateLimits.rateLimits;
    if (snapshot?.planType) {
      lines.push(`套餐：${snapshot.planType}`);
    }

    const windows = collectRateLimitWindows(rateLimits);
    if (windows.length === 0) {
      lines.push("暂无额度窗口数据");
    }
    for (const window of windows) {
      lines.push(this.renderWindowLine(window));
    }

    const credits = snapshot?.credits;
    if (credits?.hasCredits) {
      if (credits.unlimited) {
        lines.push("credits：无限");
      } else if (credits.balance) {
        lines.push(`credits 余额：${credits.balance}`);
      }
    }

    if (snapshot?.spendControlReached) {
      lines.push("注意：已触发消费控制上限。");
    }

    return lines;
  }

  private async buildAccountUsageSection(): Promise<string[] | null> {
    if (!this.codexWorker.readAccountUsage) {
      return null;
    }

    const usage: CodexAccountUsage | null = await this.codexWorker.readAccountUsage();
    if (!usage) {
      return null;
    }

    const lines: string[] = [];
    const lifetimeTokens = usage.summary?.lifetimeTokens;
    if (typeof lifetimeTokens === "number") {
      lines.push(`终身累计：${formatTokenCount(lifetimeTokens)} token`);
    }

    const buckets = usage.dailyUsageBuckets ?? [];
    const recentBuckets = buckets.slice(-7);
    const recentTotal = recentBuckets.reduce((sum, bucket) => sum + (bucket.tokens ?? 0), 0);
    if (recentTotal > 0) {
      lines.push(`最近 7 天：${formatTokenCount(recentTotal)} token`);
    }

    const streakDays = usage.summary?.currentStreakDays;
    if (typeof streakDays === "number" && streakDays > 0) {
      const longest = usage.summary?.longestStreakDays;
      lines.push(
        `连续使用：${streakDays} 天${typeof longest === "number" && longest > streakDays ? `（最长 ${longest} 天）` : ""}`
      );
    }

    return lines.length > 0 ? lines : null;
  }

  private async buildCcusageSection(): Promise<string[]> {
    const summaries = await this.loadCcusageSummaries();
    const monthKey = currentMonthKey();
    const lines: string[] = [];

    for (const cli of CCUSAGE_CLIS) {
      const months = summaries.get(cli);
      if (!months || months.length === 0) {
        continue;
      }

      const month = months.find((entry) => entry.month === monthKey) ?? months.at(-1);
      if (!month) {
        continue;
      }

      lines.push(
        `${renderCliLabel(cli)}（${month.month}）：${formatTokenCount(month.totalTokens)} token${
          month.totalCost !== null ? `，估算费用 ${this.formatCny(month.totalCost)}` : ""
        }`
      );
      for (const model of month.topModels) {
        lines.push(
          `  · ${model.modelName}：${formatTokenCount(model.totalTokens)} token${
            model.cost !== null ? `（${this.formatCny(model.cost)}）` : ""
          }`
        );
      }
    }

    return lines.length > 0 ? lines : ["ccusage 不可用或暂无历史用量"];
  }

  private async loadCcusageSummaries(): Promise<Map<string, CcusageMonthlySummary[] | null>> {
    if (this.ccusageCache && this.ccusageCache.expiresAt > Date.now()) {
      return this.ccusageCache.summaries;
    }

    const summaries = new Map<string, CcusageMonthlySummary[] | null>();
    await Promise.all(
      CCUSAGE_CLIS.map(async (cli) => {
        summaries.set(cli, await this.fetchCcusageMonthly(cli));
      })
    );
    this.ccusageCache = {
      expiresAt: Date.now() + this.cacheMs,
      summaries
    };
    return summaries;
  }

  private async fetchCcusageMonthly(cli: string): Promise<CcusageMonthlySummary[] | null> {
    try {
      const stdout = await this.commandRunner(this.ccusageCommand, [cli, "monthly", "--json"]);
      if (!stdout.trim()) {
        return null;
      }

      return parseCcusageMonthly(stdout);
    } catch (error) {
      this.logger?.warn(
        {
          cli,
          error: error instanceof Error ? error.message : String(error)
        },
        "ccusage 用量统计读取失败，跳过该 CLI"
      );
      return null;
    }
  }
}
