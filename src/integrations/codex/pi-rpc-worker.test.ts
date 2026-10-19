import assert from "node:assert/strict";
import type { ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";
import test from "node:test";

import type { Env } from "../../config/env.js";
import type { CodexEvent } from "../../domain/types.js";
import {
  buildPiRpcArgs,
  PiRpcWorker,
  selectPiModelFromMessage,
  type PiRpcRuntime
} from "./pi-rpc-worker.js";

test("Pi aliases resolve Flash and Pro separately on OpenCode Go", () => {
  for (const text of ["用 DeepSeek V4.1 Flash 快速回答", "切到 ds4.1 flash", "pi ds4 flash", "dsf4.1", "连 deepseek"]) {
    assert.deepEqual(selectPiModelFromMessage(text), { model: "deepseek-v4.1-flash" });
  }
  for (const text of ["用 DeepSeek V4 Pro 写代码", "deepseek-v4-pro", "切到 ds4 pro"]) {
    assert.deepEqual(selectPiModelFromMessage(text), { model: "deepseek-v4-pro" });
  }
  assert.deepEqual(selectPiModelFromMessage("用 GLM 5.3 Flash 写代码"), { model: "glm-5.3-flash" });
  assert.deepEqual(selectPiModelFromMessage("你好"), {});
  assert.deepEqual(selectPiModelFromMessage("openmodel"), {});
});

function buildContext(text = "帮我看一下") {
  return {
    cli: "pi" as const,
    workspaceId: "/tmp",
    message: {
      chatId: "oc_group_1", chatType: "group", messageId: "om_1", senderId: "ou_1",
      senderName: "user", senderType: "user", text, mentionsBot: false, raw: {}
    }
  };
}

const piDefaults = { PI_CLI_PROVIDER: "opencode-go", PI_CLI_MODEL: "deepseek-v4.1-flash", PI_CLI_THINKING: "high" };
const argValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test("Pi RPC starts with OpenCode Go Flash defaults and a persisted session", () => {
  const args = buildPiRpcArgs(piDefaults, buildContext(), "/tmp/pi-session.jsonl");
  assert.deepEqual(args.slice(0, 5), ["--mode", "rpc", "--session", "/tmp/pi-session.jsonl", "--approve"]);
  assert.equal(argValue(args, "--provider"), "opencode-go");
  assert.equal(argValue(args, "--model"), "deepseek-v4.1-flash");
  assert.equal(argValue(args, "--thinking"), "high");
});

test("Pi catalog defaults override retired environment providers", () => {
  const args = buildPiRpcArgs({ PI_CLI_PROVIDER: "openrouter", PI_CLI_MODEL: "deepseek-flash", PI_CLI_THINKING: "xhigh" }, buildContext(), "/tmp/pi-session.jsonl");
  assert.equal(argValue(args, "--provider"), "opencode-go");
  assert.equal(argValue(args, "--model"), "deepseek-v4.1-flash");
  assert.equal(argValue(args, "--thinking"), "high");
});

test("Pi permits model selection from ordinary messages while staying on OpenCode Go", () => {
  const args = buildPiRpcArgs(piDefaults, buildContext("用 GLM 5.3 Flash 写代码"), "/tmp/pi-session.jsonl");
  assert.equal(argValue(args, "--provider"), "opencode-go");
  assert.equal(argValue(args, "--model"), "glm-5.3-flash");
});

test("Pi fixed control model wins over model names embedded in the control prompt", () => {
  const args = buildPiRpcArgs(piDefaults, {
    ...buildContext("所有模型：GLM 5.3 Flash、DeepSeek V4 Pro、Kimi K3。用户要求切换到 GLM。"),
    provider: "opencode-go", model: "deepseek-v4.1-flash", thinking: "high"
  }, "/tmp/pi-control.jsonl");
  assert.equal(argValue(args, "--provider"), "opencode-go");
  assert.equal(argValue(args, "--model"), "deepseek-v4.1-flash");
  assert.equal(argValue(args, "--thinking"), "high");
});

test("Pi accepts the legacy Flash alias but rejects retired provider bindings", () => {
  const args = buildPiRpcArgs(piDefaults, { ...buildContext(), model: "deepseek-flash" }, "/tmp/pi-session.jsonl");
  assert.equal(argValue(args, "--model"), "deepseek-v4.1-flash");
  for (const provider of ["openmodel", "deepseek", "openrouter", "qwen38"]) {
    assert.throws(() => buildPiRpcArgs(piDefaults, { ...buildContext(), provider }, "/tmp/pi-session.jsonl"), /Pi 未启用供应商/);
  }
});

interface FakePiRpcSpawnOptions {
  holdPromptUntilAbort?: boolean;
  errorMessage?: string;
  /** First prompt returns only thinking; later prompts return text. */
  thinkingOnlyFirstPrompt?: boolean;
  /** Every prompt returns only thinking, never text. */
  thinkingOnly?: boolean;
  /** First prompt fails with a transient connection error; later prompts return text. */
  transientErrorFirstPrompt?: boolean;
}

function createFakePiRpcSpawn(options: FakePiRpcSpawnOptions = {}): {
  runtime: PiRpcRuntime;
  commands: Record<string, unknown>[];
  spawnCount: () => number;
} {
  const commands: Record<string, unknown>[] = [];
  let spawnCount = 0;
  const runtime: PiRpcRuntime = {
    spawnProcess() {
      spawnCount += 1;
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = new EventEmitter() as ChildProcessByStdio<Writable, Readable, Readable>;
      Object.assign(child, {
        stdin,
        stdout,
        stderr,
        killed: false,
        exitCode: null,
        kill() {
          (child as { killed: boolean }).killed = true;
          child.emit("close", 0, null);
          return true;
        }
      });

      const write = (message: Record<string, unknown>) => {
        stdout.write(`${JSON.stringify(message)}\n`);
      };

      let buffer = "";
      let promptCount = 0;
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf("\n");
          if (!line) {
            continue;
          }

          const message = JSON.parse(line) as Record<string, unknown>;
          commands.push(message);
          const id = message.id;

          if (message.type === "get_state") {
            write({
              id,
              type: "response",
              command: "get_state",
              success: true,
              data: { sessionFile: "/tmp/pi-session.jsonl" }
            });
            continue;
          }

          if (message.type === "prompt") {
            write({ id, type: "response", command: "prompt", success: true });
            if (options.errorMessage) {
              setImmediate(() => {
                write({
                  type: "message_end",
                  message: {
                    role: "assistant",
                    content: [],
                    provider: "openmodel",
                    model: "deepseek-flash",
                    stopReason: "error",
                    errorMessage: options.errorMessage
                  }
                });
                write({ type: "agent_settled" });
              });
              continue;
            }
            promptCount += 1;
            if (options.transientErrorFirstPrompt && promptCount === 1) {
              setImmediate(() => {
                write({
                  type: "message_end",
                  message: {
                    role: "assistant",
                    content: [],
                    provider: "openmodel",
                    model: "deepseek-v4.1-flash",
                    stopReason: "error",
                    errorMessage: "Connection error."
                  }
                });
                write({ type: "agent_settled" });
              });
              continue;
            }
            if (!options.holdPromptUntilAbort) {
              const returnThinkingOnly =
                options.thinkingOnly === true ||
                (options.thinkingOnlyFirstPrompt === true && promptCount === 1);
              setImmediate(() => {
                write({
                  type: "message_update",
                  assistantMessageEvent: { type: "thinking_delta", delta: "先检查上下文。" }
                });
                if (!returnThinkingOnly) {
                  write({
                    type: "message_update",
                    assistantMessageEvent: { type: "text_delta", delta: "OK" }
                  });
                }
                write({ type: "agent_settled" });
              });
            }
            continue;
          }

          if (message.type === "steer") {
            write({ id, type: "response", command: "steer", success: true });
            continue;
          }

          if (message.type === "abort") {
            write({ id, type: "response", command: "abort", success: true });
            write({ type: "agent_settled" });
            continue;
          }
        }
      });

      return {
        child,
        async stop() {
          (child as { killed: boolean }).killed = true;
          child.emit("close", 0, null);
        }
      };
    }
  };

  return { runtime, commands, spawnCount: () => spawnCount };
}

