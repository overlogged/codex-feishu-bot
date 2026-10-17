import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { config as loadDotenv } from "dotenv";
import { z } from "zod";

import { clearProxyEnv } from "./proxy-env.js";

loadDotenv({
  path: ".env"
});
loadDotenv({
  path: ".env.real",
  override: true
});

// The bot and its non-Codex children always use direct connections.
clearProxyEnv(process.env);

const envBoolean = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (value === undefined) {
      return defaultValue;
    }

    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "number") {
      return value !== 0;
    }

    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();

      if (["1", "true", "yes", "on"].includes(normalized)) {
        return true;
      }

      if (["0", "false", "no", "off", ""].includes(normalized)) {
        return false;
      }
    }

    return value;
  }, z.boolean());

const optionalNonEmptyString = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }

  return value;
}, z.string().optional());

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  CODEX_MODE: z.enum(["mock", "app-server"]).default("mock"),
  CODEX_APP_SERVER_COMMAND: z.string().default("codex"),
  CODEX_APP_SERVER_ARGS: z.string().default("app-server"),
  CODEX_APP_SERVER_LISTEN_URL: z.string().url().default("ws://127.0.0.1:4500"),
  CODEX_APP_SERVER_WS_TOKEN_FILE: optionalNonEmptyString,
  CODEX_APP_SERVER_MANAGED: envBoolean(false),
  CODEX_APP_SERVER_MODEL: z.string().default("gpt-6-astra"),
  CODEX_APP_SERVER_MODEL_REASONING_EFFORT: z
    .enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
    .default("high"),
  CODEX_APP_SERVER_APPROVAL_POLICY: z
    .enum(["untrusted", "on-failure", "on-request", "never"])
    .default("never"),
  CODEX_APP_SERVER_SANDBOX: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("danger-full-access"),
  DEFAULT_WORKSPACE: z.string().default("/home/overlogged"),
  CHAT_WORKSPACE_BINDINGS_FILE: z.string().default(".codex-feishu-bot/chat-workspaces.json"),
  CODEX_ARTIFACTS_DIR: z.string().default(".codex-feishu-bot/artifacts"),
  RUNTIME_STATE_FILE: z.string().default(".codex-feishu-bot/runtime-state.json"),
  FEISHU_BRIDGE_SCRIPT: z.string().default("scripts/feishu-bridge.mjs"),
  CLAUDE_CLI_COMMAND: z.string().default("claude"),
  CLAUDE_PROXY_URL: optionalNonEmptyString,
  CC_SWITCH_COMMAND: z.string().default("cc-switch"),
  KIMI_ACP_COMMAND: z.string().default("kimi"),
  DEVIN_USAGE_DATABASE: z.string().default(join(homedir(), ".local/share/devin/cli/sessions.db")),
  DEVIN_ACP_COMMAND: z.string().default("devin"),
  DEVIN_ACP_MODEL: optionalNonEmptyString,
  DEVIN_PROXY_URL: optionalNonEmptyString,
  DSH_ACP_COMMAND: z.string().default("dsh"),
  DSH_ACP_PROFILE: z.string().default("acp"),
  /** dsh ACP 会话的 reasoning_effort；留空则不设置（模型不会输出思考过程）。 */
  DSH_ACP_REASONING: z.string().default("high"),
  /** MiniMax Code CLI；ACP 子命令让 mcode 以 ACP v1 stdio 提供服务。 */
  MCODE_ACP_COMMAND: z.string().default("mcode"),
  /** 传给 mcode ACP 的参数；`mcode acp` 让 MiniMax Code 以 ACP v1 stdio 提供服务。 */
  MCODE_ACP_ARGS: z.string().transform((value) => value.split(" ").filter(Boolean)).default("acp"),
  /** mcode ACP 会话的思考档位；留空则不设置（模型不会输出思考过程）。 */
  MCODE_ACP_REASONING: optionalNonEmptyString.default("high"),
  /** mcode ACP 会话的权限模式，对应 `permissionMode` 配置项。 */
  MCODE_ACP_PERMISSION_MODE: optionalNonEmptyString.default("bypassPermissions"),
  PI_CLI_COMMAND: z.string().default("pi"),
  PI_CLI_PROVIDER: optionalNonEmptyString.default("openrouter"),
  PI_CLI_MODEL: optionalNonEmptyString.default("deepseek-flash"),
  PI_CLI_THINKING: optionalNonEmptyString.default("xhigh"),
  LIVE_UPDATE_DEBOUNCE_MS: z.coerce.number().int().positive().default(1200),
  CCUSAGE_COMMAND: z.string().default("ccusage"),
  /** codex-auth 多账号 CLI 命令。 */
  CODEX_AUTH_COMMAND: z.string().default("codex-auth"),
  /** codex-auth 的账号 registry，用于渲染账号列表与确认切换结果。 */
  CODEX_AUTH_REGISTRY_FILE: z
    .string()
    .default(join(homedir(), ".codex", "accounts", "registry.json")),
  USAGE_CCUSAGE_CACHE_MS: z.coerce.number().int().positive().default(300000),
  USAGE_USD_TO_CNY_RATE: z.coerce.number().positive().default(7.2),
  USAGE_SNAPSHOT_FILE: z.string().default(".codex-feishu-bot/usage-snapshots.json"),
  USAGE_SNAPSHOT_INTERVAL_MS: z.coerce.number().int().positive().default(600000),
  /** 每日 token 消耗日报默认发送时间（HH:mm，本地时区）。 */
  TOKEN_DAILY_REPORT_TIME: z.string().default("23:00"),
  KIMI_CODE_CREDENTIALS_FILE: z
    .string()
    .default(join(homedir(), ".kimi-code", "credentials", "kimi-code.json")),
  FEISHU_PROVIDER: z.enum(["sdk", "fake"]).default("sdk"),
  FEISHU_TRANSPORT: z.enum(["websocket", "webhook", "disabled"]).default("websocket"),
  FEISHU_DOMAIN: z.string().default("feishu"),
  /** 飞书长连接看门狗：断开超过 FEISHU_WS_WATCHDOG_STALE_MS 时强制重建 WS 客户端。 */
  FEISHU_WS_WATCHDOG_ENABLED: envBoolean(true),
  FEISHU_WS_WATCHDOG_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  FEISHU_WS_WATCHDOG_STALE_MS: z.coerce.number().int().positive().default(180_000),
  /**
   * 飞书长连接看门狗：连接仍报告 OPEN 但连续这么久收不到任何帧时判定为半开并重建。
   * TCP 半开时 readyState 一直是 OPEN，只看它发现不了故障，而长连接不补发事件，
   * 消息会静默丢失，所以需要一条独立的静默阈值。
   */
  FEISHU_WS_WATCHDOG_SILENT_MS: z.coerce.number().int().positive().default(600_000),
  /** 长连接用的代理；留空则回退到 HTTPS_PROXY / HTTP_PROXY。 */
  FEISHU_WS_PROXY_URL: optionalNonEmptyString,
  /** 置 true 则长连接强制直连（忽略代理环境变量）。 */
  FEISHU_WS_PROXY_DISABLED: envBoolean(false),
  HTTP_PROXY: optionalNonEmptyString,
  HTTPS_PROXY: optionalNonEmptyString,
  FEISHU_APP_ID: z.string().optional(),
  FEISHU_APP_SECRET: z.string().optional(),
  FEISHU_VERIFICATION_TOKEN: z.string().optional(),
  FAKE_FEISHU_BASE_URL: z.string().url().default("http://127.0.0.1:3400"),
  FAKE_FEISHU_WS_URL: z.string().url().default("ws://127.0.0.1:3400/ws")
});

