import assert from "node:assert/strict";
import test from "node:test";

import type { ConversationItem } from "../domain/types.js";
import { ConversationStore } from "../stores/conversation-store.js";
import { ConversationDeliveryService } from "./conversation-delivery-service.js";

function createItem(overrides: Partial<ConversationItem> = {}): ConversationItem {
  const now = "2026-03-09T00:00:00.000Z";
  return {
    runId: "run_1",
    chatId: "oc_chat_1",
    sourceMessageId: "om_source_1",
    itemId: "msg_1",
    order: 1,
    kind: "assistant_text",
    source: "commentary",
    phase: "streaming",
    content: "处理中",
    details: [],
    filePaths: [],
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

test("ConversationDeliveryService streams commentary to Feishu before completion", async () => {
  const calls: string[] = [];
  const conversationStore = new ConversationStore();
  const service = new ConversationDeliveryService(
    {
      sendText: async () => {
        calls.push("sendText");
        return "om_text_1";
      },
      updateText: async () => {
        calls.push("updateText");
      },
      sendCard: async () => {
        calls.push("sendCard");
        return "om_card_1";
      },
      updateCard: async () => {
        calls.push("updateCard");
      },
      sendFile: async () => {
        calls.push("sendFile");
        return "om_file_1";
      }
    },
    conversationStore,
    1,
    console
  );

  conversationStore.save(createItem());
  await service.flush("run_1", "msg_1");

  conversationStore.update("run_1", "msg_1", {
    phase: "streaming",
    content: "处理中：先读取配置"
  });
  await service.flush("run_1", "msg_1");

  conversationStore.update("run_1", "msg_1", {
    phase: "streaming",
    content: "处理中：先读取配置，再检查实验目录"
  });
  await service.flush("run_1", "msg_1");

  conversationStore.update("run_1", "msg_1", {
    phase: "completed",
    content: "阶段总结：已完成准备工作"
  });
  await service.flush("run_1", "msg_1");

  assert.deepEqual(calls, ["sendCard", "updateCard", "updateCard", "updateCard"]);
});

test("ConversationDeliveryService still waits for final answers to complete before sending", async () => {
  const calls: string[] = [];
  const conversationStore = new ConversationStore();
  const service = new ConversationDeliveryService(
    {
      sendText: async () => {
        calls.push("sendText");
        return "om_text_1";
      },
      updateText: async () => {
        calls.push("updateText");
      },
      sendCard: async () => {
        calls.push("sendCard");
        return "om_card_1";
      },
      updateCard: async () => {
        calls.push("updateCard");
      },
      sendFile: async () => {
        calls.push("sendFile");
        return "om_file_1";
      }
    },
    conversationStore,
    1,
    console
  );

  conversationStore.save(
    createItem({
      source: "final_answer",
      phase: "streaming",
      content: "最终答案还在生成中"
    })
  );
  await service.flush("run_1", "msg_1");

  conversationStore.update("run_1", "msg_1", {
    phase: "completed",
    content: "最终答案已完成"
  });
  await service.flush("run_1", "msg_1");

  assert.deepEqual(calls, ["sendCard"]);
});

test("ConversationDeliveryService serializes concurrent flushes for the same item", async () => {
  const calls: string[] = [];
  const conversationStore = new ConversationStore();
  let releaseSend: (() => void) | undefined;
  const sendStarted = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });

  const service = new ConversationDeliveryService(
    {
      sendText: async () => "om_text_1",
      updateText: async () => {
        return undefined;
      },
      sendCard: async () => {
        calls.push("sendCard");
        await sendStarted;
        return "om_card_1";
      },
      updateCard: async () => {
        calls.push("updateCard");
      },
      sendFile: async () => "om_file_1"
    },
    conversationStore,
    1,
    console
  );

  conversationStore.save(
    createItem({
      phase: "completed",
      content: "阶段总结：已完成"
    })
  );

  const firstFlush = service.flush("run_1", "msg_1");
  const secondFlush = service.flush("run_1", "msg_1");

  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseSend?.();

  await Promise.all([firstFlush, secondFlush]);

  assert.deepEqual(calls, ["sendCard"]);
});

test("ConversationDeliveryService sends tool cards and updates them in place", async () => {
  const calls: string[] = [];
  const conversationStore = new ConversationStore();
  const service = new ConversationDeliveryService(
    {
      sendText: async () => {
        calls.push("sendText");
        return "om_text_1";
      },
      updateText: async () => {
        calls.push("updateText");
      },
      sendCard: async () => {
        calls.push("sendCard");
        return "om_card_tool_1";
      },
      updateCard: async () => {
        calls.push("updateCard");
      },
      sendFile: async () => {
        calls.push("sendFile");
        return "om_file_1";
      }
    },
    conversationStore,
    1,
    console,
    () => true
  );

  conversationStore.save(
    createItem({
      itemId: "tool_1",
      kind: "tool_card",
      source: "tool",
      phase: "streaming",
      title: "执行命令",
      command: "pnpm test",
      details: ["执行: pnpm test"]
    })
  );
  await service.flush("run_1", "tool_1");

  conversationStore.update("run_1", "tool_1", {
    phase: "streaming",
    output: "running 10 tests"
  });
  await service.flush("run_1", "tool_1");

  conversationStore.update("run_1", "tool_1", {
    phase: "completed",
    output: "10 tests passed"
  });
  await service.flush("run_1", "tool_1");

  assert.deepEqual(calls, ["sendCard", "updateCard", "updateCard"]);

  const stored = conversationStore.get("run_1", "tool_1");
  assert.equal(stored?.feishuMessageId, "om_card_tool_1");

  // Same content should not trigger another update.
  await service.flush("run_1", "tool_1");
  assert.deepEqual(calls, ["sendCard", "updateCard", "updateCard"]);
});

