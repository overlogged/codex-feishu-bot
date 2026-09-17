import assert from "node:assert/strict";
import test from "node:test";

import type {
  CodexAccountUsage,
  CodexRateLimits,
  CodexWorker
} from "../integrations/codex/codex-worker.js";
import type { KimiQuota } from "../integrations/kimi/kimi-quota-client.js";
import { UsageSnapshotStore } from "../stores/usage-snapshot-store.js";
import {
  collectRateLimitWindows,
  formatTokenCount,
  UsageStatsService,
  type UsageStatsCommandRunner
} from "./usage-stats-service.js";

function createWorker(overrides: Partial<CodexWorker> = {}): CodexWorker {
  return {
    async ensureThread() {
      return "thread_should_not_start";
    },
    async *runTurn() {
      return undefined;
    },
    ...overrides
  };
}

function createLogger() {
  return {
    info() {
      return undefined;
    },
    warn() {
      return undefined;
    },
    error() {
      return undefined;
    }
  };
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

const rateLimitsFixture: CodexRateLimits = {
  rateLimits: {
    limitId: "codex",
    limitName: "GPT-6",
    primary: {
      usedPercent: 42,
      windowDurationMins: 300,
      resetsAt: 1_800_000_000
    },
    secondary: {
      usedPercent: 10.5,
      windowDurationMins: 10080,
      resetsAt: null
    },
    credits: {
      hasCredits: true,
      unlimited: false,
      balance: "12.34"
    },
    planType: "pro",
    spendControlReached: false
  },
  rateLimitsByLimitId: null,
  accountId: "acc_1"
};

const accountUsageFixture: CodexAccountUsage = {
  summary: {
    lifetimeTokens: 250_000_000,
    peakDailyTokens: 12_000_000,
    longestRunningTurnSec: 3600,
    currentStreakDays: 3,
    longestStreakDays: 10
  },
  dailyUsageBuckets: [
    { startDate: "2026-09-08", tokens: 100_000 },
    { startDate: "2026-09-09", tokens: 200_000 },
    { startDate: "2026-09-10", tokens: 300_000 },
    { startDate: "2026-09-11", tokens: 400_000 },
    { startDate: "2026-09-12", tokens: 500_000 },
    { startDate: "2026-09-13", tokens: 600_000 },
    { startDate: "2026-09-14", tokens: 700_000 },
    { startDate: "2026-09-15", tokens: 800_000 }
  ]
};

function ccusageMonthlyFixture(): string {
  return JSON.stringify({
    monthly: [
      {
        month: currentMonth(),
        totalTokens: 12_345_678,
        totalCost: 12.3456,
        modelBreakdowns: [
          {
            modelName: "gpt-5.4",
            inputTokens: 100_000,
            outputTokens: 50_000,
            cacheReadTokens: 1_000_000,
            cost: 2.5
          }
        ]
      }
    ]
  });
}

function localDateKey(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function ccusageDailyFixture(totalTokens = 1_000_000, costUSD = 1): string {
  return JSON.stringify({
    daily: [
      {
        date: localDateKey(),
        totalTokens,
        costUSD,
        modelBreakdowns: [
          {
            modelName: "gpt-test",
            inputTokens: totalTokens * 0.6,
            outputTokens: totalTokens * 0.4,
            cost: costUSD * 0.6
          },
          {
            modelName: "gpt-test-mini",
            inputTokens: totalTokens * 0.3,
            outputTokens: totalTokens * 0.1,
            cost: costUSD * 0.4
          }
        ]
      }
    ]
  });
}

function ccusageCodexFixture(): string {
  return JSON.stringify({
    monthly: [
      {
        month: currentMonth(),
        totalTokens: 5_328_902_554,
        costUSD: 2197.88,
        models: {
          "gpt-5.4": {
            inputTokens: 257_489_398,
            outputTokens: 19_410_468,
            cacheReadTokens: 5_052_002_688,
            totalTokens: 5_328_902_554
          }
        }
      }
    ]
  });
}

const defaultConfig = {
  ccusageCommand: "ccusage",
  cacheMs: 300_000,
  usdToCnyRate: 7.2
};

function createKimiQuotaClientStub(quota: KimiQuota | null) {
  return {
    async readQuota() {
      return quota;
    }
  };
}

const kimiQuotaFixture: KimiQuota = {
  limit5h: {
    usedRatio: 0.768033,
    resetAt: "2026-09-16T17:32:10Z"
  },
  limit7d: {
    usedRatio: 0.681582,
    resetAt: "2026-09-18T01:32:10Z"
  },
  boosterWallet: {
    balanceCents: 12345,
    currency: "CNY"
  }
};

test("UsageStatsService renders quota, cumulative usage and ccusage sections", async () => {
  const commandRunner: UsageStatsCommandRunner = async (_command, args) => {
    return args[0] === "codex" ? ccusageCodexFixture() : ccusageMonthlyFixture();
  };
  const service = new UsageStatsService(
    createWorker({
      async readRateLimits() {
        return rateLimitsFixture;
      },
      async readAccountUsage() {
        return accountUsageFixture;
      }
    }),
    defaultConfig,
    createLogger(),
    commandRunner,
    createKimiQuotaClientStub(kimiQuotaFixture)
  );

  const report = await service.buildReport();

  assert.match(report, /额度与用量统计/);
  assert.match(report, /套餐：pro/);
  assert.match(report, /GPT-6 5 小时窗口：已用 42%（\d+月\d+日 \d{2}:\d{2} 重置）/);
  assert.match(report, /GPT-6 7 天窗口：已用 10\.5%/);
  assert.match(report, /credits 余额：12\.34/);
  assert.match(report, /【Kimi 账号额度（实时，含 k3 等全部模型）】/);
  assert.match(report, /5 小时窗口：已用 76\.8%（\d+月\d+日 \d{2}:\d{2} 重置）/);
  assert.match(report, /7 天窗口：已用 68\.2%（\d+月\d+日 \d{2}:\d{2} 重置）/);
  assert.match(report, /加油包余额：¥123\.45/);
  assert.match(report, /终身累计：2\.50 亿 token/);
  assert.match(report, /最近 7 天：350\.0 万 token/);
  assert.match(report, /连续使用：3 天（最长 10 天）/);
  assert.match(report, new RegExp(`Codex（${currentMonth()}）：53\\.29 亿 token，估算费用 ¥15824\\.74`));
  assert.match(report, /· gpt-5\.4：53\.29 亿 token/);
  assert.match(report, /Claude（[^）]+）：1234\.6 万 token，估算费用 ¥88\.89/);
  assert.match(report, /· gpt-5\.4：115\.0 万 token（¥18\.00）/);
  assert.match(report, /费用说明：ccusage 按公开 API 定价估算，USD 按汇率 7\.2 折算为人民币。/);
});

test("UsageStatsService renders Kimi fallback line when the client is missing or returns null", async () => {
  const withoutClient = new UsageStatsService(
    createWorker(),
    defaultConfig,
    createLogger(),
    async () => ccusageMonthlyFixture()
  );
  assert.match(
    await withoutClient.buildReport(),
    /Kimi 额度暂不可用（需要本机 kimi 登录态）/
  );

  const withNullQuota = new UsageStatsService(
    createWorker(),
    defaultConfig,
    createLogger(),
    async () => ccusageMonthlyFixture(),
    createKimiQuotaClientStub(null)
  );
  assert.match(
    await withNullQuota.buildReport(),
    /Kimi 额度暂不可用（需要本机 kimi 登录态）/
  );
});

test("UsageStatsService converts ccusage cost estimates to RMB at the configured rate", async () => {
  const service = new UsageStatsService(
    createWorker(),
    {
      ...defaultConfig,
      usdToCnyRate: 7.5
    },
    createLogger(),
    async () =>
      JSON.stringify({
        monthly: [
          {
            month: currentMonth(),
            totalTokens: 1_000_000,
            totalCost: 10,
            modelBreakdowns: []
          }
        ]
      })
  );

  const report = await service.buildReport();

  assert.match(report, /估算费用 ¥75\.00/);
  assert.doesNotMatch(report, /\$10/);
  assert.match(report, /USD 按汇率 7\.5 折算为人民币/);
});

test("UsageStatsService degrades gracefully when the quota APIs are unavailable", async () => {
  const service = new UsageStatsService(
    createWorker({
      async readRateLimits() {
        return null;
      },
      async readAccountUsage() {
        return null;
      }
    }),
    defaultConfig,
    createLogger(),
    async () => {
      throw new Error("ccusage not installed");
    }
  );

  const report = await service.buildReport();

  assert.match(report, /额度接口暂不可用/);
  assert.doesNotMatch(report, /累计用量/);
  assert.match(report, /ccusage 不可用或暂无历史用量/);
});

test("UsageStatsService skips failing CLIs and caches ccusage results", async () => {
  const calls: string[] = [];
  const commandRunner: UsageStatsCommandRunner = async (_command, args) => {
    const cli = args[0] ?? "";
    calls.push(cli);
    if (cli === "pi") {
      throw new Error("pi 数据目录不存在");
    }
    return ccusageMonthlyFixture();
  };
  const service = new UsageStatsService(createWorker(), defaultConfig, createLogger(), commandRunner);

  const report = await service.buildReport();

  assert.match(report, /Codex（/);
  assert.match(report, /Claude（/);
  assert.match(report, /Kimi（/);
  assert.doesNotMatch(report, /Pi（/);

  await service.buildReport();
  // 每个月度 + 每天各一次（4 个 CLI），第二次调用命中缓存
  assert.equal(calls.length, 8);
});

test("UsageStatsService renders today's consumption and estimates the last hour", async () => {
  const snapshotStore = new UsageSnapshotStore();
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await snapshotStore.record({
    at: hourAgo,
    totals: {
      codex: { tokens: 400_000, cost: 0.4 },
      claude: { tokens: 400_000, cost: 0.4 },
      kimi: { tokens: 400_000, cost: 0.4 },
      pi: { tokens: 400_000, cost: 0.4 }
    }
  });

  const commandRunner: UsageStatsCommandRunner = async (_command, args) => {
    return args[1] === "daily" ? ccusageDailyFixture() : ccusageMonthlyFixture();
  };
  const service = new UsageStatsService(
    createWorker(),
    defaultConfig,
    createLogger(),
    commandRunner,
    undefined,
    snapshotStore
  );

  const report = await service.buildReport();

  assert.match(report, /【今日消耗（ccusage，自然日）】/);
  assert.match(report, /Codex：100\.0 万 token，估算费用 ¥7\.20/);
  assert.match(report, /· gpt-test：100\.0 万 token（¥4\.32）/);
  assert.match(report, /· gpt-test-mini：40\.0 万 token（¥2\.88）/);
  assert.match(report, /合计：400\.0 万 token/);
  assert.match(report, /【近 1 小时消耗（估算）】/);
  assert.match(report, /Codex：60\.0 万 token/);
  assert.match(report, /合计：240\.0 万 token/);
});

test("UsageStatsService reports when the hourly estimate needs more history", async () => {
  const snapshotStore = new UsageSnapshotStore();
  const commandRunner: UsageStatsCommandRunner = async (_command, args) => {
    return args[1] === "daily" ? ccusageDailyFixture() : ccusageMonthlyFixture();
  };
  const service = new UsageStatsService(
    createWorker(),
    defaultConfig,
    createLogger(),
    commandRunner,
    undefined,
    snapshotStore
  );

  const report = await service.buildReport();
  assert.match(report, /需要累计约 1 小时的运行快照后才能估算/);
});

test("UsageStatsService builds a daily token report", async () => {
  const commandRunner: UsageStatsCommandRunner = async (_command, args) => {
    return args[1] === "daily" ? ccusageDailyFixture(2_000_000, 2) : ccusageMonthlyFixture();
  };
  const service = new UsageStatsService(createWorker(), defaultConfig, createLogger(), commandRunner);

  const report = await service.buildDailyReport();
  assert.match(report, new RegExp(`Token 消耗日报（${localDateKey()}）`));
  assert.match(report, /Codex：200\.0 万 token，估算费用 ¥14\.40/);
  assert.match(report, /费用说明：ccusage/);
});

test("collectRateLimitWindows dedupes snapshots shared between rateLimits and rateLimitsByLimitId", () => {
  const windows = collectRateLimitWindows({
    ...rateLimitsFixture,
    rateLimitsByLimitId: {
      codex: rateLimitsFixture.rateLimits
    }
  });

  assert.equal(windows.length, 2);
  assert.deepEqual(
    windows.map((window) => window.key).sort(),
    ["codex:primary", "codex:secondary"]
  );
});

test("formatTokenCount renders 亿/万 units", () => {
  assert.equal(formatTokenCount(5_328_902_554), "53.29 亿");
  assert.equal(formatTokenCount(3_300_000), "330.0 万");
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(null), "未知");
});
