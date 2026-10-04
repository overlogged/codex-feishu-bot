import { normalizeProvider } from "./provider-catalog.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export type ClaudeProviderCommand = { action: "list" } | { action: "switch"; query: string };
export interface ClaudeProvider { id: string; name: string; current: boolean }
export type ProviderRunner = (command: string, args: string[]) => Promise<string>;

export function parseClaudeProviderCommand(text: string): ClaudeProviderCommand | undefined {
  const input = text.trim();
  if (/^(?:(?:claude|cc\s*switch)\s*)?(?:providers?|供应商)(?:\s*(?:列表|有哪些))?$/i.test(input) ||
      /^(?:列出|查看)\s*(?:claude\s*)?(?:providers?|供应商)$/i.test(input)) return { action: "list" };
  const match = input.match(/^(?:切换|切|switch)\s*(?:claude\s*)?(?:provider|供应商)\s+(.+)$/i);
  if (match) return { action: "switch", query: match[1]!.trim() };
  return undefined;
}

// CC Switch currently exposes a table, not JSON. Select only ID/name/current;
// never forward endpoint URLs, credentials or raw CLI error output to chats.
export function parseClaudeProviders(output: string): ClaudeProvider[] {
  const rows: ClaudeProvider[] = [];
  for (const line of output.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
    if (!line.trim().startsWith("│")) continue;
    const cells = line.split(/[│┆]/).slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 4 || cells[1] === "ID" || !cells[1]) continue;
    rows.push({ id: cells[1]!, name: cells[2]!, current: cells[0] === "✓" });
  }
  if (!rows.length) throw new Error("无法读取 Claude provider 列表，请检查 CC Switch 配置或版本。");
  return rows;
}

export class ClaudeProviderService {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly command: string,
    private readonly runner: ProviderRunner = async (command, args) => {
      const { stdout } = await execFileAsync(command, args, {
        timeout: 30_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, NO_COLOR: "1" }
      });
      return stdout;
    }
  ) {}

  async execute(command: ClaudeProviderCommand): Promise<string> {
    const result = this.queue.then(() => this.perform(command));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async perform(command: ClaudeProviderCommand): Promise<string> {
    try {
      const providers = parseClaudeProviders(await this.runner(this.command, ["-a", "claude", "provider", "list"]));
      if (command.action === "list") {
        return ["Claude providers（CC Switch）", ...providers.map((p) => `${p.current ? "✓ " : ""}${p.id} — ${p.name}`),
          "", "切换：@机器人 切换 claude provider <ID>",
          "切换影响本机所有使用全局配置的 Claude 会话，从后续任务生效。"].join("\n");
      }
      const query = normalizeProvider("claude", command.query)!;
      const matches = providers.filter((p) => p.id === query || p.name.toLowerCase() === query.toLowerCase());
      const provider = providers.find((p) => p.id === query) ?? (matches.length === 1 ? matches[0] : undefined);
      if (!provider || provider.id.startsWith("-")) return "未找到唯一匹配的 Claude provider，请发送“provider”查看列表，并使用完整 ID 切换。";
      await this.runner(this.command, ["-a", "claude", "provider", "switch", provider.id]);
      const after = parseClaudeProviders(await this.runner(this.command, ["-a", "claude", "provider", "list"]));
      if (!after.some((p) => p.id === provider.id && p.current)) return "切换后未能确认当前 provider，请发送“provider”检查。";
      return `Claude provider 已切换为 ${provider.name}（${provider.id}）。\n这是本机全局配置，后续 Claude 任务生效；正在执行的任务继续使用原配置。`;
    } catch {
      return "CC Switch 操作失败，请检查命令路径和本机供应商配置；为保护密钥，不转发 CLI 原始输出。";
    }
  }
}
