import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { codexProxyEnv } from "../config/proxy-env.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

export interface CodexAuthServiceConfig {
  /** codex-auth CLI 命令。 */
  command: string;
  /** codex-auth 的 registry.json 路径（~/.codex/accounts/registry.json）。 */
  registryFile: string;
}

export type CodexAuthCommandRunner = (command: string, args: string[]) => Promise<string>;
export type CodexAuthRegistryReader = (registryFile: string) => Promise<string>;

interface CodexAuthUsageWindow {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
}

interface CodexAuthAccount {
  key: string;
  email: string;
  alias: string | null;
  plan: string | null;
  primary: CodexAuthUsageWindow | null;
  secondary: CodexAuthUsageWindow | null;
}

interface CodexAuthRegistry {
  activeKey: string | null;
  autoSwitch: {
    enabled: boolean;
    threshold5hPercent: number | null;
    thresholdWeeklyPercent: number | null;
  } | null;
  accounts: CodexAuthAccount[];
}

const execFileAsync = promisify(execFile);

const defaultCommandRunner: CodexAuthCommandRunner = async (command, args) => {
  const { stdout } = await execFileAsync(command, args, {
    env: codexProxyEnv(),
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024
  });
  return stdout;
};

const defaultRegistryReader: CodexAuthRegistryReader = (registryFile) =>
  readFile(registryFile, "utf8");

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function parseWindow(value: unknown): CodexAuthUsageWindow | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const usedPercent = numberOrNull(record.used_percent);
  if (usedPercent === null) {
    return null;
  }

  return {
    usedPercent,
    windowMinutes: numberOrNull(record.window_minutes),
    resetsAt: numberOrNull(record.resets_at)
  };
}

export function parseCodexAuthRegistry(text: string): CodexAuthRegistry {
  const parsed = asRecord(JSON.parse(text));
  const autoSwitch = asRecord(parsed?.auto_switch);
  const accounts: CodexAuthAccount[] = [];

  for (const item of Array.isArray(parsed?.accounts) ? parsed.accounts : []) {
    const record = asRecord(item);
    const key = stringOrNull(record?.account_key);
    const email = stringOrNull(record?.email);
    if (!record || !key || !email) {
      continue;
    }

    const usage = asRecord(record.last_usage);
    accounts.push({
      key,
      email,
      alias: stringOrNull(record.alias),
      plan: stringOrNull(record.plan) ?? stringOrNull(usage?.plan_type),
      primary: parseWindow(usage?.primary),
      secondary: parseWindow(usage?.secondary)
    });
  }

  return {
    activeKey: stringOrNull(parsed?.active_account_key),
    autoSwitch: autoSwitch
      ? {
          enabled: autoSwitch.enabled === true,
          threshold5hPercent: numberOrNull(autoSwitch.threshold_5h_percent),
          thresholdWeeklyPercent: numberOrNull(autoSwitch.threshold_weekly_percent)
        }
      : null,
    accounts
  };
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}

