import assert from "node:assert/strict";
import test from "node:test";

import { buildDockerExecutionRunArgs } from "./docker-runtime.js";

test("buildDockerExecutionRunArgs only attaches stdin when interactive is enabled", () => {
  const env = {
    DOCKER_EXECUTION_IMAGE: "codex-feishu-bot:test",
    DOCKER_EXECUTION_BUILD_TARGET: "runtime",
    DOCKER_EXECUTION_GPU: "off",
    DOCKER_EXECUTION_MEMORY: "4g",
    DOCKER_EXECUTION_MOUNT_ROOT: "/home/overlogged",
    DOCKER_EXECUTION_MOUNTS: ""
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

test("buildDockerExecutionRunArgs uses full home mount with readonly QuantFS overlays", () => {
  const env = {
    DOCKER_EXECUTION_IMAGE: "codex-feishu-bot:test",
    DOCKER_EXECUTION_BUILD_TARGET: "quantdev-runtime",
    DOCKER_EXECUTION_GPU: "off",
    DOCKER_EXECUTION_MEMORY: "4g",
    DOCKER_EXECUTION_MOUNT_ROOT: "/home",
    DOCKER_EXECUTION_MOUNTS:
      "/home:/home:rw,/home/overlogged/QuantFS/common_data:/home/overlogged/QuantFS/common_data:ro,/home/overlogged/QuantFS/prod:/home/overlogged/QuantFS/prod:ro"
  };

  const args = buildDockerExecutionRunArgs(env as never, {
    remove: true,
    command: ["echo", "ok"]
  });

  const homeMount = args.indexOf("/home:/home:rw");
  const commonDataMount = args.indexOf(
    "/home/overlogged/QuantFS/common_data:/home/overlogged/QuantFS/common_data:ro"
  );
  const prodMount = args.indexOf("/home/overlogged/QuantFS/prod:/home/overlogged/QuantFS/prod:ro");

  assert.ok(homeMount > -1);
  assert.ok(commonDataMount > homeMount);
  assert.ok(prodMount > homeMount);
});

test("buildDockerExecutionRunArgs can disable gpu wiring", () => {
  const env = {
    DOCKER_EXECUTION_IMAGE: "codex-feishu-bot:test",
    DOCKER_EXECUTION_BUILD_TARGET: "runtime",
    DOCKER_EXECUTION_GPU: "off",
    DOCKER_EXECUTION_MEMORY: "4g",
    DOCKER_EXECUTION_MOUNT_ROOT: "/home",
    DOCKER_EXECUTION_MOUNTS: ""
  };

  const args = buildDockerExecutionRunArgs(env as never, {
    remove: true,
    command: ["echo", "ok"]
  });

  assert.equal(args.includes("--gpus"), false);
  assert.equal(args.includes("/dev/dxg"), false);
  assert.equal(args.includes("/usr/lib/wsl:/usr/lib/wsl:ro"), false);
});
