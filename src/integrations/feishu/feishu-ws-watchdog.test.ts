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
