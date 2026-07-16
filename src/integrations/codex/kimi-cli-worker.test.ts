import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { Env } from "../../config/env.js";
import type { CodexEvent } from "../../domain/types.js";
import {
  KimiCliWorker,
  type KimiCliRuntime,
  KimiWireTurnProjector,
  normalizeKimiErrorMessage
} from "./kimi-cli-worker.js";

test("KimiWireTurnProjector streams think, tool, and final text events", () => {
  const projector = new KimiWireTurnProjector("turn_1");

  assert.deepEqual(
    projector.ingestEvent({
      type: "ContentPart",
      payload: {
        type: "think",
        think: "我先检查一下仓库状态。"
      }
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
        text: "我先检查一下仓库状态。"
      }
    ]
  );

  assert.deepEqual(
    projector.ingestEvent({
      type: "ToolCall",
      payload: {
        id: "call_1",
        type: "function",
        function: {
          name: "Shell",
          arguments: ""
        }
      }
    }),
    [
      {
        kind: "tool_call_started",
        itemId: "tool:turn_1:1",
        title: "执行命令",
        command: undefined
      }
    ]
  );

  assert.deepEqual(
    projector.ingestEvent({
      type: "ToolCallPart",
      payload: {
        arguments_part: '{"command":"git status --short"}'
      }
    }),
    [
      {
        kind: "tool_call_delta",
        itemId: "tool:turn_1:1",
        detail: "执行: git status --short"
      }
    ]
  );

  assert.deepEqual(
    projector.ingestEvent({
      type: "ToolResult",
      payload: {
        tool_call_id: "call_1",
        return_value: {
          is_error: false,
          output: "M README.md",
          message: "Command executed successfully."
        }
      }
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
        title: "调用 Shell",
        status: "completed",
        output: "M README.md"
      }
    ]
  );

  assert.deepEqual(
    projector.ingestEvent({
      type: "ContentPart",
      payload: {
        type: "think",
        think: "README.md 有本地改动。"
      }
    }),
    [
      {
        kind: "assistant_message_delta",
        itemId: "assistant:turn_1:commentary",
        text: "README.md 有本地改动。"
      }
    ]
  );

  assert.deepEqual(
    projector.ingestEvent({
      type: "ContentPart",
      payload: {
        type: "text",
        text: "README.md 有本地改动。"
      }
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
      text: "我先检查一下仓库状态。README.md 有本地改动。"
    },
    {
      kind: "assistant_message_completed",
      itemId: "assistant:turn_1:final",
      text: "README.md 有本地改动。"
    }
  ]);
});

test("KimiWireTurnProjector keeps commentary on error", () => {
  const projector = new KimiWireTurnProjector("turn_2");

  assert.deepEqual(
    projector.ingestEvent({
      type: "ContentPart",
      payload: {
        type: "think",
        think: "我已经开始处理这个请求。"
      }
    }),
    [
      {
        kind: "assistant_message_started",
        itemId: "assistant:turn_2:commentary",
        source: "commentary"
      },
      {
        kind: "assistant_message_delta",
        itemId: "assistant:turn_2:commentary",
        text: "我已经开始处理这个请求。"
      }
    ]
  );

  assert.deepEqual(
    projector.finalize({
      errorMessage: "Kimi Wire 会话执行失败。"
    }),
    [
      {
        kind: "assistant_message_completed",
        itemId: "assistant:turn_2:commentary",
        text: "我已经开始处理这个请求。"
      },
      {
        kind: "error",
        message: "Kimi Wire 会话执行失败。"
      }
    ]
  );
});

test("normalizeKimiErrorMessage explains membership-benefit 402 errors", () => {
  assert.equal(
    normalizeKimiErrorMessage(
      "Error code: 402 - {'error': {'message': \"We're unable to verify your membership benefits at this time. Please ensure your membership is active.\", 'type': 'invalid_request_error'}}"
    ),
    [
      "Kimi CLI 上游返回 402：当前账号的会员权益校验未通过。",
      "这个群当前走的是 Kimi CLI。请重新登录或续费 Kimi Code，或者把群绑定切到 codex 后重试。"
    ].join("\n")
  );
});

