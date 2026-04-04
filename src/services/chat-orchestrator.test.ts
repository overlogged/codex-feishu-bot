import assert from "node:assert/strict";
import test from "node:test";

import type { CodexEvent, ConversationItem, IncomingChatMessage } from "../domain/types.js";
import type { CodexWorker } from "../integrations/codex/codex-worker.js";
import type { FeishuMessageClient } from "../integrations/feishu/feishu-message-client.js";
import { ConversationStore } from "../stores/conversation-store.js";
import { RunStore } from "../stores/run-store.js";
import { SessionStore } from "../stores/session-store.js";
import type { ChatWorkspaceResolver } from "./chat-workspace-resolver.js";
import { ChatOrchestrator } from "./chat-orchestrator.js";
import { MessageProjector } from "./message-projector.js";

function createMessage(overrides: Partial<IncomingChatMessage> = {}): IncomingChatMessage {
  return {
    chatId: "oc_group_1",
    chatType: "group",
    messageId: "om_group_1",
    senderId: "ou_user_1",
    senderName: "user-1",
    senderType: "user",
    text: "直接说一句，不带 @",
    mentionsBot: false,
    raw: {},
    ...overrides
  };
}

function createLogger() {
  return {
    info() {
      return undefined;
    },
    warn() {
      return undefined;
    },
    error() {
      return undefined;
    }
  };
}

function createFeishuClient(overrides: Partial<FeishuMessageClient> = {}): FeishuMessageClient {
  return {
    async sendText() {
      return "om_text_1";
    },
    async updateText() {
      return undefined;
    },
    async sendCard() {
      return "om_card_1";
    },
    async updateCard() {
      return undefined;
    },
    async sendFile() {
      return "om_file_1";
    },
    ...overrides
  };
}

function createWorkspaceResolver(
  overrides: Partial<ChatWorkspaceResolver> = {}
): ChatWorkspaceResolver {
  return {
    async resolve(input) {
      if (overrides.resolve) {
        return overrides.resolve(input);
      }

      return {
        ok: true,
        workspaceId: input.session?.workspaceId ?? "/workspace"
      };
    },
    async listCatalog() {
      if (overrides.listCatalog) {
        return overrides.listCatalog();
      }

      return [];
    },
    async lookupCatalogEntry(code) {
      if (overrides.lookupCatalogEntry) {
        return overrides.lookupCatalogEntry(code);
      }

      return undefined;
    },
    async bindGroupWorkspace(input) {
      if (overrides.bindGroupWorkspace) {
        return overrides.bindGroupWorkspace(input);
      }

      return {
        ok: false,
        reason: "invalid_code",
        detail: "编号不存在",
        configFilePath: "/workspace/.codex-feishu-bot/chat-workspaces.json"
      };
    }
  };
}

test("ChatOrchestrator accepts group messages without mentions", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  const scheduledItemIds: string[] = [];
  let runTurnCalls = 0;
  let resolveTurn: (() => void) | undefined;
  const turnCompleted = new Promise<void>((resolve) => {
    resolveTurn = resolve;
  });

  const codexWorker: CodexWorker = {
    async ensureThread() {
      return "thread_existing";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      runTurnCalls += 1;
      yield {
        kind: "thread_bound",
        threadId: "thread_accepted_1"
      };
      yield {
        kind: "turn_bound",
        turnId: "turn_accepted_1"
      };
      yield {
        kind: "assistant_message_started",
        itemId: "msg_final_1",
        source: "final_answer"
      };
      yield {
        kind: "assistant_message_completed",
        itemId: "msg_final_1",
        text: "收到"
      };
      resolveTurn?.();
    }
  };

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient(),
    {
      schedule(item: ConversationItem) {
        scheduledItemIds.push(item.itemId);
      },
      async flushRun() {
        return undefined;
      }
    } as never,
    projector,
    codexWorker,
    createWorkspaceResolver(),
    "/workspace",
    createLogger()
  );

  orchestrator.enqueue(createMessage());

  await turnCompleted;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(runTurnCalls, 1);
  assert.equal(runStore.list().length, 1);
  assert.deepEqual(scheduledItemIds, ["msg_final_1", "msg_final_1"]);
  assert.equal(conversationStore.list().length, 1);
  assert.equal(conversationStore.list()[0]?.content, "收到");
});

