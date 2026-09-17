import assert from "node:assert/strict";
import type { ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { CodexEvent, IncomingChatMessage } from "../../domain/types.js";
import {
  KimiAcpTurnProjector,
  KimiAcpWorker,
  type KimiAcpRuntime
} from "./kimi-acp-worker.js";

test("KimiAcpTurnProjector streams thought, tool, and final events", () => {
  const projector = new KimiAcpTurnProjector("turn_1");

  assert.deepEqual(
    projector.ingestUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "我先想一下。" }
    }),
    [
      {
        kind: "assistant_message_started",
        itemId: "assistant:turn_1:commentary",
        source: "commentary"
      },
      {
        kind: "assistant_message_delta",
        itemId: "assistant:turn_1:commentary",
        text: "我先想一下。"
      }
    ]
  );

  assert.deepEqual(
    projector.ingestUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "执行 git status",
      status: "in_progress",
      rawInput: { command: "git status --short" }
    }),
    [
      {
        kind: "tool_call_started",
        itemId: "tool:turn_1:1",
        title: "执行 git status",
        command: "git status --short"
      }
    ]
  );

  assert.deepEqual(
    projector.ingestUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "M README.md" } }]
    }),
    [
      {
        kind: "tool_call_delta",
        itemId: "tool:turn_1:1",
        output: "M README.md",
        detail: "M README.md"
      },
      {
        kind: "tool_call_completed",
        itemId: "tool:turn_1:1",
        title: "执行 git status",
        status: "completed",
        output: "M README.md"
      }
    ]
  );

  assert.deepEqual(
    projector.ingestUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "README.md 有本地改动。" }
    }),
    [
      {
        kind: "assistant_message_started",
        itemId: "assistant:turn_1:final",
        source: "final_answer"
      },
      {
        kind: "assistant_message_delta",
        itemId: "assistant:turn_1:final",
        text: "README.md 有本地改动。"
      }
    ]
  );

  assert.deepEqual(projector.finalize({}), [
    {
      kind: "assistant_message_completed",
      itemId: "assistant:turn_1:commentary",
      text: "我先想一下。"
    },
    {
      kind: "assistant_message_completed",
      itemId: "assistant:turn_1:final",
      text: "README.md 有本地改动。"
    }
  ]);
});

test("KimiAcpTurnProjector tolerates unknown toolCallId and terminal status on first update", () => {
  const projector = new KimiAcpTurnProjector("turn_2");

  const events = projector.ingestUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "call_late",
    title: "读取文件",
    status: "failed",
    rawOutput: "permission denied"
  });

  assert.equal(events[0]?.kind, "tool_call_started");
  assert.deepEqual(events.at(-1), {
    kind: "tool_call_completed",
    itemId: "tool:turn_2:1",
    title: "读取文件",
    status: "failed",
    output: "permission denied"
  });
});

test("KimiAcpTurnProjector suppresses streaming argument fragments until rawInput arrives", () => {
  const projector = new KimiAcpTurnProjector("turn_args");

  projector.ingestUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call_args",
    title: "Bash",
    status: "pending"
  });

  assert.deepEqual(
    projector.ingestUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_args",
      status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: '{"command":"' } }]
    }),
    []
  );
  assert.deepEqual(
    projector.ingestUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_args",
      status: "in_progress",
      content: [
        { type: "content", content: { type: "text", text: '{"command":"echo hello-acp"' } }
      ]
    }),
    []
  );
  assert.deepEqual(
    projector.ingestUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_args",
      status: "in_progress",
      rawInput: { command: "echo hello-acp" },
      content: [
        { type: "content", content: { type: "text", text: '{"command":"echo hello-acp"}' } }
      ]
    }),
    [
      {
        kind: "tool_call_delta",
        itemId: "tool:turn_args:1",
        detail: "执行: echo hello-acp"
      }
    ]
  );
  assert.deepEqual(
    projector.ingestUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_args",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "hello-acp\n" } }],
      rawOutput: "hello-acp\n"
    }),
    [
      {
        kind: "tool_call_delta",
        itemId: "tool:turn_args:1",
        output: "hello-acp\n",
        detail: "hello-acp\n"
      },
      {
        kind: "tool_call_completed",
        itemId: "tool:turn_args:1",
        title: "Bash",
        status: "completed",
        output: "hello-acp\n"
      }
    ]
  );
});

