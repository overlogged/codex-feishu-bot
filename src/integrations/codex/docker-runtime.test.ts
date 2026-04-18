import assert from "node:assert/strict";
import test from "node:test";

import { buildDockerExecutionRunArgs } from "./docker-runtime.js";

test("buildDockerExecutionRunArgs only attaches stdin when interactive is enabled", () => {
  const env = {
    DOCKER_EXECUTION_IMAGE: "codex-feishu-bot:test",
    DOCKER_EXECUTION_MEMORY: "4g",
    DOCKER_EXECUTION_MOUNT_ROOT: "/home/overlogged"
  };

  const nonInteractiveArgs = buildDockerExecutionRunArgs(env as never, {
    remove: true,
    command: ["echo", "ok"]
  });
  assert.equal(nonInteractiveArgs.includes("-i"), false);

  const interactiveArgs = buildDockerExecutionRunArgs(env as never, {
    interactive: true,
    remove: true,
    command: ["echo", "ok"]
  });
  assert.equal(interactiveArgs.includes("-i"), true);
});
