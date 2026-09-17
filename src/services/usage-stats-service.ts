import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  CodexAccountUsage,
  CodexRateLimits,
  CodexRateLimitSnapshot,
  CodexWorker
} from "../integrations/codex/codex-worker.js";
import type { KimiQuota, KimiQuotaWindow } from "../integrations/kimi/kimi-quota-client.js";
import type {
  UsageSnapshot,
  UsageSnapshotCliTotals,
  UsageSnapshotStore
} from "../stores/usage-snapshot-store.js";

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
  /** 记录当日累计用量快照的间隔，用于估算「近 1 小时」消耗。 */
  snapshotIntervalMs?: number;
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

interface CcusageDailySummary {
  date: string;
  totalTokens: number | null;
  totalCost: number | null;
  topModels: CcusageModelBreakdown[];
}

const RECENT_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

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

function normalizeCcusageModelName(value: string): string {
  // 统一报告会给模型加 `[pi]` / `[claude]` 前缀去做 agent 区分；这里按 CLI 渲染，去掉前缀更易读。
  return value.replace(/^\[[a-z0-9_-]+\]\s*/i, "").trim() || value;
}

function parseCcusageModelBreakdowns(
  entry: Record<string, unknown>,
  limit = 3
): CcusageModelBreakdown[] {
  const breakdowns: CcusageModelBreakdown[] = [];

  if (Array.isArray(entry.modelBreakdowns)) {
    for (const item of entry.modelBreakdowns) {
      const record = asRecord(item);
      if (!record || typeof record.modelName !== "string") {
        continue;
      }

      breakdowns.push({
        modelName: normalizeCcusageModelName(record.modelName),
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
          modelName: normalizeCcusageModelName(modelName),
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
    .slice(0, limit);
}

function parseCcusageDaily(stdout: string): CcusageDailySummary[] {
  const parsed = asRecord(JSON.parse(stdout));
  if (!parsed || !Array.isArray(parsed.daily)) {
    return [];
  }

  const summaries: CcusageDailySummary[] = [];
  for (const item of parsed.daily) {
    const entry = asRecord(item);
    if (!entry) {
      continue;
    }

    const date =
      typeof entry.date === "string" && entry.date
        ? entry.date
        : typeof entry.period === "string" && entry.period
          ? entry.period
          : undefined;
    if (!date) {
      continue;
    }

    summaries.push({
      date,
      totalTokens: numberOrNull(entry.totalTokens),
      totalCost: numberOrNull(entry.totalCost) ?? numberOrNull(entry.costUSD),
      topModels: parseCcusageModelBreakdowns(entry, 5)
    });
  }

  return summaries;
}

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
  private readonly snapshotIntervalMs: number;
  private ccusageCache:
    | {
        expiresAt: number;
        summaries: Map<string, CcusageMonthlySummary[] | null>;
      }
    | undefined;
  private ccusageDailyCache:
    | {
        expiresAt: number;
        summaries: Map<string, CcusageDailySummary[] | null>;
      }
    | undefined;
  private ccusageDailyInflight?: Promise<Map<string, CcusageDailySummary[] | null>>;
  private snapshotTimer?: NodeJS.Timeout;

  constructor(
    private readonly codexWorker: CodexWorker,
    config: UsageStatsServiceConfig,
    private readonly logger?: LoggerLike,
    commandRunner?: UsageStatsCommandRunner,
    kimiQuotaClient?: KimiQuotaReader,
    private readonly snapshotStore?: UsageSnapshotStore
  ) {
    this.ccusageCommand = config.ccusageCommand;
    this.cacheMs = config.cacheMs;
    this.usdToCnyRate = config.usdToCnyRate;
    this.snapshotIntervalMs = config.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
    this.commandRunner = commandRunner ?? defaultCommandRunner;
    this.kimiQuotaClient = kimiQuotaClient;
  }

  start(): void {
    if (!this.snapshotStore || this.snapshotTimer) {
      return;
    }

    void this.recordUsageSnapshot();
    this.snapshotTimer = setInterval(() => {
      void this.recordUsageSnapshot();
    }, this.snapshotIntervalMs);
    this.snapshotTimer.unref?.();
  }

  stop(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = undefined;
    }
  }

  async buildReport(): Promise<string> {
    // 提前触发按天统计，让 ccusage daily 和 monthly 并发，而不是串行等待。
    const dailyLoad = this.loadCcusageDailySummaries();
    const [rateLimitsLines, kimiQuotaLines, accountUsageLines, ccusageLines] = await Promise.all([
      this.buildRateLimitsSection(),
      this.buildKimiQuotaSection(),
      this.buildAccountUsageSection(),
      this.buildCcusageSection()
    ]);
    await dailyLoad;
    const todayLines = await this.buildTodaySection();
    const recentLines = await this.buildRecentHourSection();

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
      "【今日消耗（ccusage，自然日）】",
      ...todayLines,
      "",
      "【近 1 小时消耗（估算）】",
      ...recentLines,
      "",
      "【各 CLI 历史用量（本月，ccusage）】",
      ...ccusageLines,
      "",
      this.renderPricingNote()
    ].join("\n");
  }

  /** 每日 token 消耗日报（只包含当天用量，适合定时推送）。 */
  async buildDailyReport(): Promise<string> {
    const lines = await this.buildTodaySection();
    return [
      `Token 消耗日报（${localDateKey()}）`,
      "",
      ...lines,
      "",
      this.renderPricingNote()
    ].join("\n");
  }

  private renderPricingNote(): string {
    return [
      `费用说明：ccusage 按公开 API 定价估算，USD 按汇率 ${this.usdToCnyRate} 折算为人民币。`,
      "订阅套餐（Kimi / Codex）的金额是按 API 价格的折算，不等于实际账单；自定义 provider 的价格取自本机 pi 的 models.json，配置为 0 就会显示 0。",
      "仅供参考。"
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

  private async buildTodaySection(): Promise<string[]> {
    const summaries = await this.loadCcusageDailySummaries();
    const today = localDateKey();
    const lines: string[] = [];
    let totalTokens = 0;
    let totalCost = 0;
    let hasTokens = false;
    let hasCost = false;

    for (const cli of CCUSAGE_CLIS) {
      const rows = summaries.get(cli);
      if (!rows) {
        continue;
      }

      const row = rows.find((entry) => entry.date === today);
      if (!row) {
        continue;
      }

      if (typeof row.totalTokens === "number") {
        totalTokens += row.totalTokens;
        hasTokens = true;
      }
      if (typeof row.totalCost === "number") {
        totalCost += row.totalCost;
        hasCost = true;
      }

      lines.push(
        `${renderCliLabel(cli)}：${formatTokenCount(row.totalTokens)} token${
          row.totalCost !== null ? `，估算费用 ${this.formatCny(row.totalCost)}` : ""
        }`
      );
      for (const model of row.topModels) {
        lines.push(
          `  · ${model.modelName}：${formatTokenCount(model.totalTokens)} token${
            model.cost !== null ? `（${this.formatCny(model.cost)}）` : "（无单模型定价）"
          }`
        );
      }
    }

    if (lines.length === 0) {
      return ["ccusage 不可用或今天暂无用量"];
    }

    lines.push(
      `合计：${formatTokenCount(hasTokens ? totalTokens : null)} token${
        hasCost ? `，估算费用 ${this.formatCny(totalCost)}` : ""
      }`
    );
    return lines;
  }

  private async buildTodayTotals(): Promise<Record<string, UsageSnapshotCliTotals> | null> {
    const summaries = await this.loadCcusageDailySummaries();
    const today = localDateKey();
    const totals: Record<string, UsageSnapshotCliTotals> = {};
    let any = false;

    for (const cli of CCUSAGE_CLIS) {
      const rows = summaries.get(cli);
      if (!rows) {
        continue;
      }

      const row = rows.find((entry) => entry.date === today);
      totals[cli] = row
        ? { tokens: row.totalTokens, cost: row.totalCost }
        : { tokens: 0, cost: 0 };
      any = any || (row?.totalTokens ?? null) !== null || (row?.totalCost ?? null) !== null;
    }

    return any ? totals : null;
  }

  private async recordUsageSnapshot(): Promise<void> {
    if (!this.snapshotStore) {
      return;
    }

    try {
      await this.snapshotStore.load();
      const totals = await this.buildTodayTotals();
      if (!totals) {
        return;
      }

      const snapshot: UsageSnapshot = {
        at: new Date().toISOString(),
        totals
      };
      await this.snapshotStore.record(snapshot);
    } catch (error) {
      this.logger?.warn(
        {
          error: error instanceof Error ? error.message : String(error)
        },
        "记录用量快照失败"
      );
    }
  }

  private async buildRecentHourSection(): Promise<string[]> {
    if (!this.snapshotStore) {
      return ["用量快照未启用，无法估算近 1 小时消耗。"];
    }

    // 先记录当前快照，保证累计值是最新的，再和约 1 小时前的快照做差。
    await this.recordUsageSnapshot();
    const current = await this.buildTodayTotals();
    if (!current) {
      return ["ccusage 不可用，无法估算近 1 小时消耗。"];
    }

    const now = Date.now();
    const target = now - RECENT_WINDOW_MS;
    const today = localDateKey();
    const candidates = this.snapshotStore
      .list()
      .filter((snapshot) => localDateKey(new Date(snapshot.at)) === today)
      .filter((snapshot) => {
        const at = new Date(snapshot.at).getTime();
        return Number.isFinite(at) && at <= now - 45 * 60 * 1000;
      });

    if (candidates.length === 0) {
      return ["需要累计约 1 小时的运行快照后才能估算，请稍后再试。"];
    }

    const reference = candidates.reduce((best, snapshot) => {
      const diff = Math.abs(new Date(snapshot.at).getTime() - target);
      const bestDiff = Math.abs(new Date(best.at).getTime() - target);
      return diff < bestDiff ? snapshot : best;
    });

    const lines: string[] = [];
    let total = 0;
    for (const cli of CCUSAGE_CLIS) {
      const nowTokens = current[cli]?.tokens ?? null;
      const beforeTokens = reference.totals[cli]?.tokens ?? null;
      if (nowTokens === null || beforeTokens === null) {
        continue;
      }

      const delta = Math.max(0, nowTokens - beforeTokens);
      total += delta;
      lines.push(`${renderCliLabel(cli)}：${formatTokenCount(delta)} token`);
    }

    if (lines.length === 0) {
      return ["近 1 小时暂无可估算数据"];
    }

    lines.push(`合计：${formatTokenCount(total)} token`);
    return lines;
  }

  private loadCcusageDailySummaries(): Promise<Map<string, CcusageDailySummary[] | null>> {
    if (this.ccusageDailyCache && this.ccusageDailyCache.expiresAt > Date.now()) {
      return Promise.resolve(this.ccusageDailyCache.summaries);
    }

    if (this.ccusageDailyInflight) {
      return this.ccusageDailyInflight;
    }

    const load = (async () => {
      const summaries = new Map<string, CcusageDailySummary[] | null>();
      await Promise.all(
        CCUSAGE_CLIS.map(async (cli) => {
          summaries.set(cli, await this.fetchCcusageDaily(cli));
        })
      );
      this.ccusageDailyCache = {
        expiresAt: Date.now() + this.cacheMs,
        summaries
      };
      return summaries;
    })();

    this.ccusageDailyInflight = load;
    void load.finally(() => {
      if (this.ccusageDailyInflight === load) {
        this.ccusageDailyInflight = undefined;
      }
    });
    return load;
  }

  private async fetchCcusageDaily(cli: string): Promise<CcusageDailySummary[] | null> {
    try {
      const stdout = await this.commandRunner(this.ccusageCommand, [cli, "daily", "--json"]);
      if (!stdout.trim()) {
        return null;
      }

      return parseCcusageDaily(stdout);
    } catch (error) {
      this.logger?.warn(
        {
          cli,
          error: error instanceof Error ? error.message : String(error)
        },
        "ccusage 日记用量读取失败，跳过该 CLI"
      );
      return null;
    }
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