test("KimiAcpTurnProjector ignores non-content updates", () => {
  const projector = new KimiAcpTurnProjector("turn_3");

  assert.deepEqual(
    projector.ingestUpdate({
      sessionUpdate: "usage_update",
      used: 100,
      size: 1000
    }),
    []
  );
  assert.deepEqual(
    projector.ingestUpdate({
      sessionUpdate: "available_commands_update",
      availableCommands: []
    }),
    []
  );
});

test("KimiAcpTurnProjector stays quiet when a cancelled turn has no final answer", () => {
  const projector = new KimiAcpTurnProjector("turn_4");

  projector.ingestUpdate({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "我还在处理。" }
  });

  assert.deepEqual(projector.finalize({ cancelled: true }), [
    {
      kind: "assistant_message_completed",
      itemId: "assistant:turn_4:commentary",
      text: "我还在处理。"
    }
  ]);
});

test("KimiAcpTurnProjector errors when a finished turn has no final answer", () => {
  const projector = new KimiAcpTurnProjector("turn_5");

  assert.deepEqual(projector.finalize({}), [
    {
      kind: "error",
      message: "Kimi ACP 没有返回可见内容。"
    }
  ]);
});

function createFakeAcpSpawn(
  options: {
    failResume?: boolean;
    hangPromptUntilCancel?: boolean;
    hangPromptCount?: number;
    swallowPrompts?: boolean;
    onSwallowedPrompt?: (text: string) => void;
  } = {}
): {
  runtime: KimiAcpRuntime;
  prompts: Array<{ id: number; text: string }>;
} {
  const prompts: Array<{ id: number; text: string }> = [];
  const runtime: KimiAcpRuntime = {
    spawnProcess: () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as ChildProcessByStdio<PassThrough, PassThrough, PassThrough>;
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

    let promptsToHang =
      options.hangPromptCount ??
      (options.hangPromptUntilCancel ? Number.POSITIVE_INFINITY : 0);
    const hangingResolvers = new Map<number, () => void>();
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

        const message = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: { prompt?: Array<{ text?: string }> };
        };

        if (message.method === "initialize" && message.id !== undefined) {
          write({
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: 1, agentCapabilities: { loadSession: true } }
          });
          continue;
        }

        if (message.method === "session/new" && message.id !== undefined) {
          write({
            jsonrpc: "2.0",
            id: message.id,
            result: { sessionId: "session_fake_1" }
          });
          continue;
        }

        if (message.method === "session/resume" && message.id !== undefined) {
          if (options.failResume) {
            write({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32602, message: "session not found" }
            });
          } else {
            write({
              jsonrpc: "2.0",
              id: message.id,
              result: {}
            });
          }
          continue;
        }

        if (message.method === "session/prompt" && message.id !== undefined) {
          const id = message.id;
          const text = message.params?.prompt?.[0]?.text ?? "";
          prompts.push({ id, text });
          if (options.swallowPrompts) {
            // 模拟 kimi-code 0.43+ 在引擎被内部 turn 占用时的行为：
            // prompt 被排队，立刻以 end_turn 应答且不回流任何事件。
            setImmediate(() => {
              write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
              options.onSwallowedPrompt?.(text);
            });
            continue;
          }

          if (promptsToHang > 0) {
            promptsToHang -= 1;
            hangingResolvers.set(id, () => {
              write({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
            });
            continue;
          }

          setImmediate(() => {
            write({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "session_fake_1",
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "处理完了。" }
                }
              }
            });
            write({
              jsonrpc: "2.0",
              id,
              result: { stopReason: "end_turn" }
            });
          });
          continue;
        }

        if (message.method === "session/cancel") {
          for (const resolve of hangingResolvers.values()) {
            resolve();
          }
          hangingResolvers.clear();
          continue;
        }
      }
    });

      return {
        child,
        stop: async () => {
          child.kill();
        }
      };
    }
  };

  return { runtime, prompts };
}

function buildMessage(): IncomingChatMessage {
  return {
    chatId: "oc_acp_test",
    chatType: "group",
    messageId: "om_acp_test",
    senderId: "ou_test",
    senderName: "tester",
    senderType: "user",
    text: "处理一下",
    mentionsBot: false,
    raw: {}
  };
}

async function collectEvents(worker: KimiAcpWorker, threadId: string): Promise<CodexEvent[]> {
  const events: CodexEvent[] = [];
  for await (const event of worker.runTurn({
    cli: "kimi",
    workspaceId: "/tmp",
    message: buildMessage(),
    threadId
  })) {
    events.push(event);
  }
  return events;
}

