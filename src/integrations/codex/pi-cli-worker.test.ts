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

test("selectPiModelFromMessage maps retired DeepSeek V4 Pro mentions to V4.1 Flash", () => {
  assert.deepEqual(selectPiModelFromMessage("用 DeepSeek V4 Pro 写代码"), {
    model: "deepseek-flash"
  });
  assert.deepEqual(selectPiModelFromMessage("deepseek-v4-pro"), {
    model: "deepseek-flash"
  });
  assert.deepEqual(selectPiModelFromMessage("切到 ds4 pro"), {
    model: "deepseek-flash"
  });
});

test("selectPiModelFromMessage detects DeepSeek V4.1 Flash", () => {
  assert.deepEqual(selectPiModelFromMessage("用 DeepSeek V4.1 Flash 快速回答"), {
    model: "deepseek-flash"
  });
  assert.deepEqual(selectPiModelFromMessage("切到 ds4.1 flash"), {
    model: "deepseek-flash"
  });
  assert.deepEqual(selectPiModelFromMessage("用 DeepSeek V4 Flash 快速回答"), {
    model: "deepseek-flash"
  });
  assert.deepEqual(selectPiModelFromMessage("切到 v4 flash"), {
    model: "deepseek-flash"
  });
  assert.deepEqual(selectPiModelFromMessage("pi ds4 flash"), {
    model: "deepseek-flash"
  });
});

test("selectPiModelFromMessage falls back to DeepSeek V4.1 Flash for generic deepseek or ds4", () => {
  assert.deepEqual(selectPiModelFromMessage("连 deepseek"), {
    model: "deepseek-flash"
  });
  assert.deepEqual(selectPiModelFromMessage("用 ds4 写代码"), {
    model: "deepseek-flash"
  });
  assert.deepEqual(selectPiModelFromMessage("用 ds 写代码"), {
    model: "deepseek-flash"
  });
});

test("selectPiModelFromMessage returns empty when no model is mentioned", () => {
  assert.deepEqual(selectPiModelFromMessage("你好"), {});
});

test("selectPiModelFromMessage detects GLM 5.3 Flash via openmodel provider", () => {
  assert.deepEqual(selectPiModelFromMessage("用 GLM 5.3 Flash 写代码"), {
    provider: "openmodel",
    model: "glm-5.3-flash"
  });
  assert.deepEqual(selectPiModelFromMessage("切到 glm-5.3-flash"), {
    provider: "openmodel",
    model: "glm-5.3-flash"
  });
  assert.deepEqual(selectPiModelFromMessage("用 glm flash 快速回答"), {
    provider: "openmodel",
    model: "glm-5.3-flash"
  });
  assert.deepEqual(selectPiModelFromMessage("换 openmodel 的 glm"), {
    provider: "openmodel",
    model: "glm-5.3-flash"
  });
});

test("buildPiCliArgs routes GLM bindings to the openmodel provider instead of env defaults", () => {
  const args = buildPiCliArgs(
    {
      PI_CLI_PROVIDER: "deepseek",
      PI_CLI_MODEL: "deepseek-flash",
      PI_CLI_THINKING: "xhigh"
    },
    {
      cli: "pi",
      workspaceId: "/home/overlogged/QuantDev",
      provider: undefined,
      model: "glm-5.3-flash",
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

  assert.equal(args[args.indexOf("--provider") + 1], "openmodel");
  assert.equal(args[args.indexOf("--model") + 1], "glm-5.3-flash");
});

test("buildPiCliArgs lets GLM flash in the message override the default DeepSeek model", () => {
  const args = buildPiCliArgs(
    {
      PI_CLI_PROVIDER: "deepseek",
      PI_CLI_MODEL: "deepseek-flash",
      PI_CLI_THINKING: "xhigh"
    },
    {
      cli: "pi",
      workspaceId: "/home/overlogged/QuantDev",
      message: {
        chatId: "oc_group_1",
        chatType: "group",
        messageId: "om_1",
        senderId: "ou_1",
        senderName: "user",
        senderType: "user",
        text: "用 glm flash 快速改一下",
        mentionsBot: false,
        raw: {}
      }
    },
    "/home/overlogged/.pi/agent/sessions/codex-feishu-bot/oc_group_1/session.jsonl"
  );

  assert.equal(args[args.indexOf("--provider") + 1], "openmodel");
  assert.equal(args[args.indexOf("--model") + 1], "glm-5.3-flash");
});

test("buildPiCliArgs uses persisted session files instead of no-session mode", () => {
  const args = buildPiCliArgs(
    {
      PI_CLI_PROVIDER: "openrouter",
      PI_CLI_MODEL: "deepseek-flash",
      PI_CLI_THINKING: "xhigh"
    },
    {
      cli: "pi",
      workspaceId: "/home/overlogged/QuantDev",
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
  assert.equal(args[args.indexOf("--model") + 1], "deepseek-flash");
  assert.equal(args[args.indexOf("--thinking") + 1], "xhigh");
});

test("buildPiCliArgs lets DS4 Flash in the message override the default model", () => {
  const args = buildPiCliArgs(
    {
      PI_CLI_PROVIDER: "openrouter",
      PI_CLI_MODEL: "deepseek-flash",
      PI_CLI_THINKING: "xhigh"
    },
    {
      cli: "pi",
      workspaceId: "/home/overlogged/QuantDev",
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

  assert.equal(args[args.indexOf("--model") + 1], "deepseek-flash");
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
      PI_CLI_MODEL: "deepseek-flash",
      PI_CLI_THINKING: "xhigh"
    } as Env,
    undefined,
    runtime
  );

  const context = {
    cli: "pi" as const,
    workspaceId: "/tmp",
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
