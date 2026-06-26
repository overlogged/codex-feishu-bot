import assert from "node:assert/strict";
import test from "node:test";

import type { CodexTurnContext } from "./codex-worker.js";
import { buildTurnInput } from "./app-server-worker.js";

function createContext(overrides: Partial<CodexTurnContext> = {}): CodexTurnContext {
  return {
    cli: "codex",
    workspaceId: "/workspace/project",
    executionMode: "host",
    session: {
      chatId: "oc_group_1",
      threadId: "thread_1",
      cli: "codex",
      workspaceId: "/workspace/project",
      executionMode: "host",
      updatedAt: "2026-04-04T00:00:00.000Z"
    },
    message: {
      chatId: "oc_group_1",
      chatType: "group",
      messageId: "om_1",
      senderId: "ou_1",
      senderName: "user",
      senderType: "user",
      text: "开始处理",
      mentionsBot: false,
      raw: {}
    },
    ...overrides
  };
}

test("buildTurnInput does not inject a persistent group goal for Codex turns", () => {
  const input = buildTurnInput(createContext(), "/workspace/artifacts", "/bridge.mjs");
  const text = input[0]?.text ?? "";

  assert.doesNotMatch(text, /Persistent chat goal/);
  assert.match(text, /User message:\n开始处理/);
});

test("buildTurnInput keeps Feishu bridge instructions", () => {
  const input = buildTurnInput(
    createContext({
      session: {
        chatId: "oc_group_1",
        threadId: "thread_1",
        cli: "codex",
        workspaceId: "/workspace/project",
        executionMode: "host",
        updatedAt: "2026-04-04T00:00:00.000Z"
      }
    }),
    "/workspace/artifacts",
    "/bridge.mjs"
  );

  assert.doesNotMatch(input[0]?.text ?? "", /Persistent chat goal/);
  assert.match(input[0]?.text ?? "", /Controller instructions for the Feishu bridge environment/);
});