function buildWorkerEnv(): Env {
  return {
    PI_CLI_COMMAND: "pi",
    PI_CLI_PROVIDER: "deepseek",
    PI_CLI_MODEL: "deepseek-flash",
    PI_CLI_THINKING: "xhigh"
  } as Env;
}

async function collectEvents(worker: PiRpcWorker, threadId: string): Promise<CodexEvent[]> {
  const events: CodexEvent[] = [];
  for await (const event of worker.runTurn({ ...buildContext(), threadId })) {
    events.push(event);
  }
  return events;
}

test("PiRpcWorker runs a turn over RPC and streams thinking plus final answer", async () => {
  const { runtime, commands } = createFakePiRpcSpawn();
  const worker = new PiRpcWorker(buildWorkerEnv(), undefined, runtime);
  const threadId = await worker.ensureThread(buildContext());

  const events = await collectEvents(worker, threadId);

  assert.deepEqual(
    events.map((event) => event.kind),
    [
      "turn_bound",
      "run_status",
      "thread_bound",
      "assistant_message_started",
      "assistant_message_delta",
      "assistant_message_started",
      "assistant_message_delta",
      "assistant_message_completed",
      "assistant_message_completed"
    ]
  );
  const threadBound = events.find((event) => event.kind === "thread_bound");
  assert.equal(threadBound?.kind === "thread_bound" && threadBound.threadId, threadId);
  assert.ok(
    events.some(
      (event) =>
        event.kind === "assistant_message_delta" &&
        event.text === "先检查上下文。" &&
        event.itemId.includes(":commentary")
    )
  );
  assert.ok(
    events.some(
      (event) =>
        event.kind === "assistant_message_completed" &&
        event.text === "OK" &&
        event.itemId.includes(":final")
    )
  );
  assert.ok(commands.some((command) => command.type === "prompt"));
  assert.ok(commands.some((command) => command.type === "get_state"));

  await worker.close();
});