export type Env = z.infer<typeof envSchema>;

function resolveDir(baseDir: string, dir: string): string {
  return isAbsolute(dir) ? dir : resolve(baseDir, dir);
}

export function readEnv(): Env {
  const parsed = envSchema.parse(process.env);
  const defaultWorkspace = resolveDir(process.cwd(), parsed.DEFAULT_WORKSPACE);

  return {
    ...parsed,
    DEFAULT_WORKSPACE: defaultWorkspace,
    CODEX_APP_SERVER_WS_TOKEN_FILE: parsed.CODEX_APP_SERVER_WS_TOKEN_FILE
      ? resolveDir(process.cwd(), parsed.CODEX_APP_SERVER_WS_TOKEN_FILE)
      : undefined,
    CHAT_WORKSPACE_BINDINGS_FILE: resolveDir(defaultWorkspace, parsed.CHAT_WORKSPACE_BINDINGS_FILE),
    USAGE_SNAPSHOT_FILE: resolveDir(defaultWorkspace, parsed.USAGE_SNAPSHOT_FILE),
    CODEX_ARTIFACTS_DIR: resolveDir(defaultWorkspace, parsed.CODEX_ARTIFACTS_DIR),
    RUNTIME_STATE_FILE: resolveDir(defaultWorkspace, parsed.RUNTIME_STATE_FILE),
    FEISHU_BRIDGE_SCRIPT: resolveDir(process.cwd(), parsed.FEISHU_BRIDGE_SCRIPT),
    KIMI_CODE_CREDENTIALS_FILE: resolveDir(process.cwd(), parsed.KIMI_CODE_CREDENTIALS_FILE),
    CODEX_AUTH_REGISTRY_FILE: resolveDir(process.cwd(), parsed.CODEX_AUTH_REGISTRY_FILE)
  };
}