test("KimiAcpWorker runs a turn over ACP and binds the new session", async () => {
  const { runtime } = createFakeAcpSpawn();
  const worker = new KimiAcpWorker({ KIMI_ACP_COMMAND: "kimi" }, undefined, runtime);

  const events = await collectEvents(worker, "pending:kimi-acp:test");

  assert.deepEqual(
    events.map((event) => event.kind),
    [
      "turn_bound",
      "run_status",
      "thread_bound",
      "assistant_message_started",
      "assistant_message_delta",
      "assistant_message_completed"
    ]
  );
  assert.equal(events[2]?.kind === "thread_bound" && events[2].threadId, "session_fake_1");
  const turnId = events[0]?.kind === "turn_bound" ? events[0].turnId : "";
  assert.deepEqual(events.at(-1), {
    kind: "assistant_message_completed",
    itemId: `assistant:${turnId}:final`,
    text: "处理完了。"
  });

  await worker.close();
});

test("KimiAcpWorker falls back to a new session when resume fails", async () => {
  const { runtime } = createFakeAcpSpawn({ failResume: true });
  const worker = new KimiAcpWorker({ KIMI_ACP_COMMAND: "kimi" }, undefined, runtime);

  const events = await collectEvents(worker, "legacy-uuid-thread-id");
  const threadBound = events.find((event) => event.kind === "thread_bound");
  assert.equal(threadBound?.kind === "thread_bound" && threadBound.threadId, "session_fake_1");

  await worker.close();
});

test("KimiAcpWorker resumes an existing session over ACP", async () => {
  const { runtime } = createFakeAcpSpawn();
  const worker = new KimiAcpWorker({ KIMI_ACP_COMMAND: "kimi" }, undefined, runtime);

  const events = await collectEvents(worker, "session_existing_1");
  const threadBound = events.find((event) => event.kind === "thread_bound");
  assert.equal(threadBound?.kind === "thread_bound" && threadBound.threadId, "session_existing_1");

  await worker.close();
});