test("PiRpcWorker surfaces the underlying provider error instead of an empty reply", async () => {
  const { runtime } = createFakePiRpcSpawn({
    errorMessage: '404 {"error":{"message":"no channel available for model deepseek-flash"}}'
  });
  const worker = new PiRpcWorker(buildWorkerEnv(), undefined, runtime);
  const threadId = await worker.ensureThread(buildContext());

  const events = await collectEvents(worker, threadId);

  const errorEvent = events.find((event) => event.kind === "error");
  assert.ok(errorEvent, "an error event should be emitted");
  assert.match(
    errorEvent.kind === "error" ? errorEvent.message : "",
    /no channel available for model deepseek-flash/
  );
  assert.ok(
    !events.some(
      (event) => event.kind === "error" && event.message === "Pi RPC 没有返回可见内容。"
    )
  );

  await worker.close();
});

test("PiRpcWorker retries once when a turn returns thinking but no final answer", async () => {
  const { runtime, commands } = createFakePiRpcSpawn({ thinkingOnlyFirstPrompt: true });
  const worker = new PiRpcWorker(buildWorkerEnv(), undefined, runtime);
  const threadId = await worker.ensureThread(buildContext());

  const events = await collectEvents(worker, threadId);

  const promptCommands = commands.filter((command) => command.type === "prompt");
  assert.equal(promptCommands.length, 2);
  assert.match(
    String(promptCommands[1]?.message ?? ""),
    /最终答复/
  );
  assert.ok(
    events.some(
      (event) =>
        event.kind === "assistant_message_completed" &&
        event.text === "OK" &&
        event.itemId.includes(":final")
    )
  );
  assert.ok(!events.some((event) => event.kind === "error"));

  await worker.close();
});