test("KimiWireTurnProjector fails when there is no final answer", () => {
  const projector = new KimiWireTurnProjector("turn_3");

  projector.ingestEvent({
    type: "ContentPart",
    payload: {
      type: "think",
      think: "我只进行了中间思考。"
    }
  });

  assert.deepEqual(projector.finalize({}), [
    {
      kind: "assistant_message_completed",
      itemId: "assistant:turn_3:commentary",
      text: "我只进行了中间思考。"
    },
    {
      kind: "error",
      message: "Kimi CLI 没有返回最终答复。"
    }
  ]);
});

test("KimiCliWorker fails a stuck wire turn after the idle timeout", async () => {
  const runtime: KimiCliRuntime = {
    spawnProcess() {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = new EventEmitter() as ChildProcessByStdio<PassThrough, PassThrough, PassThrough>;
      Object.assign(child, {
        stdin,
        stdout,
        stderr
      });

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
            id?: string;
            method?: string;
          };
          if (message.method === "initialize" && message.id) {
            stdout.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocol_version: "1.8",
                  server: {
                    name: "Kimi Code CLI",
                    version: "1.30.0"
                  }
                }
              })}\n`
            );
          }
        }
      });

      return {
        child,
        async stop() {
          stdout.end();
          stderr.end();
          child.emit("close", 0, null);
        }
      };
    }
  };

  const worker = new KimiCliWorker(
    {} as Env,
    undefined,
    runtime,
    {
      initializeTimeoutMs: 50,
      turnIdleTimeoutMs: 30
    }
  );

  const events: CodexEvent[] = [];
  for await (const event of worker.runTurn({
    cli: "kimi",
    workspaceId: "/home/overlogged/QuantDev",
    executionMode: "docker",
    threadId: "thread_test",
    message: {
      chatId: "chat_test",
      chatType: "group",
      messageId: "msg_test",
      senderId: "user_test",
      senderName: "user_test",
      senderType: "user",
      text: "只回复 ok",
      mentionsBot: false,
      raw: {}
    }
  })) {
    events.push(event);
  }

  assert.equal(
    events.some(
      (event) => event.kind === "error" && event.message === "Kimi Wire 长时间没有输出，已终止当前任务。"
    ),
    true
  );
  await worker.close();
});

test("KimiCliWorker does not fail a quiet turn when the idle timeout is disabled", async () => {
  const runtime: KimiCliRuntime = {
    spawnProcess() {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = new EventEmitter() as ChildProcessByStdio<PassThrough, PassThrough, PassThrough>;
      Object.assign(child, {
        stdin,
        stdout,
        stderr
      });

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
            id?: string;
            method?: string;
          };
          if (message.method === "initialize" && message.id) {
            stdout.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocol_version: "1.8",
                  server: {
                    name: "Kimi Code CLI",
                    version: "1.30.0"
                  }
                }
              })}\n`
            );
          }
        }
      });

      return {
        child,
        async stop() {
          stdout.end();
          stderr.end();
          child.emit("close", 0, null);
        }
      };
    }
  };

  const worker = new KimiCliWorker(
    {} as Env,
    undefined,
    runtime,
    {
      initializeTimeoutMs: 50,
      turnIdleTimeoutMs: 0
    }
  );

  const iterator = worker.runTurn({
    cli: "kimi",
    workspaceId: "/home/overlogged/QuantDev",
    executionMode: "docker",
    threadId: "thread_test",
    message: {
      chatId: "chat_test",
      chatType: "group",
      messageId: "msg_test",
      senderId: "user_test",
      senderName: "user_test",
      senderType: "user",
      text: "只回复 ok",
      mentionsBot: false,
      raw: {}
    }
  })[Symbol.asyncIterator]();

  const first = await iterator.next();
  const second = await iterator.next();
  const third = await iterator.next();
  assert.equal(first.value?.kind, "turn_bound");
  assert.equal(second.value?.kind, "run_status");
  assert.equal(third.value?.kind, "thread_bound");

  const quietResult = await Promise.race([
    iterator.next(),
    new Promise<{ timeout: true }>((resolve) => {
      setTimeout(() => resolve({ timeout: true }), 80).unref();
    })
  ]);
  assert.deepEqual(quietResult, {
    timeout: true
  });

  await worker.close();
});

