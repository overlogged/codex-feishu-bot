import { isAbsolute, resolve } from "node:path";

import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv({
  path: ".env"
});
loadDotenv({
  path: ".env.real",
  override: true
});

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
  CLAUDE_CLI_COMMAND: z.string().default("cl"),
  KIMI_ACP_COMMAND: z.string().default("kimi"),
  PI_CLI_COMMAND: z.string().default("pi"),
  PI_CLI_PROVIDER: optionalNonEmptyString.default("openrouter"),
  PI_CLI_MODEL: optionalNonEmptyString.default("deepseek-flash"),
  PI_CLI_THINKING: optionalNonEmptyString.default("xhigh"),
  LIVE_UPDATE_DEBOUNCE_MS: z.coerce.number().int().positive().default(1200),
  FEISHU_PROVIDER: z.enum(["sdk", "fake"]).default("sdk"),
  FEISHU_TRANSPORT: z.enum(["websocket", "webhook", "disabled"]).default("websocket"),
  FEISHU_DOMAIN: z.string().default("feishu"),
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
    CODEX_ARTIFACTS_DIR: resolveDir(defaultWorkspace, parsed.CODEX_ARTIFACTS_DIR),
    RUNTIME_STATE_FILE: resolveDir(defaultWorkspace, parsed.RUNTIME_STATE_FILE),
    FEISHU_BRIDGE_SCRIPT: resolveDir(process.cwd(), parsed.FEISHU_BRIDGE_SCRIPT)
  };
}
