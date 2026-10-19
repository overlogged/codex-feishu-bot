import assert from "node:assert/strict";
import type { ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";
import test from "node:test";

import type { CodexEvent, IncomingChatMessage } from "../../domain/types.js";
import { DshAcpWorker, dshProcessEnv } from "./dsh-acp-worker.js";
import type { KimiAcpRuntime } from "./kimi-acp-worker.js";
import type { CodexTurnContext } from "./codex-worker.js";

const modelValue = (provider: string, model: string) => JSON.stringify([provider, model]);
function advertisedOptions(selected = modelValue("openmodel", "deepseek-v4.1-flash")): unknown[] {
  return [
    { id: "model", category: "model", currentValue: selected, options: [
      { group: "deepseek-account", options: [
        { value: modelValue("deepseek-account", "deepseek-flash"), name: "DeepSeek-V4.1-Flash" },
        { value: modelValue("deepseek-account", "deepseek-v4-pro"), name: "DeepSeek-V4-Pro" }
      ] },
      { group: "openmodel", options: [
        { value: modelValue("openmodel", "deepseek-v4.1-flash"), name: "DeepSeek-V4.1-Flash" }
      ] },
      { group: "opencode-go", options: [
        { value: modelValue("opencode-go", "deepseek-v4.1-flash"), name: "DeepSeek V4.1 Flash" },
        { value: modelValue("opencode-go", "deepseek-v4-pro"), name: "DeepSeek V4 Pro" },
        { value: modelValue("opencode-go", "kimi-k3"), name: "Kimi K3" },
        { value: modelValue("opencode-go", "no-reasoning"), name: "No reasoning" }
      ] }
    ] },
    ...(selected.includes("no-reasoning") ? [] : [
      { id: "reasoning_effort", category: "thought_level", currentValue: "", options: [
        { value: "high", name: "High" }, { value: "off", name: "Off" }
      ] }
    ])
  ];
}

function createFakeDshRuntime(
  fakeOptions: {
    thinkingOnlyFirstPrompt?: boolean;
    thinkingOnly?: boolean;
    /** 让第 N 次 prompt 挂起不返回，用于模拟「任务仍在运行中」。1-based。 */
    holdPromptNumber?: number;
  } = {}
): {
  runtime: KimiAcpRuntime;
  spawnOptions: Array<{ args: string[]; cwd: string }>;
  configOptions: Array<Record<string, unknown>>;
  promptTexts: string[];
  releaseHeldPrompt: () => void;
} {
  const spawnOptions: Array<{ args: string[]; cwd: string }> = [];
  const configOptions: Array<Record<string, unknown>> = [];
  const promptTexts: string[] = [];
  let promptCount = 0;
  let releaseHeldPrompt: (() => void) | undefined;
  const runtime: KimiAcpRuntime = {
    spawnProcess(options) {
      spawnOptions.push({ args: options.args, cwd: options.context.workspaceId });
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
      let selected = modelValue("openmodel", "deepseek-v4.1-flash");
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

          const message = JSON.parse(line) as { id?: number; method?: string };
          if (message.method === "initialize" && message.id !== undefined) {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
            continue;
          }

          if (message.method === "session/new" && message.id !== undefined) {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "dsh_session_1", configOptions: advertisedOptions(selected) } });
            continue;
          }

          if (message.method === "session/set_config_option" && message.id !== undefined) {
            configOptions.push(
              (message as { params?: Record<string, unknown> }).params ?? {}
            );
            const params = (message as { params?: { configId?: string; value?: string } }).params;
            if (params?.configId === "model" && params.value) selected = params.value;
            write({ jsonrpc: "2.0", id: message.id, result: { configOptions: advertisedOptions(selected) } });
            continue;
          }

          if (message.method === "session/prompt" && message.id !== undefined) {
            const id = message.id;
            const params = (message as { params?: { prompt?: Array<{ text?: string }> } }).params;
            promptTexts.push(params?.prompt?.[0]?.text ?? "");
            promptCount += 1;
            if (fakeOptions.holdPromptNumber === promptCount) {
              // 保持这一轮 in-flight，模拟任务仍在运行；测试放行后才继续应答。
              releaseHeldPrompt = () => {
                setImmediate(() => {
                  write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
                });
              };
              return;
            }
            setImmediate(() => {
              write({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: "dsh_session_1",
                  update: {
                    sessionUpdate: "agent_thought_chunk",
                    content: { type: "text", text: "先想一下。" }
                  }
                }
              });
              const thinkingOnly =
                fakeOptions.thinkingOnly === true ||
                (fakeOptions.thinkingOnlyFirstPrompt === true && promptCount === 1);
              if (!thinkingOnly) {
                write({
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    sessionId: "dsh_session_1",
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "OK" }
                    }
                  }
                });
              }
              write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
            });
            continue;
          }

          if (message.method === "session/cancel") {
            continue;
          }
        }
      });

      return {
        child,
        stop: async () => {
          (child as { killed: boolean }).killed = true;
          child.emit("close", 0, null);
        }
      };
    }
  };

  return {
    runtime,
    spawnOptions,
    configOptions,
    promptTexts,
    releaseHeldPrompt: () => {
      releaseHeldPrompt?.();
    }
  };
}