function formatResetTime(resetsAt: number | null): string | null {
  if (resetsAt === null) {
    return null;
  }

  const date = new Date(resetsAt * 1000);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}月${day}日 ${hour}:${minute}`;
}

function renderWindowLabel(windowMinutes: number | null): string {
  if (windowMinutes === 300) {
    return "5 小时窗口";
  }
  if (windowMinutes === 10080) {
    return "周窗口";
  }
  if (windowMinutes === 43200) {
    return "月窗口";
  }
  if (windowMinutes !== null && windowMinutes % 1440 === 0) {
    return `${windowMinutes / 1440} 天窗口`;
  }
  if (windowMinutes !== null && windowMinutes % 60 === 0) {
    return `${windowMinutes / 60} 小时窗口`;
  }
  return "额度窗口";
}

function renderPlan(plan: string | null): string {
  if (!plan) {
    return "未知套餐";
  }
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function renderAccountName(account: CodexAuthAccount): string {
  return account.alias ? `${account.alias}（${account.email}）` : account.email;
}

function renderWindowLine(window: CodexAuthUsageWindow): string {
  const resetLabel = formatResetTime(window.resetsAt);
  return `  ${renderWindowLabel(window.windowMinutes)}：已用 ${formatPercent(window.usedPercent)}%${
    resetLabel ? `（${resetLabel} 重置）` : ""
  }`;
}

export class CodexAuthService {
  private readonly command: string;
  private readonly registryFile: string;
  private readonly commandRunner: CodexAuthCommandRunner;
  private readonly registryReader: CodexAuthRegistryReader;

  constructor(
    config: CodexAuthServiceConfig,
    private readonly logger?: LoggerLike,
    commandRunner?: CodexAuthCommandRunner,
    registryReader?: CodexAuthRegistryReader
  ) {
    this.command = config.command;
    this.registryFile = config.registryFile;
    this.commandRunner = commandRunner ?? defaultCommandRunner;
    this.registryReader = registryReader ?? defaultRegistryReader;
  }

  /** 账号列表与额度报告。先跑 codex-auth list 刷新用量，再读 registry 渲染。 */
  async buildAccountsReport(): Promise<string> {
    const refreshed = await this.refreshUsage();
    const registry = await this.readRegistry();

    const lines: string[] = ["Codex 账号（codex-auth）"];
    if (!refreshed) {
      lines.push("（用量刷新失败，以下为上次缓存数据）");
    }
    lines.push("");

    if (registry.accounts.length === 0) {
      lines.push("registry 里还没有任何账号。");
    }
    for (const account of registry.accounts) {
      const activeMark = account.key === registry.activeKey ? "* " : "  ";
      lines.push(`${activeMark}${renderAccountName(account)}（${renderPlan(account.plan)}）`);
      if (account.primary) {
        lines.push(renderWindowLine(account.primary));
      }
      if (account.secondary) {
        lines.push(renderWindowLine(account.secondary));
      }
      if (!account.primary && !account.secondary) {
        lines.push("  暂无额度数据");
      }
    }

    if (registry.autoSwitch) {
      lines.push("");
      if (registry.autoSwitch.enabled) {
        const conditions: string[] = [];
        if (registry.autoSwitch.threshold5hPercent !== null) {
          conditions.push(`5 小时窗口剩余 <${registry.autoSwitch.threshold5hPercent}%`);
        }
        if (registry.autoSwitch.thresholdWeeklyPercent !== null) {
          conditions.push(`周窗口剩余 <${registry.autoSwitch.thresholdWeeklyPercent}%`);
        }
        lines.push(
          `自动切换：开启${conditions.length > 0 ? `（${conditions.join("、")}时切换）` : ""}`
        );
      } else {
        lines.push("自动切换：关闭");
      }
    }

    lines.push("", "切换账号：私聊发送“切账号 <邮箱或关键词>”。");
    return lines.join("\n");
  }

  /** 切换当前 Codex 账号，返回给用户的结果说明。 */
  async switchAccount(query: string): Promise<string> {
    const trimmed = query.trim();
    if (!trimmed) {
      return "用法：切账号 <邮箱或关键词>，例如“切账号 overlogged@icloud.com”。";
    }
    if (trimmed.startsWith("-")) {
      return "账号关键词不能以 - 开头。";
    }

    const before = await this.tryReadRegistry();
    try {
      await this.commandRunner(this.command, ["switch", trimmed]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger?.warn({ query: trimmed, error: detail }, "codex-auth 切换账号失败");
      return `切换账号失败：${detail}`;
    }

    const after = await this.tryReadRegistry();
    const active = after?.accounts.find((account) => account.key === after.activeKey);
    if (!after || !active) {
      return `已执行 codex-auth switch ${trimmed}，但没能确认当前账号，请发送“账号”查看。`;
    }

    if (before?.activeKey && before.activeKey === after.activeKey) {
      return `当前账号已经是 ${renderAccountName(active)}（${renderPlan(active.plan)}），未发生变化。`;
    }

    return [
      `已切换到 Codex 账号 ${renderAccountName(active)}（${renderPlan(active.plan)}）。`,
      "auth-watch 会自动重启 app-server，正在进行的会话稍后在新账号上恢复。"
    ].join("\n");
  }

  private async refreshUsage(): Promise<boolean> {
    try {
      await this.commandRunner(this.command, ["list"]);
      return true;
    } catch (error) {
      this.logger?.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "codex-auth list 刷新用量失败，使用 registry 缓存数据"
      );
      return false;
    }
  }

  private async readRegistry(): Promise<CodexAuthRegistry> {
    return parseCodexAuthRegistry(await this.registryReader(this.registryFile));
  }

  private async tryReadRegistry(): Promise<CodexAuthRegistry | null> {
    try {
      return await this.readRegistry();
    } catch (error) {
      this.logger?.warn(
        {
          registryFile: this.registryFile,
          error: error instanceof Error ? error.message : String(error)
        },
        "读取 codex-auth registry 失败"
      );
      return null;
    }
  }
}
