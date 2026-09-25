import assert from "node:assert/strict";
import test from "node:test";

import { CodexAuthService, parseCodexAuthRegistry } from "./codex-auth-service.js";

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

function buildRegistry(activeKey: string): string {
  return JSON.stringify({
    schema_version: 3,
    active_account_key: activeKey,
    auto_switch: {
      enabled: true,
      threshold_5h_percent: 10,
      threshold_weekly_percent: 5
    },
    accounts: [
      {
        account_key: "key_a",
        email: "alpha@example.com",
        alias: "",
        plan: "pro",
        last_usage: {
          primary: { used_percent: 0, window_minutes: 10080, resets_at: 1_800_000_000 },
          secondary: null,
          plan_type: "pro"
        }
      },
      {
        account_key: "key_b",
        email: "beta@example.com",
        alias: "备用",
        plan: "free",
        last_usage: {
          primary: { used_percent: 74.5, window_minutes: 43200, resets_at: null },
          secondary: { used_percent: 10, window_minutes: 300, resets_at: null },
          plan_type: "free"
        }
      }
    ]
  });
}

function createService(options: {
  registryText?: () => string;
  runner?: (command: string, args: string[]) => Promise<string>;
}) {
  const calls: string[][] = [];
  const service = new CodexAuthService(
    { command: "codex-auth", registryFile: "/registry.json" },
    createLogger(),
    async (command, args) => {
      calls.push([command, ...args]);
      if (options.runner) {
        return options.runner(command, args);
      }
      return "";
    },
    async () => options.registryText?.() ?? buildRegistry("key_a")
  );
  return { service, calls };
}

test("parseCodexAuthRegistry reads accounts, active key and auto-switch config", () => {
  const registry = parseCodexAuthRegistry(buildRegistry("key_b"));

  assert.equal(registry.activeKey, "key_b");
  assert.equal(registry.accounts.length, 2);
  assert.equal(registry.accounts[0]?.email, "alpha@example.com");
  assert.equal(registry.accounts[0]?.primary?.usedPercent, 0);
  assert.equal(registry.accounts[1]?.secondary?.windowMinutes, 300);
  assert.deepEqual(registry.autoSwitch, {
    enabled: true,
    threshold5hPercent: 10,
    thresholdWeeklyPercent: 5
  });
});

test("buildAccountsReport renders active marker, window labels and auto-switch status", async () => {
  const { service, calls } = createService({});

  const report = await service.buildAccountsReport();

  assert.deepEqual(calls, [["codex-auth", "list"]]);
  assert.match(report, /\* alpha@example\.com（Pro）/);
  assert.match(report, /备用（beta@example\.com）（Free）/);
  assert.match(report, /周窗口：已用 0%（.*重置）/);
  assert.match(report, /月窗口：已用 74\.5%/);
  assert.match(report, /5 小时窗口：已用 10%/);
  assert.match(report, /自动切换：开启（5 小时窗口剩余 <10%、周窗口剩余 <5%时切换）/);
  assert.match(report, /切账号 <邮箱或关键词>/);
  assert.doesNotMatch(report, /刷新失败/);
});

test("buildAccountsReport notes stale data when codex-auth list fails", async () => {
  const { service } = createService({
    runner: async () => {
      throw new Error("api offline");
    }
  });

  const report = await service.buildAccountsReport();

  assert.match(report, /用量刷新失败，以下为上次缓存数据/);
});

test("switchAccount runs codex-auth switch and confirms the new active account", async () => {
  let activeKey = "key_a";
  const { service, calls } = createService({
    registryText: () => buildRegistry(activeKey),
    runner: async (_command, args) => {
      if (args[0] === "switch") {
        activeKey = "key_b";
      }
      return "";
    }
  });

  const reply = await service.switchAccount("beta");

  assert.deepEqual(calls, [["codex-auth", "switch", "beta"]]);
  assert.match(reply, /已切换到 Codex 账号 备用（beta@example\.com）（Free）/);
  assert.match(reply, /auth-watch 会自动重启 app-server/);
});

test("switchAccount reports when the account is already active", async () => {
  const { service } = createService({});

  const reply = await service.switchAccount("alpha@example.com");

  assert.match(reply, /当前账号已经是 alpha@example\.com（Pro），未发生变化。/);
});

test("switchAccount surfaces CLI failures", async () => {
  const { service } = createService({
    runner: async (_command, args) => {
      if (args[0] === "switch") {
        throw new Error("no account matches");
      }
      return "";
    }
  });

  const reply = await service.switchAccount("ghost");

  assert.match(reply, /切换账号失败：no account matches/);
});

test("switchAccount rejects flag-like queries without running the CLI", async () => {
  const { service, calls } = createService({});

  const reply = await service.switchAccount("--api");

  assert.equal(reply, "账号关键词不能以 - 开头。");
  assert.deepEqual(calls, []);
});
