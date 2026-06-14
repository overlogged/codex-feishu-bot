import assert from "node:assert/strict";
import test from "node:test";

import type { Env } from "../../config/env.js";
import { buildDockerKimiExecArgs } from "./docker-kimi-cli-worker.js";

test("buildDockerKimiExecArgs uses a shell-valid wrapper that preserves stdin", () => {
  const { dockerArgs, pidFile } = buildDockerKimiExecArgs(
    {
      DOCKER_EXECUTION_CONTAINER_NAME: "codex-feishu-bot-quantdev-session-pool",
      KIMI_CLI_COMMAND: "kimi"
    } as Env,
    {
      turnId: "turn_1",
      context: {
        workspaceId: "/home/overlogged/QuantDev"
      },
      args: ["--wire", "--yolo"]
    }
  );

  const scriptIndex = dockerArgs.indexOf("-lc") + 1;
  assert.notEqual(scriptIndex, 0);
  const script = dockerArgs[scriptIndex] ?? "";
  assert.equal(dockerArgs.includes("-i"), true);
  assert.equal(dockerArgs.includes("/home/overlogged/QuantDev"), true);
  assert.equal(dockerArgs.includes("codex-feishu-bot-quantdev-session-pool"), true);
  assert.equal(dockerArgs.includes("kimi"), true);
  assert.ok(pidFile.startsWith("/tmp/codex-feishu-bot-kimi-turn_1.pid"));
  assert.ok(script.includes('echo "$$" > "$pidfile"'));
  assert.ok(script.includes('exec "$@"'));
  assert.equal(script.includes("&;"), false);
});