test("ConversationDeliveryService does not send tool cards without the opt-in flag", async () => {
  const calls: string[] = [];
  const conversationStore = new ConversationStore();
  const service = new ConversationDeliveryService(
    {
      sendText: async () => {
        calls.push("sendText");
        return "om_text_1";
      },
      updateText: async () => {
        calls.push("updateText");
      },
      sendCard: async () => {
        calls.push("sendCard");
        return "om_card_1";
      },
      updateCard: async () => {
        calls.push("updateCard");
      },
      sendFile: async () => {
        calls.push("sendFile");
        return "om_file_1";
      }
    },
    conversationStore,
    1,
    console
  );

  conversationStore.save(
    createItem({
      itemId: "tool_1",
      kind: "tool_card",
      source: "tool",
      phase: "completed",
      title: "执行命令",
      command: "pnpm test",
      output: "done"
    })
  );
  await service.flush("run_1", "tool_1");

  assert.deepEqual(calls, []);

  const optedInCalls: string[] = [];
  const optedIn = new ConversationDeliveryService(
    {
      sendText: async () => "om_text_1",
      updateText: async () => undefined,
      sendCard: async () => {
        optedInCalls.push("sendCard");
        return "om_card_tool_1";
      },
      updateCard: async () => {
        optedInCalls.push("updateCard");
      },
      sendFile: async () => "om_file_1"
    },
    conversationStore,
    1,
    console,
    () => true
  );
  await optedIn.flush("run_1", "tool_1");

  assert.deepEqual(optedInCalls, ["sendCard"]);
});

test("ConversationDeliveryService skips queued tool cards", async () => {
  const calls: string[] = [];
  const conversationStore = new ConversationStore();
  const service = new ConversationDeliveryService(
    {
      sendText: async () => {
        calls.push("sendText");
        return "om_text_1";
      },
      updateText: async () => {
        calls.push("updateText");
      },
      sendCard: async () => {
        calls.push("sendCard");
        return "om_card_1";
      },
      updateCard: async () => {
        calls.push("updateCard");
      },
      sendFile: async () => {
        calls.push("sendFile");
        return "om_file_1";
      }
    },
    conversationStore,
    1,
    console
  );

  conversationStore.save(
    createItem({
      itemId: "tool_1",
      kind: "tool_card",
      source: "tool",
      phase: "queued",
      title: "执行命令"
    })
  );

  await service.flush("run_1", "tool_1");

  assert.deepEqual(calls, []);
});

test("ConversationDeliveryService splits large assistant cards into multiple messages", async () => {
  const sentCards: string[] = [];
  const conversationStore = new ConversationStore();
  const service = new ConversationDeliveryService(
    {
      sendText: async () => "om_text_1",
      updateText: async () => {
        return undefined;
      },
      sendCard: async (input) => {
        sentCards.push(input.content);
        return `om_card_${sentCards.length}`;
      },
      updateCard: async () => {
        return undefined;
      },
      sendFile: async () => "om_file_1"
    },
    conversationStore,
    1,
    console
  );

  conversationStore.save(
    createItem({
      phase: "completed",
      source: "final_answer",
      content: [
        "总览",
        "",
        "| A | B |",
        "| --- | --- |",
        "| 1 | 2 |",
        "",
        "说明一",
        "",
        "| C | D |",
        "| --- | --- |",
        "| 3 | 4 |",
        "",
        "说明二",
        "",
        "| E | F |",
        "| --- | --- |",
        "| 5 | 6 |",
        "",
        "说明三",
        "",
        "| G | H |",
        "| --- | --- |",
        "| 7 | 8 |"
      ].join("\n")
    })
  );

  await service.flush("run_1", "msg_1");

  const stored = conversationStore.get("run_1", "msg_1");
  assert.equal(sentCards.length, 2);
  assert.deepEqual(stored?.feishuMessageIds, ["om_card_1", "om_card_2"]);
  assert.equal(stored?.feishuMessageId, "om_card_1");
  assert.ok(stored?.deliveredContentHash);
});

test("ConversationDeliveryService keeps long commentary in a single card", async () => {
  const sentCards: string[] = [];
  const conversationStore = new ConversationStore();
  const service = new ConversationDeliveryService(
    {
      sendText: async () => "om_text_1",
      updateText: async () => undefined,
      sendCard: async (input) => {
        sentCards.push(input.content);
        return `om_card_${sentCards.length}`;
      },
      updateCard: async () => undefined,
      sendFile: async () => "om_file_1"
    },
    conversationStore,
    1,
    console
  );

  conversationStore.save(
    createItem({
      source: "commentary",
      phase: "completed",
      content: `思考开始\n${"内".repeat(30_000)}\n思考结束`
    })
  );

  await service.flush("run_1", "msg_1");

  const stored = conversationStore.get("run_1", "msg_1");
  assert.equal(sentCards.length, 1);
  assert.deepEqual(stored?.feishuMessageIds, ["om_card_1"]);
  assert.match(sentCards[0] ?? "", /内容过长，已省略中间/);
  assert.match(sentCards[0] ?? "", /思考结束/);
});
