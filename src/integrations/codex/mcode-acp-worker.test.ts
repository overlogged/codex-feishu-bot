import assert from "node:assert/strict";
import type { ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";
import test from "node:test";

import type { CodexEvent, IncomingChatMessage } from "../../domain/types.js";
import { McodeAcpWorker } from "./mcode-acp-worker.js";
import type { KimiAcpRuntime } from "./kimi-acp-worker.js";

interface FakeOptions {
  thinkingOnlyFirstPrompt?: boolean;
  thinkingOnly?: boolean;
  /** mcode 广告的 configOptions；省略时返回默认三项。 */
  configOptions?: Array<Record<string, unknown>>;
  /** session/new 失败时返回该 error。 */
  sessionNewError?: Record<string, unknown>;
}

function createFakeMcodeRuntime(fakeOptions: FakeOptions = {}): {
  runtime: KimiAcpRuntime;
  spawnOptions: Array<{ args: string[]; cwd: string }>;
  configOptions: Array<Record<string, unknown>>;
  promptTexts: string[];
} {
  const spawnOptions: Array<{ args: string[]; cwd: string }> = [];
  const configOptions: Array<Record<string, unknown>> = [];
  const promptTexts: string[] = [];
  let promptCount = 0;
  const advertised = fakeOptions.configOptions ?? [
    { id: "permissionMode", type: "select" },
    { id: "model", type: "select" },
    { id: "thinkingEffort", type: "select" }
  ];

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

          const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
          if (message.method === "initialize" && message.id !== undefined) {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
            continue;
          }

          if (message.method === "session/new" && message.id !== undefined) {
            if (fakeOptions.sessionNewError) {
              write({ jsonrpc: "2.0", id: message.id, error: fakeOptions.sessionNewError });
              continue;
            }
            write({
              jsonrpc: "2.0",
              id: message.id,
              result: { sessionId: "mcode_session_1", configOptions: advertised }
            });
            continue;
          }

          if (message.method === "session/set_config_option" && message.id !== undefined) {
            configOptions.push(message.params ?? {});
            write({ jsonrpc: "2.0", id: message.id, result: { configOptions: advertised } });
            continue;
          }

          if (message.method === "session/prompt" && message.id !== undefined) {
            const id = message.id;
            const params = message.params as { prompt?: Array<{ text?: string }> } | undefined;
            promptCount += 1;
            promptTexts.push(params?.prompt?.map((part) => part.text ?? "").join("") ?? "");
            setImmediate(() => {
              // 先发思考过程，制造 commentary；再按需决定是否给正文。
              write({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: "mcode_session_1",
                  update: {
                    sessionUpdate: "agent_thought_chunk",
                    content: { type: "text", text: "先想一下。" }
                  }
                }
              });
              const thinkingOnly = fakeOptions.thinkingOnly === true ||
                (fakeOptions.thinkingOnlyFirstPrompt === true && promptCount === 1);
              if (!thinkingOnly) {
                write({
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    sessionId: "mcode_session_1",
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

  return { runtime, spawnOptions, configOptions, promptTexts };
}

const baseEnv = {
  MCODE_ACP_COMMAND: "mcode",
  MCODE_ACP_ARGS: ["acp"] as string[]
};

function contextFor(threadId: string): Parameters<McodeAcpWorker["ensureThread"]>[0] {
  return {
    cli: "mcode",
    workspaceId: "/tmp/mcode-workspace",
    message: { chatId: "oc_test", messageId: "om_test" } as IncomingChatMessage
  } as Parameters<McodeAcpWorker["ensureThread"]>[0] & { threadId: string };
}

async function collectEvents(
  worker: McodeAcpWorker,
  threadId: string
): Promise<CodexEvent[]> {
  const context = { ...contextFor(threadId), threadId };
  const events: CodexEvent[] = [];
  for await (const event of worker.runTurn(context)) {
    events.push(event);
  }
  return events;
}

test("McodeAcpWorker runs a turn over ACP and binds the new session", async () => {
  const { runtime, spawnOptions, configOptions } = createFakeMcodeRuntime();
  const worker = new McodeAcpWorker(
    { ...baseEnv, MCODE_ACP_REASONING: "high", MCODE_ACP_PERMISSION_MODE: "bypassPermissions" },
    undefined,
    runtime
  );

  const events = await collectEvents(worker, "pending:mcode-acp:test");

  assert.ok(events.some((event) => event.kind === "thread_bound" && event.threadId === "mcode_session_1"));
  assert.ok(
    events.some(
      (event) =>
        event.kind === "assistant_message_completed" &&
        event.text === "OK" &&
        event.itemId.includes(":final")
    )
  );
  assert.deepEqual(spawnOptions, [{ args: ["acp"], cwd: "/tmp/mcode-workspace" }]);

  // mcode 把思考档位命名为 thinkingEffort、并额外提供 permissionMode。
  assert.deepEqual(configOptions, [
    { sessionId: "mcode_session_1", configId: "thinkingEffort", value: "high" },
    { sessionId: "mcode_session_1", configId: "permissionMode", value: "bypassPermissions" }
  ]);

  await worker.close();
});

test("McodeAcpWorker skips config options the backend does not advertise", async () => {
  // 后端只广告 model，没有 thinkingEffort / permissionMode。
  const { runtime, configOptions } = createFakeMcodeRuntime({
    configOptions: [{ id: "model", type: "select" }]
  });
  const worker = new McodeAcpWorker(
    { ...baseEnv, MCODE_ACP_REASONING: "high", MCODE_ACP_PERMISSION_MODE: "bypassPermissions" },
    undefined,
    runtime
  );

  const events = await collectEvents(worker, "pending:mcode-acp:no-options");

  // 没有下发的选项也不应该让这一轮失败，最终答复照常产出。
  assert.deepEqual(configOptions, []);
  assert.ok(events.some((event) => event.kind === "assistant_message_completed" && event.text === "OK"));

  await worker.close();
});

test("McodeAcpWorker retries once when a turn returns thinking but no final answer", async () => {
  const { runtime, promptTexts } = createFakeMcodeRuntime({ thinkingOnlyFirstPrompt: true });
  const worker = new McodeAcpWorker(
    { ...baseEnv, MCODE_ACP_REASONING: "high" },
    undefined,
    runtime
  );

  const events = await collectEvents(worker, "pending:mcode-acp:retry");

  assert.equal(promptTexts.length, 2);
  assert.ok(events.some((event) => event.kind === "assistant_message_completed" && event.text === "OK"));

  await worker.close();
});

test("McodeAcpWorker surfaces a session/new failure instead of hanging silently", async () => {
  const { runtime } = createFakeMcodeRuntime({
    sessionNewError: { code: -32603, message: "Internal error" }
  });
  const worker = new McodeAcpWorker({ ...baseEnv }, undefined, runtime);

  // session/new 在 setup 阶段失败：dsh 后端走的是同一条路径，
  // 错误直接冒泡给编排层，由它决定如何向飞书呈现，而不是静默无输出。
  await assert.rejects(
    collectEvents(worker, "pending:mcode-acp:fail"),
    /Internal error/
  );

  await worker.close();
});

test("McodeAcpWorker ensureThread returns a pending mcode thread id", async () => {
  const { runtime } = createFakeMcodeRuntime();
  const worker = new McodeAcpWorker({ ...baseEnv }, undefined, runtime);

  const threadId = await worker.ensureThread(contextFor("pending"));

  assert.match(threadId, /^pending:mcode-acp:/);

  await worker.close();
});