test("PiRpcWorker promotes thinking to the final answer when no text is ever produced", async () => {
  const { runtime, commands } = createFakePiRpcSpawn({ thinkingOnly: true });
  const worker = new PiRpcWorker(buildWorkerEnv(), undefined, runtime);
  const threadId = await worker.ensureThread(buildContext());

  const events = await collectEvents(worker, threadId);

  assert.equal(commands.filter((command) => command.type === "prompt").length, 2);
  const final = events.find(
    (event) => event.kind === "assistant_message_completed" && event.itemId.includes(":final")
  );
  assert.ok(final, "thinking-only turns should still produce a final answer");
  assert.match(final.kind === "assistant_message_completed" ? final.text : "", /先检查上下文。/);
  assert.ok(!events.some((event) => event.kind === "error"));

  await worker.close();
});

test("PiRpcWorker retries automatically after a transient connection error", async () => {
  const { runtime, commands } = createFakePiRpcSpawn({ transientErrorFirstPrompt: true });
  const worker = new PiRpcWorker(buildWorkerEnv(), undefined, runtime);
  const threadId = await worker.ensureThread(buildContext());

  const events = await collectEvents(worker, threadId);

  assert.equal(commands.filter((command) => command.type === "prompt").length, 2);
  assert.ok(
    events.some(
      (event) =>
        event.kind === "assistant_message_completed" &&
        event.text === "OK" &&
        event.itemId.includes(":final")
    )
  );
  assert.ok(!events.some((event) => event.kind === "error"));

  await worker.close();
});

test("PiRpcWorker reuses one RPC process across turns with the same settings", async () => {
  const { runtime, spawnCount } = createFakePiRpcSpawn();
  const worker = new PiRpcWorker(buildWorkerEnv(), undefined, runtime);
  const threadId = await worker.ensureThread(buildContext());

  await collectEvents(worker, threadId);
  await collectEvents(worker, threadId);

  assert.equal(spawnCount(), 1);
  await worker.close();
});

test("PiRpcWorker opts out of steer so the orchestrator interrupts and reruns", async () => {
  const { runtime } = createFakePiRpcSpawn();
  const worker = new PiRpcWorker(buildWorkerEnv(), undefined, runtime);

  // Pi RPC 的 steer 会排在当前工具调用之后，长任务会长时间不回，所以这里不宣告 steer；
  // 编排器会改成 abort 当前 turn 然后用最新消息重跑。
  assert.equal(worker.supportsSteer(), false);

  await worker.close();
});

test("PiRpcWorker interrupt aborts the in-flight prompt without an error event", async () => {
  const { runtime, commands } = createFakePiRpcSpawn({ holdPromptUntilAbort: true });
  const worker = new PiRpcWorker(buildWorkerEnv(), undefined, runtime);
  const threadId = await worker.ensureThread(buildContext());

  const eventsPromise = collectEvents(worker, threadId);

  let turnId: string | undefined;
  const activeTurns = () =>
    (worker as unknown as { activeTurns: Map<string, unknown> }).activeTurns;
  for (let attempt = 0; attempt < 100 && !turnId; attempt += 1) {
    turnId = Array.from(activeTurns().keys())[0];
    if (!turnId) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.ok(turnId, "active turn should be registered");

  await worker.interruptTurn({
    ...buildContext(),
    threadId,
    turnId,
    interruptionMessage: "当前任务已被后续消息中断。"
  });

  const events = await eventsPromise;
  assert.ok(commands.some((command) => command.type === "abort"));
  assert.ok(!events.some((event) => event.kind === "error"));

  await worker.close();
});

test("PiRpcWorker restarts the RPC process when the model changes", async () => {
  const { runtime, spawnCount } = createFakePiRpcSpawn();
  const worker = new PiRpcWorker(buildWorkerEnv(), undefined, runtime);
  const threadId = await worker.ensureThread(buildContext());

  await collectEvents(worker, threadId);
  const glmContext = { ...buildContext("用 glm flash 回答"), threadId };
  const events: CodexEvent[] = [];
  for await (const event of worker.runTurn(glmContext)) {
    events.push(event);
  }

  assert.equal(spawnCount(), 2);
  await worker.close();
});