test("KimiCliWorker starts a fresh docker thread when persisted wire turn is unfinished", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "kimi-wire-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;

  try {
    const workspaceId = "/home/overlogged/QuantDev";
    const workspaceHash = createHash("md5").update(workspaceId).digest("hex");
    const threadId = "thread_existing";
    const sessionDir = join(homeDir, ".kimi", "sessions", workspaceHash, threadId);
    await mkdir(sessionDir, {
      recursive: true
    });
    await writeFile(
      join(sessionDir, "wire.jsonl"),
      [
        JSON.stringify({
          message: {
            type: "TurnBegin",
            payload: {
              user_input: "旧任务"
            }
          }
        }),
        JSON.stringify({
          message: {
            type: "StepBegin",
            payload: {
              n: 1
            }
          }
        })
      ].join("\n"),
      "utf8"
    );

    const worker = new KimiCliWorker({} as Env);
    const nextThreadId = await worker.ensureThread({
      session: {
        chatId: "chat_test",
        threadId,
        cli: "kimi",
        workspaceId,
        executionMode: "docker",
        updatedAt: new Date().toISOString()
      },
      cli: "kimi",
      workspaceId,
      executionMode: "docker",
      message: {
        chatId: "chat_test",
        chatType: "group",
        messageId: "msg_test",
        senderId: "user_test",
        senderName: "user_test",
        senderType: "user",
        text: "只回复 ok",
        mentionsBot: false,
        raw: {}
      }
    });

    assert.match(nextThreadId, /^pending:kimi:/);
    await worker.close();
  } finally {
    process.env.HOME = previousHome;
  }
});

test("KimiCliWorker keeps the docker thread when the persisted wire turn already ended", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "kimi-wire-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;

  try {
    const workspaceId = "/home/overlogged/QuantDev";
    const workspaceHash = createHash("md5").update(workspaceId).digest("hex");
    const threadId = "thread_existing";
    const sessionDir = join(homeDir, ".kimi", "sessions", workspaceHash, threadId);
    await mkdir(sessionDir, {
      recursive: true
    });
    await writeFile(
      join(sessionDir, "wire.jsonl"),
      [
        JSON.stringify({
          message: {
            type: "TurnBegin",
            payload: {
              user_input: "旧任务"
            }
          }
        }),
        JSON.stringify({
          message: {
            type: "TurnEnd",
            payload: {}
          }
        })
      ].join("\n"),
      "utf8"
    );

    const worker = new KimiCliWorker({} as Env);
    const nextThreadId = await worker.ensureThread({
      session: {
        chatId: "chat_test",
        threadId,
        cli: "kimi",
        workspaceId,
        executionMode: "docker",
        updatedAt: new Date().toISOString()
      },
      cli: "kimi",
      workspaceId,
      executionMode: "docker",
      message: {
        chatId: "chat_test",
        chatType: "group",
        messageId: "msg_test",
        senderId: "user_test",
        senderName: "user_test",
        senderType: "user",
        text: "只回复 ok",
        mentionsBot: false,
        raw: {}
      }
    });

    assert.equal(nextThreadId, threadId);
    await worker.close();
  } finally {
    process.env.HOME = previousHome;
  }
});