test("ChatOrchestrator steers into the active turn instead of creating a new queued run", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  const existingRun = runStore.create({
    chatId: "oc_group_1",
    threadId: "thread_active_1",
    sourceMessageId: "om_original_1"
  });
  sessionStore.save({
    chatId: "oc_group_1",
    threadId: "thread_active_1",
    workspaceId: "/workspace",
    activeRunId: existingRun.runId,
    activeTurnId: "turn_active_1",
    updatedAt: new Date().toISOString()
  });

  let steerCalls = 0;
  let runTurnCalls = 0;
  let resolveSteer: (() => void) | undefined;
  const steerCompleted = new Promise<void>((resolve) => {
    resolveSteer = resolve;
  });

  const codexWorker: CodexWorker = {
    async ensureThread() {
      return "thread_active_1";
    },
    async steerTurn(context) {
      steerCalls += 1;
      assert.equal(context.threadId, "thread_active_1");
      assert.equal(context.turnId, "turn_active_1");
      assert.equal(context.message.messageId, "om_group_steer_1");
      resolveSteer?.();
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      runTurnCalls += 1;
    }
  };

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient(),
    {
      schedule() {
        return undefined;
      },
      async flushRun() {
        return undefined;
      }
    } as never,
    projector,
    codexWorker,
    createWorkspaceResolver(),
    "/workspace",
    createLogger()
  );

  orchestrator.enqueue(
    createMessage({
      messageId: "om_group_steer_1",
      text: "这条应该直接补充给正在运行的 turn"
    })
  );

  await steerCompleted;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(steerCalls, 1);
  assert.equal(runTurnCalls, 0);
  assert.equal(runStore.list().length, 1);
  assert.equal(runStore.list()[0]?.sourceMessageId, "om_group_steer_1");
});

test("ChatOrchestrator ignores app-sent group messages to avoid loops", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  let runTurnCalls = 0;

  const codexWorker: CodexWorker = {
    async ensureThread() {
      return "thread_existing";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      runTurnCalls += 1;
      yield {
        kind: "run_status",
        status: "completed"
      };
    }
  };

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient(),
    {
      schedule() {
        return undefined;
      },
      async flushRun() {
        return undefined;
      }
    } as never,
    projector,
    codexWorker,
    createWorkspaceResolver(),
    "/workspace",
    createLogger()
  );

  orchestrator.enqueue(
    createMessage({
      messageId: "om_bot_1",
      senderId: "cli_bot_1",
      senderName: "codex",
      senderType: "app",
      text: "机器人自己发的话"
    })
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(runTurnCalls, 0);
  assert.equal(runStore.list().length, 0);
  assert.equal(conversationStore.list().length, 0);
});

test("ChatOrchestrator ignores duplicated incoming message ids", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  let runTurnCalls = 0;
  let resolveTurn: (() => void) | undefined;
  const turnCompleted = new Promise<void>((resolve) => {
    resolveTurn = resolve;
  });

  const codexWorker: CodexWorker = {
    async ensureThread() {
      return "thread_existing";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      runTurnCalls += 1;
      yield {
        kind: "thread_bound",
        threadId: "thread_existing"
      };
      yield {
        kind: "turn_bound",
        turnId: "turn_existing"
      };
      yield {
        kind: "assistant_message_started",
        itemId: "msg_final_duplicate",
        source: "final_answer"
      };
      yield {
        kind: "assistant_message_completed",
        itemId: "msg_final_duplicate",
        text: "只发一次"
      };
      resolveTurn?.();
    }
  };

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient(),
    {
      schedule() {
        return undefined;
      },
      async flushRun() {
        return undefined;
      }
    } as never,
    projector,
    codexWorker,
    createWorkspaceResolver(),
    "/workspace",
    createLogger()
  );

  const message = createMessage({
    messageId: "om_duplicate_1",
    text: "同一条飞书消息被重复投递"
  });

  orchestrator.enqueue(message);
  orchestrator.enqueue(message);

  await turnCompleted;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(runTurnCalls, 1);
  assert.equal(runStore.list().length, 1);
  assert.equal(conversationStore.list().length, 1);
});

