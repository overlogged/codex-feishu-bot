import assert from "node:assert/strict";
import test from "node:test";

import { FeishuWsWatchdog, type FeishuWsWatchdogLogger } from "./feishu-ws-watchdog.js";

function createLogger(): {
  logger: FeishuWsWatchdogLogger;
  entries: Array<{ level: string; message: unknown }>;
} {
  const entries: Array<{ level: string; message: unknown }> = [];
  const record = (level: string) => (message: unknown) => {
    entries.push({
      level,
      message
    });
  };

  return {
    logger: {
      info: record("info"),
      warn: record("warn"),
      error: record("error")
    },
    entries
  };
}

test("FeishuWsWatchdog 掉线超过阈值后触发一次重建，恢复后复位", () => {
  let now = 0;
  let connected = true;
  const staleCalls: number[] = [];
  const { logger, entries } = createLogger();

  const watchdog = new FeishuWsWatchdog({
    isConnected: () => connected,
    logger,
    checkIntervalMs: 1_000,
    staleAfterMs: 3_000,
    now: () => now,
    onStale: ({ downMs }) => {
      staleCalls.push(downMs);
    }
  });

  connected = true;
  now = 0;
  assert.equal(watchdog.tick(), "connected");

  connected = false;
  now = 1_000;
  assert.equal(watchdog.tick(), "connecting");

  now = 3_000;
  assert.equal(watchdog.tick(), "connecting", "未超过阈值时只等待");

  now = 4_000;
  assert.equal(watchdog.tick(), "stale");
  assert.deepEqual(staleCalls, [3_000]);

  now = 5_000;
  assert.equal(watchdog.tick(), "stale");
  assert.deepEqual(staleCalls, [3_000], "同一轮掉线只重建一次，避免刷爆");

  connected = true;
  now = 6_000;
  assert.equal(watchdog.tick(), "connected");

  connected = false;
  now = 7_000;
  assert.equal(watchdog.tick(), "connecting");
  connected = false;
  now = 11_000;
  assert.equal(watchdog.tick(), "stale");
  assert.deepEqual(staleCalls, [3_000, 4_000], "恢复后再次掉线应重新计数并重建");

  assert.equal(
    entries.filter((entry) => entry.level === "error").length,
    2
  );
  assert.equal(
    entries.filter((entry) => entry.level === "warn").length,
    2
  );
});

test("FeishuWsWatchdog 启动后从未连上也会在宽限期结束后重建", () => {
  let now = 1_000;
  const staleCalls: number[] = [];
  const { logger } = createLogger();

  const watchdog = new FeishuWsWatchdog({
    isConnected: () => false,
    logger,
    checkIntervalMs: 500,
    staleAfterMs: 2_000,
    now: () => now,
    onStale: ({ downMs }) => {
      staleCalls.push(downMs);
    }
  });

  assert.equal(watchdog.tick(), "connecting");
  now = 2_000;
  assert.equal(watchdog.tick(), "connecting");
  now = 3_000;
  assert.equal(watchdog.tick(), "stale");
  assert.deepEqual(staleCalls, [2_000]);
});

test("FeishuWsWatchdog 判定半开连接：readyState 仍为 OPEN 但长时间无任何帧", () => {
  let now = 0;
  // socket 始终报告 OPEN，正是半开连接的特征。
  const connected = true;
  let lastActivityAt: number | null = 0;
  const staleCalls: Array<{ downMs: number; reason: string }> = [];
  const { logger, entries } = createLogger();

  const watchdog = new FeishuWsWatchdog({
    isConnected: () => connected,
    lastActivityAt: () => lastActivityAt,
    logger,
    checkIntervalMs: 1_000,
    staleAfterMs: 3_000,
    silentAfterMs: 10_000,
    now: () => now,
    onStale: (info) => {
      staleCalls.push(info);
    }
  });

  // 有活动时保持 connected。
  now = 5_000;
  lastActivityAt = 4_000;
  assert.equal(watchdog.tick(), "connected");
  assert.deepEqual(staleCalls, []);

  // 静默未达阈值时仍然认为正常。
  now = 10_000;
  assert.equal(watchdog.tick(), "connected", "静默未超过阈值不应误判");

  // 静默超过阈值后，即使 readyState 还是 OPEN 也必须重建。
  now = 15_000;
  assert.equal(watchdog.tick(), "stale");
  assert.deepEqual(staleCalls, [{ downMs: 11_000, reason: "silent" }]);

  // 同一轮静默只重建一次，避免刷爆。
  now = 16_000;
  assert.equal(watchdog.tick(), "stale");
  assert.equal(staleCalls.length, 1, "同一轮静默只触发一次重建");

  assert.ok(
    entries.some((entry) => entry.level === "error"),
    "半开连接应当记录 error 级日志"
  );
});

test("FeishuWsWatchdog 收到新帧后解除半开判定", () => {
  let now = 0;
  const connected = true;
  let lastActivityAt: number | null = 0;
  const staleCalls: Array<{ downMs: number; reason: string }> = [];
  const { logger } = createLogger();

  const watchdog = new FeishuWsWatchdog({
    isConnected: () => connected,
    lastActivityAt: () => lastActivityAt,
    logger,
    checkIntervalMs: 1_000,
    staleAfterMs: 3_000,
    silentAfterMs: 10_000,
    now: () => now,
    onStale: (info) => {
      staleCalls.push(info);
    }
  });

  now = 20_000;
  assert.equal(watchdog.tick(), "stale");

  // 链路恢复：又收到帧了。
  lastActivityAt = 20_000;
  assert.equal(watchdog.tick(), "connected");
  assert.equal(staleCalls.length, 1);

  // 恢复后的静默计时要重新开始，不能沿用旧的判定。
  now = 25_000;
  assert.equal(watchdog.tick(), "connected");
});

test("FeishuWsWatchdog 未提供 lastActivityAt 时退回纯 readyState 判断", () => {
  let now = 0;
  const connected = true;
  const staleCalls: Array<{ downMs: number; reason: string }> = [];
  const { logger } = createLogger();

  const watchdog = new FeishuWsWatchdog({
    isConnected: () => connected,
    logger,
    checkIntervalMs: 1_000,
    staleAfterMs: 3_000,
    silentAfterMs: 10_000,
    now: () => now,
    onStale: (info) => {
      staleCalls.push(info);
    }
  });

  // 即使过了很久，没有活性信号也不该判半开。
  now = 999_000;
  assert.equal(watchdog.tick(), "connected");
  assert.deepEqual(staleCalls, []);
});

test("FeishuWsWatchdog start/stop 使用注入的定时器", () => {
  let scheduled: (() => void) | undefined;
  let scheduledMs: number | undefined;
  let cancelled = false;
  let unrefed = false;
  const { logger } = createLogger();
  let connected = false;

  const watchdog = new FeishuWsWatchdog({
    isConnected: () => connected,
    logger,
    checkIntervalMs: 5_000,
    staleAfterMs: 10_000,
    scheduleInterval: (handler, ms) => {
      scheduled = handler;
      scheduledMs = ms;
      return {
        unref: () => {
          unrefed = true;
        }
      } as unknown as ReturnType<typeof setInterval>;
    },
    cancelInterval: () => {
      cancelled = true;
    }
  });

  watchdog.start();
  assert.equal(scheduledMs, 5_000);
  assert.equal(unrefed, true);

  connected = true;
  scheduled?.();

  watchdog.start();
  watchdog.stop();
  assert.equal(cancelled, true);

  watchdog.stop();
});