function buildMessage(): IncomingChatMessage {
  return {
    chatId: "oc_dsh_test",
    chatType: "group",
    messageId: "om_dsh_test",
    senderId: "ou_test",
    senderName: "tester",
    senderType: "user",
    text: "处理一下",
    mentionsBot: false,
    raw: {}
  };
}

async function collectEvents(worker: DshAcpWorker, threadId: string, settings: Partial<CodexTurnContext> = {}): Promise<CodexEvent[]> {
  const events: CodexEvent[] = [];
  for await (const event of worker.runTurn({
    cli: "dsh",
    workspaceId: "/tmp/dsh-workspace",
    message: buildMessage(),
    threadId,
    ...settings
  })) {
    events.push(event);
  }
  return events;
}

test("DshAcpWorker runs a turn over ACP and binds the new session", async () => {
  const { runtime, spawnOptions, configOptions } = createFakeDshRuntime();
  const worker = new DshAcpWorker(
    { DSH_ACP_COMMAND: "dsh", DSH_ACP_PROFILE: "acp", DSH_ACP_REASONING: "high" },
    undefined,
    runtime
  );

  const events = await collectEvents(worker, "pending:dsh-acp:test");

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
  assert.equal(
    threadBound?.kind === "thread_bound" && threadBound.threadId,
    "dsh_session_1"
  );
  assert.ok(
    events.some(
      (event) =>
        event.kind === "assistant_message_completed" &&
        event.text === "OK" &&
        event.itemId.includes(":final")
    )
  );
  assert.deepEqual(spawnOptions, [{ args: ["--profile", "acp"], cwd: "/tmp/dsh-workspace" }]);
  // dsh ACP 默认没有 reasoning_effort，必须显式设置，否则不会输出思考过程。
  assert.deepEqual(configOptions, [
    { sessionId: "dsh_session_1", configId: "reasoning_effort", value: "high" }
  ]);

  await worker.close();
});