test("ChatOrchestrator rejects group messages when workspace is not configured", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  let runTurnCalls = 0;
  const sentTexts: string[] = [];

  const codexWorker: CodexWorker = {
    async ensureThread() {
      return "thread_should_not_start";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      runTurnCalls += 1;
    }
  };

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient({
      async sendText(input) {
        sentTexts.push(input.content);
        return "om_text_config_required";
      }
    }),
    {
      schedule() {
        return undefined;
      },
      async flushRun() {
        return undefined;
      }
    } as never,
    projector,
    codexWorker,
    createWorkspaceResolver({
      resolve: async () => ({
      ok: false,
      reason: "group_workspace_unconfigured",
      configFilePath: "/workspace/.codex-feishu-bot/chat-workspaces.json",
      chatId: "oc_group_1",
      detail: "请先配置工作区"
      })
    }),
    "/workspace",
    createLogger()
  );

  orchestrator.enqueue(createMessage());

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(runTurnCalls, 0);
  assert.equal(runStore.list().length, 0);
  assert.deepEqual(sentTexts, ["请先配置工作区"]);
});

test("ChatOrchestrator lists workspace catalog in direct chats without starting a run", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  let runTurnCalls = 0;
  const sentTexts: string[] = [];

  const codexWorker: CodexWorker = {
    async ensureThread() {
      return "thread_should_not_start";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      runTurnCalls += 1;
    }
  };

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient({
      async sendText(input) {
        sentTexts.push(input.content);
        return "om_text_workspace_catalog";
      }
    }),
    {
      schedule() {
        return undefined;
      },
      async flushRun() {
        return undefined;
      }
    } as never,
    projector,
    codexWorker,
    createWorkspaceResolver({
      async listCatalog() {
        return [
          {
            code: "1",
            workspace: "Quant/project-a",
            workspaceId: "/home/overlogged/Quant/project-a"
          },
          {
            code: "2",
            workspace: "Quant/project-b",
            workspaceId: "/home/overlogged/Quant/project-b"
          }
        ];
      }
    }),
    "/home/overlogged",
    createLogger()
  );

  orchestrator.enqueue(
    createMessage({
      chatId: "ou_p2p_1",
      chatType: "p2p",
      messageId: "om_p2p_workspace_1",
      text: "工作区"
    })
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(runTurnCalls, 0);
  assert.equal(runStore.list().length, 0);
  assert.equal(sentTexts.length, 1);
  assert.match(sentTexts[0] ?? "", /1\. Quant\/project-a/);
  assert.match(sentTexts[0] ?? "", /@机器人 发送编号/);
});

test("ChatOrchestrator binds group workspace when mentioned with a numeric code", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  let runTurnCalls = 0;
  const sentTexts: string[] = [];

  const codexWorker: CodexWorker = {
    async ensureThread() {
      return "thread_should_not_start";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      runTurnCalls += 1;
    }
  };

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient({
      async sendText(input) {
        sentTexts.push(input.content);
        return "om_text_group_bound";
      }
    }),
    {
      schedule() {
        return undefined;
      },
      async flushRun() {
        return undefined;
      }
    } as never,
    projector,
    codexWorker,
    createWorkspaceResolver({
      async bindGroupWorkspace() {
        return {
          ok: true,
          entry: {
            code: "12",
            workspace: "Quant/project-a",
            workspaceId: "/home/overlogged/Quant/project-a"
          },
          configFilePath: "/home/overlogged/.codex-feishu-bot/chat-workspaces.json"
        };
      }
    }),
    "/home/overlogged",
    createLogger()
  );

  orchestrator.enqueue(
    createMessage({
      messageId: "om_group_bind_1",
      mentionsBot: true,
      text: "@托帕 12"
    })
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(runTurnCalls, 0);
  assert.equal(runStore.list().length, 0);
  assert.deepEqual(sentTexts, [
    "已将这个群绑定到工作区 12: Quant/project-a\n后续这个群里的任务都会从 /home/overlogged/Quant/project-a 启动。"
  ]);
});