test("KimiAcpWorker interrupt cancels the in-flight prompt without an error event", async () => {
  const { runtime } = createFakeAcpSpawn({ hangPromptUntilCancel: true });
  const worker = new KimiAcpWorker({ KIMI_ACP_COMMAND: "kimi" }, undefined, runtime);
  const activeTurns = () =>
    (worker as unknown as { activeTurns: Map<string, unknown> }).activeTurns;

  const eventsPromise = collectEvents(worker, "pending:kimi-acp:interrupt");

  let turnId: string | undefined;
  for (let attempt = 0; attempt < 100 && !turnId; attempt += 1) {
    turnId = Array.from(activeTurns().keys())[0];
    if (!turnId) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.ok(turnId, "active turn should be registered");

  await worker.interruptTurn({
    cli: "kimi",
    workspaceId: "/tmp",
    message: buildMessage(),
    threadId: "pending:kimi-acp:interrupt",
    turnId,
    interruptionMessage: "当前任务已被后续消息中断。"
  });

  const events = await eventsPromise;
  assert.ok(
    !events.some((event) => event.kind === "error"),
    `cancelled turn should not emit error events: ${JSON.stringify(events)}`
  );

  await worker.close();
});

test("KimiAcpWorker waits for the active turn before sending the next prompt", async () => {
  const { runtime, prompts } = createFakeAcpSpawn({ hangPromptCount: 1 });
  const worker = new KimiAcpWorker({ KIMI_ACP_COMMAND: "kimi" }, undefined, runtime);
  const activeTurns = () =>
    (worker as unknown as { activeTurns: Map<string, unknown> }).activeTurns;

  const firstEventsPromise = collectEvents(worker, "session_existing_1");

  let turnId: string | undefined;
  for (let attempt = 0; attempt < 100 && !turnId; attempt += 1) {
    turnId = Array.from(activeTurns().keys())[0];
    if (!turnId) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.ok(turnId, "first turn should be registered");
  assert.equal(prompts.length, 1);

  // 第二个 turn 必须等第一个 turn 结束，否则 ACP 会报 another turn is already in progress。
  const secondEventsPromise = collectEvents(worker, "session_existing_1");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(prompts.length, 1);

  await worker.interruptTurn({
    cli: "kimi",
    workspaceId: "/tmp",
    message: buildMessage(),
    threadId: "session_existing_1",
    turnId,
    interruptionMessage: "当前任务已被后续消息中断。"
  });

  const [firstEvents, secondEvents] = await Promise.all([
    firstEventsPromise,
    secondEventsPromise
  ]);
  assert.equal(prompts.length, 2);
  assert.ok(!firstEvents.some((event) => event.kind === "error"));
  assert.ok(
    secondEvents.some(
      (event) => event.kind === "assistant_message_completed" && event.text === "处理完了。"
    ),
    `second turn should complete normally: ${JSON.stringify(secondEvents)}`
  );

  await worker.close();
});

async function withFakeKimiHome(
  run: (paths: { home: string; wirePath: string }) => Promise<void>
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "kimi-acp-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const kimiDir = join(home, ".kimi-code");
    const wireDir = join(
      kimiDir,
      "sessions",
      "wd_test",
      "session_fake_1",
      "agents",
      "main"
    );
    await mkdir(wireDir, { recursive: true });
    await writeFile(
      join(kimiDir, "workspaces.json"),
      JSON.stringify({ workspaces: { wd_test: { root: "/tmp" } } })
    );
    const wirePath = join(wireDir, "wire.jsonl");
    await writeFile(wirePath, "");
    await run({ home, wirePath });
  } finally {
    process.env.HOME = previousHome;
  }
}

test("KimiAcpWorker recovers a queued prompt's answer from the session transcript", async () => {
  await withFakeKimiHome(async ({ wirePath }) => {
    const { runtime } = createFakeAcpSpawn({
      swallowPrompts: true,
      onSwallowedPrompt: (text) => {
        setTimeout(() => {
          const now = Date.now();
          appendFileSync(
            wirePath,
            [
              JSON.stringify({
                type: "turn.prompt",
                agentId: "main",
                input: [{ type: "text", text }],
                promptId: "msg_queued_1",
                turnId: 42,
                time: now
              }),
              JSON.stringify({
                type: "context.append_loop_event",
                agentId: "main",
                event: {
                  type: "content.part",
                  turnId: "42",
                  step: 1,
                  part: { type: "think", think: "内部思考不应出现" }
                },
                time: now
              }),
              JSON.stringify({
                type: "context.append_loop_event",
                agentId: "main",
                event: {
                  type: "content.part",
                  turnId: "42",
                  step: 1,
                  part: { type: "text", text: "排队消息的答复。" }
                },
                time: now
              }),
              JSON.stringify({
                type: "turn.ended",
                agentId: "main",
                turnId: 42,
                reason: "completed",
                time: now
              })
            ].join("\n") + "\n"
          );
        }, 50);
      }
    });
    const worker = new KimiAcpWorker({ KIMI_ACP_COMMAND: "kimi" }, undefined, runtime, {
      pollIntervalMs: 10,
      timeoutMs: 3_000
    });

    const events = await collectEvents(worker, "pending:kimi-acp:queued");

    assert.ok(
      !events.some((event) => event.kind === "error"),
      `queued prompt should recover without error: ${JSON.stringify(events)}`
    );
    assert.ok(
      events.some(
        (event) => event.kind === "assistant_message_completed" && event.itemId.endsWith(":notice")
      ),
      `queued notice should be announced: ${JSON.stringify(events)}`
    );
    const final = events.at(-1);
    assert.equal(final?.kind, "assistant_message_completed");
    assert.ok(final?.kind === "assistant_message_completed" && final.itemId.endsWith(":final"));
    assert.equal(final?.kind === "assistant_message_completed" && final.text, "排队消息的答复。");
    assert.ok(!JSON.stringify(events).includes("内部思考不应出现"));

    await worker.close();
  });
});

test("KimiAcpWorker times out when a queued prompt never produces a transcript answer", async () => {
  await withFakeKimiHome(async () => {
    const { runtime } = createFakeAcpSpawn({ swallowPrompts: true });
    const worker = new KimiAcpWorker({ KIMI_ACP_COMMAND: "kimi" }, undefined, runtime, {
      pollIntervalMs: 10,
      timeoutMs: 150
    });

    const events = await collectEvents(worker, "pending:kimi-acp:queued-timeout");

    const error = events.find((event) => event.kind === "error");
    assert.ok(error, `expected a timeout error event: ${JSON.stringify(events)}`);
    assert.ok(
      error?.kind === "error" && error.message.includes("超时"),
      `unexpected error message: ${JSON.stringify(error)}`
    );

    await worker.close();
  });
});