test("DshAcpWorker retries once when a turn returns thinking but no final answer", async () => {
  const { runtime, promptTexts } = createFakeDshRuntime({ thinkingOnlyFirstPrompt: true });
  const worker = new DshAcpWorker(
    { DSH_ACP_COMMAND: "dsh", DSH_ACP_PROFILE: "acp", DSH_ACP_REASONING: "high" },
    undefined,
    runtime
  );

  const events = await collectEvents(worker, "pending:dsh-acp:retry");

  assert.equal(promptTexts.length, 2);
  assert.match(promptTexts[1] ?? "", /最终答复/);
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

test("DshAcpWorker promotes thinking to the final answer when no text is ever produced", async () => {
  const { runtime, promptTexts } = createFakeDshRuntime({ thinkingOnly: true });
  const worker = new DshAcpWorker(
    { DSH_ACP_COMMAND: "dsh", DSH_ACP_PROFILE: "acp", DSH_ACP_REASONING: "high" },
    undefined,
    runtime
  );

  const events = await collectEvents(worker, "pending:dsh-acp:promote");

  assert.equal(promptTexts.length, 2);
  assert.ok(
    events.some(
      (event) =>
        event.kind === "assistant_message_completed" &&
        event.text.includes("先想一下。") &&
        event.itemId.includes(":final")
    )
  );
  assert.ok(!events.some((event) => event.kind === "error"));

  await worker.close();
});

test("DshAcpWorker ensureThread returns a pending dsh thread id", async () => {
  const { runtime } = createFakeDshRuntime();
  const worker = new DshAcpWorker(
    { DSH_ACP_COMMAND: "dsh", DSH_ACP_PROFILE: "acp" },
    undefined,
    runtime
  );

  const threadId = await worker.ensureThread({
    cli: "dsh",
    workspaceId: "/tmp",
    message: buildMessage()
  });
  assert.match(threadId, /^pending:dsh-acp:/);

  await worker.close();
});

test("DshAcpWorker supportsSteer 为 true，走注入而非打断", () => {
  const worker = new DshAcpWorker({ DSH_ACP_COMMAND: "dsh", DSH_ACP_PROFILE: "acp" });
  assert.equal(worker.supportsSteer(), true);
  return worker.close();
});

test("DshAcpWorker steerTurn 把新消息排队到当前会话，当前轮结束后接力", async () => {
  const { runtime, promptTexts, releaseHeldPrompt } = createFakeDshRuntime({ holdPromptNumber: 1 });
  const worker = new DshAcpWorker(
    { DSH_ACP_COMMAND: "dsh", DSH_ACP_PROFILE: "acp", DSH_ACP_REASONING: "high" },
    undefined,
    runtime
  );

  // 第一轮 prompt 被 fake 挂住，所以后台消费、不阻塞测试。
  let boundTurnId: string | undefined;
  const consuming = (async () => {
    for await (const event of worker.runTurn({
      cli: "dsh",
      workspaceId: "/tmp/dsh-workspace",
      message: buildMessage(),
      threadId: "pending:dsh-acp:steer"
    })) {
      if (event.kind === "turn_bound") {
        boundTurnId = event.turnId;
      }
    }
  })();
  void consuming.catch(() => undefined);

  const deadline = Date.now() + 2_000;
  while (!boundTurnId && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(boundTurnId, "应先拿到 turn_bound 才能 steer");

  await worker.steerTurn({
    cli: "dsh",
    workspaceId: "/tmp/dsh-workspace",
    message: { ...buildMessage(), text: "顺便把 README 也更新一下" },
    threadId: "pending:dsh-acp:steer",
    turnId: boundTurnId
  });

  // 关键：steer 只是排队，当前轮还在跑，所以此刻只发出第一轮。
  // buildCliTurnInput 会加上飞书控制前缀，这里只关心末尾的用户文本。
  assert.equal(promptTexts.length, 1);
  assert.match(promptTexts[0] ?? "", /处理一下$/);

  // 放行当前轮：steer 的 prompt 已在 session 内部排队，会接力发出。
  releaseHeldPrompt?.();
  await new Promise((resolve) => setTimeout(resolve, 100));

  // steerTurn 本身必须已经返回（没有阻塞在当前轮上），这是这次改动的核心。
  // 接力 prompt 由 KimiAcpSession 的串行化在后台发出，不在断言范围内。
  await worker.close();
});

test("DshAcpWorker steerTurn 对已结束的 turn 报错，交给编排层兜底", async () => {
  const { runtime } = createFakeDshRuntime();
  const worker = new DshAcpWorker(
    { DSH_ACP_COMMAND: "dsh", DSH_ACP_PROFILE: "acp" },
    undefined,
    runtime
  );

  // 一个从未出现过的 turnId 视为已结束。
  await assert.rejects(
    worker.steerTurn({
      cli: "dsh",
      workspaceId: "/tmp/dsh-workspace",
      message: buildMessage(),
      threadId: "pending:dsh-acp:gone",
      turnId: "turn-not-running"
    }),
    (error: unknown) => (error as { code?: string }).code === "DSH_TURN_FINISHED"
  );

  await worker.close();
});


test("DSH uses only its dedicated proxy and enables Node fetch proxy support without mutating the parent", () => {
  const source = { HTTPS_PROXY: "http://unrelated:1", all_proxy: "socks5://unrelated:2", NO_PROXY: "*", NODE_USE_ENV_PROXY: "1", OTHER: "keep" };
  const proxied = dshProcessEnv(" http://local-proxy:7891 ", source);
  assert.equal(proxied.HTTPS_PROXY, "http://local-proxy:7891");
  assert.equal(proxied.http_proxy, proxied.HTTPS_PROXY);
  assert.equal(proxied.NODE_USE_ENV_PROXY, "1");
  assert.equal(proxied.NO_PROXY, "localhost,127.0.0.1,::1");
  assert.equal(proxied.all_proxy, undefined);
  assert.equal(source.HTTPS_PROXY, "http://unrelated:1");
  const direct = dshProcessEnv(undefined, source);
  assert.equal(direct.HTTPS_PROXY, undefined);
  assert.equal(direct.NODE_USE_ENV_PROXY, undefined);
  assert.equal(direct.OTHER, "keep");
});

test("DSH switches account and OpenCode routes in one session, then applies reasoning", async () => {
  const { runtime, configOptions, spawnOptions } = createFakeDshRuntime();
  const worker = new DshAcpWorker({ DSH_ACP_COMMAND: "dsh", DSH_ACP_PROFILE: "acp", DSH_ACP_REASONING: "high" }, undefined, runtime);
  try {
    await collectEvents(worker, "pending:dsh-acp:selection", { provider: "deepseek-account", model: "deepseek-flash" });
    await collectEvents(worker, "dsh_session_1", { provider: "opencode-go", model: "deepseek-flash", thinking: "off" });
    await collectEvents(worker, "dsh_session_1", { provider: "opencode-go", model: "kimi-k3" });
    assert.equal(spawnOptions.length, 1);
    assert.deepEqual(configOptions.map(({ configId, value }) => [configId, value]), [
      ["model", modelValue("deepseek-account", "deepseek-flash")], ["reasoning_effort", "high"],
      ["model", modelValue("opencode-go", "deepseek-v4.1-flash")], ["reasoning_effort", "off"],
      ["model", modelValue("opencode-go", "kimi-k3")], ["reasoning_effort", "high"]
    ]);
  } finally { await worker.close(); }
});

test("DSH validates explicit reasoning against the selected model and tolerates unsupported defaults", async () => {
  const { runtime, configOptions, promptTexts } = createFakeDshRuntime();
  const worker = new DshAcpWorker({ DSH_ACP_COMMAND: "dsh", DSH_ACP_PROFILE: "acp", DSH_ACP_REASONING: "high" }, undefined, runtime);
  try {
    await collectEvents(worker, "pending:dsh-acp:no-reasoning", { provider: "opencode-go", model: "no-reasoning" });
    assert.deepEqual(configOptions.map(({ configId }) => configId), ["model"]);
    await assert.rejects(collectEvents(worker, "dsh_session_1", { provider: "opencode-go", model: "no-reasoning", thinking: "high" }), /未提供 thinking/);
    assert.equal(promptTexts.length, 1);
  } finally { await worker.close(); }
});

test("DSH rejects missing routes before sending a prompt", async () => {
  const { runtime, promptTexts } = createFakeDshRuntime();
  const worker = new DshAcpWorker({ DSH_ACP_COMMAND: "dsh", DSH_ACP_PROFILE: "acp" }, undefined, runtime);
  try {
    await assert.rejects(collectEvents(worker, "pending:dsh-acp:missing", { provider: "deepseek-account", model: "kimi-k3" }), /不支持所选 provider\/模型/);
    assert.equal(promptTexts.length, 0);
  } finally { await worker.close(); }
});
