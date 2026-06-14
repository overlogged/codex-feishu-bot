import assert from "node:assert/strict";
import test from "node:test";

import type { Env } from "../../config/env.js";
import { buildDockerPiExecArgs } from "./docker-pi-cli-worker.js";

test("buildDockerPiExecArgs runs pi inside the persistent docker execution pool", () => {
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  process.env.PI_CLI_MODEL = "deepseek-v4-pro";
  try {
    const { dockerArgs, pidFile } = buildDockerPiExecArgs(
      {
        DOCKER_EXECUTION_CONTAINER_NAME: "codex-feishu-bot-quantdev-session-pool",
        PI_CLI_COMMAND: "pi"
      } as Env,
      {
        turnId: "turn_1",
        context: {
          workspaceId: "/home/overlogged/QuantDev"
        },
        args: [
          "-p",
          "--mode",
          "json",
          "--session",
          "/home/overlogged/.pi/agent/sessions/codex-feishu-bot/oc_group_1/session.jsonl",
          "--model",
          "deepseek-v4-pro",
          "hello"
        ]
      }
    );

    const scriptIndex = dockerArgs.indexOf("-lc") + 1;
    assert.notEqual(scriptIndex, 0);
    const script = dockerArgs[scriptIndex] ?? "";
    assert.equal(dockerArgs.includes("-i"), true);
    assert.equal(dockerArgs.includes("/home/overlogged/QuantDev"), true);
    assert.equal(dockerArgs.includes("codex-feishu-bot-quantdev-session-pool"), true);
    assert.equal(dockerArgs.includes("pi"), true);
    assert.equal(dockerArgs.includes("OPENROUTER_API_KEY=test-openrouter-key"), false);
    assert.equal(dockerArgs.includes("PI_CLI_MODEL=deepseek-v4-pro"), true);
    assert.ok(pidFile.startsWith("/tmp/codex-feishu-bot-pi-turn_1.pid"));
    assert.ok(script.includes('echo "$$" > "$pidfile"'));
    assert.ok(script.includes('exec "$@"'));
    assert.equal(script.includes("&;"), false);
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.PI_CLI_MODEL;
  }
});
