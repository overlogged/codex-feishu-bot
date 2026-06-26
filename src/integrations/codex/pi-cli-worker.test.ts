import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { Env } from "../../config/env.js";
import type { CodexEvent } from "../../domain/types.js";
import {
  buildPiCliArgs,
  PiCliWorker,
  selectPiModelFromMessage,
  type PiCliRuntime
} from "./pi-cli-worker.js";

test("selectPiModelFromMessage detects DeepSeek V4 Pro", () => {
  assert.deepEqual(selectPiModelFromMessage("用 DeepSeek V4 Pro 写代码"), {
    model: "deepseek-v4-pro"
  });
  assert.deepEqual(selectPiModelFromMessage("deepseek-v4-pro"), {
    model: "deepseek-v4-pro"
  });
  assert.deepEqual(selectPiModelFromMessage("切到 ds4 pro"), {
    model: "deepseek-v4-pro"
  });
});

test("selectPiModelFromMessage detects DeepSeek V4 Flash", () => {
  assert.deepEqual(selectPiModelFromMessage("用 DeepSeek V4 Flash 快速回答"), {
    model: "deepseek-v4-flash"
  });
  assert.deepEqual(selectPiModelFromMessage("切到 v4 flash"), {
    model: "deepseek-v4-flash"
  });
  assert.deepEqual(selectPiModelFromMessage("docker pi ds4 flash"), {
    model: "deepseek-v4-flash"
  });
});

test("selectPiModelFromMessage falls back to DeepSeek V4 Pro for generic deepseek or ds4", () => {
  assert.deepEqual(selectPiModelFromMessage("连 deepseek"), {
    model: "deepseek-v4-pro"
  });
  assert.deepEqual(selectPiModelFromMessage("用 ds4 写代码"), {
    model: "deepseek-v4-pro"
  });
  assert.deepEqual(selectPiModelFromMessage("用 ds 写代码"), {
    model: "deepseek-v4-pro"
  });
});

test("selectPiModelFromMessage returns empty when no model is mentioned", () => {
  assert.deepEqual(selectPiModelFromMessage("你好"), {});
});

test("buildPiCliArgs uses persisted session files instead of no-session mode", () => {
  const args = buildPiCliArgs(
    {
      PI_CLI_PROVIDER: "openrouter",
      PI_CLI_MODEL: "deepseek-v4-pro",
      PI_CLI_THINKING: "xhigh"
    },
    {
      cli: "pi",
      workspaceId: "/home/overlogged/QuantDev",
      executionMode: "host",
      message: {
        chatId: "oc_group_1",
        chatType: "group",
        messageId: "om_1",
        senderId: "ou_1",
        senderName: "user",
        senderType: "user",
        text: "帮我看一下",
        mentionsBot: false,
        raw: {}
      }
    },
    "/home/overlogged/.pi/agent/sessions/codex-feishu-bot/oc_group_1/session.jsonl"
  );

  assert.deepEqual(args.slice(0, 5), [
    "-p",
    "--mode",
    "json",
    "--session",
    "/home/overlogged/.pi/agent/sessions/codex-feishu-bot/oc_group_1/session.jsonl"
  ]);
  assert.equal(args.includes("--no-session"), false);
  assert.equal(args.includes("--provider"), true);
  assert.equal(args[args.indexOf("--provider") + 1], "openrouter");
  assert.equal(args[args.indexOf("--model") + 1], "deepseek-v4-pro");
  assert.equal(args[args.indexOf("--thinking") + 1], "xhigh");
});

test("buildPiCliArgs lets DS4 Flash in the message override the default Pro model", () => {
  const args = buildPiCliArgs(
    {
      PI_CLI_PROVIDER: "openrouter",
      PI_CLI_MODEL: "deepseek-v4-pro",
      PI_CLI_THINKING: "xhigh"
    },
    {
      cli: "pi",
      workspaceId: "/home/overlogged/QuantDev",
      executionMode: "docker",
      message: {
        chatId: "oc_group_1",
        chatType: "group",
        messageId: "om_1",
        senderId: "ou_1",
        senderName: "user",
        senderType: "user",
        text: "用 ds4 flash 快速改一下",
        mentionsBot: false,
        raw: {}
      }
    },
    "/home/overlogged/.pi/agent/sessions/codex-feishu-bot/oc_group_1/session.jsonl"
  );

  assert.equal(args[args.indexOf("--model") + 1], "deepseek-v4-flash");
});

test("PiCliWorker streams json thinking as commentary and text as final answer", async () => {
  const runtime: PiCliRuntime = {
    spawnProcess() {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        killed: boolean;
        kill(signal?: string): boolean;
      };
      child.stdout = stdout;
      child.stderr = stderr;
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        return true;
      };

      setImmediate(() => {
        stdout.write(
          `${JSON.stringify({
            type: "message_update",
            assistantMessageEvent: {
              type: "thinking_delta",
              delta: "先检查上下文。"
            }
          })}\n`
        );
        stdout.write(
          `${JSON.stringify({
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              delta: "OK"
            }
          })}\n`
        );
        stdout.end();
        stderr.end();
        child.emit("close", 0);
      });

      return {
        child: child as never,
        async stop() {
          child.kill("SIGTERM");
        }
      };
    }
  };
  const worker = new PiCliWorker(
    {
      PI_CLI_COMMAND: "pi",
      PI_CLI_PROVIDER: "deepseek",
      PI_CLI_MODEL: "deepseek-v4-pro",
      PI_CLI_THINKING: "xhigh"
    } as Env,
    undefined,
    runtime
  );

  const context = {
    cli: "pi" as const,
    workspaceId: "/tmp",
    executionMode: "docker" as const,
    message: {
      chatId: "oc_group_1",
      chatType: "group",
      messageId: "om_1",
      senderId: "ou_1",
      senderName: "user",
      senderType: "user",
      text: "测试",
      mentionsBot: false,
      raw: {}
    }
  };

  const events: CodexEvent[] = [];
  const threadId = await worker.ensureThread(context);
  for await (const event of worker.runTurn({ ...context, threadId })) {
    events.push(event);
  }

  assert.ok(
    events.some(
      (event) => event.kind === "assistant_message_started" && event.source === "commentary"
    )
  );
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
      (event) => event.kind === "assistant_message_started" && event.source === "final_answer"
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
});
