import assert from "node:assert/strict";
import test from "node:test";

import type { CodexTurnContext } from "./codex-worker.js";
import {
  buildTurnInput,
  normalizeCodexTurnErrorMessage,
  resolveCodexModelSettings
} from "./app-server-worker.js";

function createContext(overrides: Partial<CodexTurnContext> = {}): CodexTurnContext {
  return {
    cli: "codex",
    workspaceId: "/workspace/project",
    session: {
      chatId: "oc_group_1",
      threadId: "thread_1",
      cli: "codex",
      workspaceId: "/workspace/project",
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
        updatedAt: "2026-04-04T00:00:00.000Z"
      }
    }),
    "/workspace/artifacts",
    "/bridge.mjs"
  );

  assert.doesNotMatch(input[0]?.text ?? "", /Persistent chat goal/);
  assert.match(input[0]?.text ?? "", /Controller instructions for the Feishu bridge environment/);
});

test("resolveCodexModelSettings prefers per-binding model and thinking", () => {
  assert.deepEqual(
    resolveCodexModelSettings(
      {
        model: "gpt-5.6-sol",
        thinking: "xhigh"
      },
      {
        CODEX_APP_SERVER_MODEL: "gpt-6-astra",
        CODEX_APP_SERVER_MODEL_REASONING_EFFORT: "high"
      }
    ),
    {
      model: "gpt-5.6-sol",
      modelReasoningEffort: "xhigh"
    }
  );
});

test("resolveCodexModelSettings falls back to GPT-6 high runtime defaults", () => {
  assert.deepEqual(
    resolveCodexModelSettings(
      {},
      {
        CODEX_APP_SERVER_MODEL: "gpt-6-astra",
        CODEX_APP_SERVER_MODEL_REASONING_EFFORT: "high"
      }
    ),
    {
      model: "gpt-6-astra",
      modelReasoningEffort: "high"
    }
  );
});

test("normalizeCodexTurnErrorMessage appends account-switch guidance for quota errors", () => {
  const normalized = normalizeCodexTurnErrorMessage("You have hit your usage limit for this period");
  assert.match(normalized, /usage limit/);
  assert.match(normalized, /自动切换到其他账号/);
  assert.match(normalized, /新账号上继续/);

  assert.match(normalizeCodexTurnErrorMessage("rate_limit_exceeded: slow down"), /自动切换到其他账号/);
  assert.match(normalizeCodexTurnErrorMessage("HTTP 429 Too Many Requests"), /自动切换到其他账号/);

  assert.equal(normalizeCodexTurnErrorMessage("普通执行错误"), "普通执行错误");
});
