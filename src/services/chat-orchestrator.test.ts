import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  CodexEvent,
  ConversationItem,
  IncomingChatMessage,
  ScheduledTaskRecord
} from "../domain/types.js";
import type { CodexWorker } from "../integrations/codex/codex-worker.js";
import type { FeishuMessageClient } from "../integrations/feishu/feishu-message-client.js";
import { ConversationStore } from "../stores/conversation-store.js";
import { RunStore } from "../stores/run-store.js";
import { SessionStore } from "../stores/session-store.js";
import type { ChatWorkspaceResolver } from "./chat-workspace-resolver.js";
import { ChatOrchestrator } from "./chat-orchestrator.js";
import type { GroupControlAgent, GroupControlIntent } from "./group-control-agent.js";
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
        workspaceId: input.session?.workspaceId ?? "/workspace",
        cli: input.session?.cli ?? "codex",
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

function createGroupControlAgent(
  overrides: Partial<GroupControlAgent> = {}
): GroupControlAgent {
  return {
    async interpret(message, context, options) {
      return (
        overrides.interpret?.(message, context, options) ?? {
          intents: [
            {
              kind: "help",
              detail: "unsupported in test"
            }
          ],
          threadId: "thread_control_default",
          cli: "codex"
        }
      );
    }
  };
}

function createControlResult(
  intent: GroupControlIntent | GroupControlIntent[],
  threadId = "thread_control_1"
) {
  return {
    intents: Array.isArray(intent) ? intent : [intent],
    threadId,
    cli: "codex" as const
  };
}

function createControlSession(overrides: Partial<IncomingChatMessage> = {}) {
  return createMessage({
    mentionsBot: true,
    text: "@托帕 看看这个群现在绑到哪",
    ...overrides
  });
}

function assertMentionedControlReply(content: string | undefined, senderId: string, senderName: string) {
  assert.match(content ?? "", new RegExp(`<at user_id="${senderId}">${senderName}</at>`));
}

function createNoopCodexWorker(): CodexWorker {
  return {
    async ensureThread() {
      return "thread_should_not_start";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      return undefined;
    }
  };
}

function createNoopDeliveryService() {
  return {
    schedule() {
      return undefined;
    },
    async flushRun() {
      return undefined;
    }
  } as never;
}

function createBoundWorkspaceResolver() {
  return createWorkspaceResolver({
    async resolve() {
      return {
        ok: true,
        workspaceId: "/home/overlogged/Quant",
        cli: "codex",
      };
    }
  });
}

function createScheduleService(overrides: {
  list?: () => ScheduledTaskRecord[];
  listByChat?: (chatId: string) => ScheduledTaskRecord[];
  createTask?: (input: {
    chatId: string;
    cron: string;
    prompt: string;
    createdById?: string;
    createdByName?: string;
  }) =>
    | {
        ok: true;
        task: ScheduledTaskRecord;
      }
    | {
        ok: false;
        detail: string;
      };
  createOneTimeTask?: (input: {
    chatId: string;
    runAt?: string;
    prompt: string;
    createdById?: string;
    createdByName?: string;
  }) =>
    | {
        ok: true;
        task: ScheduledTaskRecord;
      }
    | {
        ok: false;
        detail: string;
      };
  updateTask?: (input: {
    chatId: string;
    taskId: string;
    cron?: string;
    prompt?: string;
  }) =>
    | {
        ok: true;
        task: ScheduledTaskRecord;
      }
    | {
        ok: false;
        detail: string;
      };
  pauseTask?: (
    chatId: string,
    taskId: string,
    reason?: string
  ) =>
    | {
        ok: true;
        task: ScheduledTaskRecord;
      }
    | {
        ok: false;
        detail: string;
      };
  resumeTask?: (
    chatId: string,
    taskId: string
  ) =>
    | {
        ok: true;
        task: ScheduledTaskRecord;
      }
    | {
        ok: false;
        detail: string;
      };
  deleteTask?: (
    chatId: string,
    taskId: string
  ) =>
    | {
        ok: true;
        task: ScheduledTaskRecord;
      }
    | {
        ok: false;
        detail: string;
      };
} = {}) {
  return {
    list() {
      return overrides.list?.() ?? [];
    },
    listByChat(chatId: string) {
      return overrides.listByChat?.(chatId) ?? [];
    },
    createTask(input: {
      chatId: string;
      cron: string;
      prompt: string;
      createdById?: string;
      createdByName?: string;
    }) {
      return (
        overrides.createTask?.(input) ?? {
          ok: false,
          detail: "not implemented"
        }
      );
    },
    createOneTimeTask(input: {
      chatId: string;
      runAt?: string;
      prompt: string;
      createdById?: string;
      createdByName?: string;
    }) {
      return (
        overrides.createOneTimeTask?.(input) ?? {
          ok: false,
          detail: "not implemented"
        }
      );
    },
    updateTask(input: {
      chatId: string;
      taskId: string;
      cron?: string;
      prompt?: string;
    }) {
      return (
        overrides.updateTask?.(input) ?? {
          ok: false,
          detail: "not implemented"
        }
      );
    },
    pauseTask(chatId: string, taskId: string, reason?: string) {
      return (
        overrides.pauseTask?.(chatId, taskId, reason) ?? {
          ok: false,
          detail: "not implemented"
        }
      );
    },
    resumeTask(chatId: string, taskId: string) {
      return (
        overrides.resumeTask?.(chatId, taskId) ?? {
          ok: false,
          detail: "not implemented"
        }
      );
    },
    deleteTask(chatId: string, taskId: string) {
      return (
        overrides.deleteTask?.(chatId, taskId) ?? {
          ok: false,
          detail: "not implemented"
        }
      );
    }
  } as never;
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
    createScheduleService(),
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
    cli: "codex",
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
    createScheduleService(),
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

test("ChatOrchestrator interrupts the active Kimi turn and runs the latest message", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  runStore.save({
    runId: "run_active",
    chatId: "oc_group_1",
    threadId: "thread_kimi_1",
    sourceMessageId: "om_original_1",
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  sessionStore.save({
    chatId: "oc_group_1",
    threadId: "thread_kimi_1",
    cli: "kimi",
    workspaceId: "/workspace",
    activeRunId: "run_active",
    activeTurnId: "turn_kimi_active_1",
    updatedAt: new Date().toISOString()
  });

  let interruptCalls = 0;
  let runTurnCalls = 0;
  const codexWorker: CodexWorker = {
    supportsSteer() {
      return false;
    },
    async ensureThread() {
      return "thread_kimi_1";
    },
    async interruptTurn(context) {
      interruptCalls += 1;
      assert.equal(context.threadId, "thread_kimi_1");
      assert.equal(context.turnId, "turn_kimi_active_1");
      assert.equal(context.interruptionMessage, "当前任务已被后续消息中断。");
    },
    async *runTurn(context): AsyncGenerator<CodexEvent> {
      runTurnCalls += 1;
      assert.equal(context.threadId, "thread_kimi_1");
      assert.equal(context.message.messageId, "om_group_kimi_followup_1");
      yield {
        kind: "thread_bound",
        threadId: "thread_kimi_1"
      };
      yield {
        kind: "turn_bound",
        turnId: "turn_kimi_replacement_1"
      };
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
    createNoopDeliveryService(),
    projector,
    codexWorker,
    createWorkspaceResolver(),
    createScheduleService(),
    "/workspace",
    createLogger()
  );

  orchestrator.enqueue(
    createMessage({
      messageId: "om_group_kimi_followup_1",
      text: "这条新消息应该直接接管当前 Kimi turn"
    })
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(interruptCalls, 1);
  assert.equal(runTurnCalls, 1);
  assert.equal(runStore.get("run_active")?.status, "failed");
  assert.equal(runStore.get("run_active")?.errorMessage, "当前任务已被后续消息中断。");
  assert.equal(runStore.list().length, 2);
  assert.equal(runStore.list()[1]?.sourceMessageId, "om_group_kimi_followup_1");
  assert.equal(sessionStore.get("oc_group_1")?.activeRunId, undefined);
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
    createScheduleService(),
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
    createScheduleService(),
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

test("ChatOrchestrator keeps the stored private-chat display name when a system message is injected", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  let resolveTurn: (() => void) | undefined;
  const turnCompleted = new Promise<void>((resolve) => {
    resolveTurn = resolve;
  });

  sessionStore.save({
    chatId: "oc_p2p_1",
    chatType: "p2p",
    chatName: "主管",
    chatDisplayName: "主管",
    threadId: "thread_p2p_1",
    cli: "codex",
    workspaceId: "/workspace",
    lastUserMessagePreview: "请帮我继续跟进昨天的任务",
    updatedAt: new Date().toISOString()
  });

  const codexWorker: CodexWorker = {
    async ensureThread() {
      return "thread_p2p_1";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      yield {
        kind: "thread_bound",
        threadId: "thread_p2p_1"
      };
      yield {
        kind: "turn_bound",
        turnId: "turn_p2p_1"
      };
      yield {
        kind: "assistant_message_started",
        itemId: "msg_p2p_1",
        source: "final_answer"
      };
      yield {
        kind: "assistant_message_completed",
        itemId: "msg_p2p_1",
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
    createScheduleService(),
    "/workspace",
    createLogger()
  );

  orchestrator.enqueue(
    createMessage({
      chatId: "oc_p2p_1",
      chatType: "p2p",
      messageId: "om_p2p_system_1",
      senderId: "system:agent-manager:test",
      senderName: "monitor",
      senderType: "system",
      text: "来自monitor说：\n请继续"
    })
  );

  await turnCompleted;
  await new Promise((resolve) => setTimeout(resolve, 0));

  const session = sessionStore.get("oc_p2p_1");
  assert.equal(session?.chatDisplayName, "主管");
  assert.equal(session?.chatName, "主管");
  assert.equal(session?.lastSenderName, "monitor");
  assert.equal(session?.lastUserMessagePreview, "请帮我继续跟进昨天的任务");
});

test("ChatOrchestrator toggles tool card delivery per session with the 工具卡片 command", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  const sentTexts: string[] = [];

  sessionStore.save({
    chatId: "oc_p2p_1",
    chatType: "p2p",
    threadId: "thread_p2p_1",
    cli: "codex",
    workspaceId: "/home/overlogged",
    updatedAt: new Date().toISOString()
  });

  const codexWorker: CodexWorker = {
    async ensureThread() {
      return "thread_should_not_start";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      return undefined;
    }
  };

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient({
      async sendText(input) {
        sentTexts.push(input.content);
        return "om_text_tool_cards";
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
    createWorkspaceResolver({}),
    createScheduleService(),
    "/home/overlogged",
    createLogger()
  );

  orchestrator.enqueue(
    createMessage({
      chatId: "oc_p2p_1",
      chatType: "p2p",
      messageId: "om_tool_cards_status_1",
      text: "工具卡片"
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(sentTexts[0] ?? "", /当前是关闭状态/);
  assert.equal(sessionStore.get("oc_p2p_1")?.toolCardsEnabled, undefined);

  orchestrator.enqueue(
    createMessage({
      chatId: "oc_p2p_1",
      chatType: "p2p",
      messageId: "om_tool_cards_on_1",
      text: "工具卡片 开"
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sessionStore.get("oc_p2p_1")?.toolCardsEnabled, true);
  assert.match(sentTexts[1] ?? "", /已为这个会话开启工具卡片推送/);

  orchestrator.enqueue(
    createMessage({
      chatId: "oc_p2p_1",
      chatType: "p2p",
      messageId: "om_tool_cards_off_1",
      text: "工具卡片 关"
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sessionStore.get("oc_p2p_1")?.toolCardsEnabled, false);
  assert.match(sentTexts[2] ?? "", /已为这个会话关闭工具卡片推送/);
});

test("ChatOrchestrator asks for a session before setting the tool cards switch", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  const sentTexts: string[] = [];

  const codexWorker: CodexWorker = {
    async ensureThread() {
      return "thread_should_not_start";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      return undefined;
    }
  };

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient({
      async sendText(input) {
        sentTexts.push(input.content);
        return "om_text_tool_cards";
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
    createWorkspaceResolver({}),
    createScheduleService(),
    "/home/overlogged",
    createLogger()
  );

  orchestrator.enqueue(
    createMessage({
      chatId: "oc_p2p_new",
      chatType: "p2p",
      messageId: "om_tool_cards_on_new",
      text: "工具卡片 开"
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(sessionStore.get("oc_p2p_new"), undefined);
  assert.match(sentTexts[0] ?? "", /先绑定工作区或先聊一句/);
});

test("ChatOrchestrator interrupts a Kimi turn that is blocked on a background wait and runs the latest message", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  runStore.save({
    runId: "run_active",
    chatId: "oc_group_1",
    threadId: "thread_kimi_1",
    sourceMessageId: "om_original_1",
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  sessionStore.save({
    chatId: "oc_group_1",
    threadId: "thread_kimi_1",
    cli: "kimi",
    workspaceId: "/workspace",
    activeRunId: "run_active",
    activeTurnId: "turn_kimi_active_1",
    updatedAt: new Date().toISOString()
  });

  let steerCalls = 0;
  let interruptCalls = 0;
  let runTurnCalls = 0;
  const codexWorker: CodexWorker = {
    supportsSteer() {
      return true;
    },
    async ensureThread() {
      return "thread_kimi_1";
    },
    async steerTurn() {
      steerCalls += 1;
      throw Object.assign(new Error("Kimi 当前回合正阻塞在等待后台任务。"), {
        code: "KIMI_TURN_BLOCKED_WAIT"
      });
    },
    async interruptTurn(context) {
      interruptCalls += 1;
      assert.equal(context.turnId, "turn_kimi_active_1");
      assert.equal(context.interruptionMessage, "当前任务已被后续消息中断。");
    },
    async *runTurn(context): AsyncGenerator<CodexEvent> {
      runTurnCalls += 1;
      assert.equal(context.message.messageId, "om_group_kimi_blocked_1");
      yield {
        kind: "thread_bound",
        threadId: "thread_kimi_1"
      };
      yield {
        kind: "turn_bound",
        turnId: "turn_kimi_replacement_1"
      };
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
    createNoopDeliveryService(),
    projector,
    codexWorker,
    createWorkspaceResolver(),
    createScheduleService(),
    "/workspace",
    createLogger()
  );

  orchestrator.enqueue(
    createMessage({
      messageId: "om_group_kimi_blocked_1",
      text: "怎么样了"
    })
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(steerCalls, 1);
  assert.equal(interruptCalls, 1);
  assert.equal(runTurnCalls, 1);
  assert.equal(runStore.get("run_active")?.status, "failed");
  assert.equal(runStore.get("run_active")?.errorMessage, "当前任务已被后续消息中断。");
  assert.equal(runStore.list().length, 2);
  assert.equal(runStore.list()[1]?.sourceMessageId, "om_group_kimi_blocked_1");
});

for (const cli of ["pi", "claude"] as const) {
  test(`ChatOrchestrator interrupts the active ${cli} turn and runs the latest message`, async () => {
    const sessionStore = new SessionStore();
    const runStore = new RunStore();
    const conversationStore = new ConversationStore();
    const projector = new MessageProjector(runStore, conversationStore);
    runStore.save({
      runId: "run_active",
      chatId: "oc_group_1",
      threadId: `thread_${cli}_1`,
      sourceMessageId: "om_original_1",
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    sessionStore.save({
      chatId: "oc_group_1",
      threadId: `thread_${cli}_1`,
      cli,
      workspaceId: "/workspace",
      activeRunId: "run_active",
      activeTurnId: `turn_${cli}_active_1`,
      updatedAt: new Date().toISOString()
    });

    let interruptCalls = 0;
    let runTurnCalls = 0;
    const codexWorker: CodexWorker = {
      supportsSteer() {
        return false;
      },
      async ensureThread() {
        return `thread_${cli}_1`;
      },
      async interruptTurn(context) {
        interruptCalls += 1;
        assert.equal(context.threadId, `thread_${cli}_1`);
        assert.equal(context.turnId, `turn_${cli}_active_1`);
        assert.equal(context.interruptionMessage, "当前任务已被后续消息中断。");
      },
      async *runTurn(context): AsyncGenerator<CodexEvent> {
        runTurnCalls += 1;
        assert.equal(context.message.messageId, `om_group_${cli}_followup_1`);
        yield {
          kind: "thread_bound",
          threadId: `thread_${cli}_1`
        };
        yield {
          kind: "turn_bound",
          turnId: `turn_${cli}_replacement_1`
        };
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
      createNoopDeliveryService(),
      projector,
      codexWorker,
      createWorkspaceResolver(),
      createScheduleService(),
      "/workspace",
      createLogger()
    );

    orchestrator.enqueue(
      createMessage({
        messageId: `om_group_${cli}_followup_1`,
        text: `这条新消息应该直接接管当前 ${cli} turn`
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(interruptCalls, 1);
    assert.equal(runTurnCalls, 1);
    assert.equal(runStore.get("run_active")?.status, "failed");
    assert.equal(runStore.get("run_active")?.errorMessage, "当前任务已被后续消息中断。");
    assert.equal(runStore.list().length, 2);
    assert.equal(runStore.list()[1]?.sourceMessageId, `om_group_${cli}_followup_1`);
  });
}

test("ChatOrchestrator rejects group messages when workspace is not configured", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  let runTurnCalls = 0;
  const sentTexts: string[] = [];
  const replyMessageIds: string[] = [];

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
    createScheduleService(),
    "/workspace",
    createLogger()
  );

  orchestrator.enqueue(createMessage());

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(runTurnCalls, 0);
  assert.equal(runStore.list().length, 0);
  assert.deepEqual(sentTexts, ["请先配置工作区"]);
});

test("ChatOrchestrator surfaces ensureThread failures for reusable sessions", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  const scheduledItemIds: string[] = [];
  let ensureThreadCalls = 0;
  let runTurnCalls = 0;

  sessionStore.save({
    chatId: "oc_group_1",
    chatType: "group",
    chatName: "quant-group",
    chatDisplayName: "quant-group",
    threadId: "thread_existing_1",
    cli: "codex",
    workspaceId: "/home/overlogged/QuantDev",
    updatedAt: new Date().toISOString()
  });

  const codexWorker: CodexWorker = {
    async ensureThread() {
      ensureThreadCalls += 1;
      throw new Error("Codex app-server 当前不可用：连接失败。");
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
      schedule(item: ConversationItem) {
        scheduledItemIds.push(item.itemId);
      },
      async flushRun() {
        return undefined;
      }
    } as never,
    projector,
    codexWorker,
    createWorkspaceResolver({
      async resolve() {
        return {
          ok: true,
          workspaceId: "/home/overlogged/QuantDev",
          cli: "codex"
        };
      }
    }),
    createScheduleService(),
    "/home/overlogged",
    createLogger()
  );

  orchestrator.enqueue(
    createMessage({
      messageId: "om_ensure_thread_error_1",
      text: "继续"
    })
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(ensureThreadCalls, 1);
  assert.equal(runTurnCalls, 0);
  assert.equal(runStore.list().length, 1);
  assert.equal(runStore.list()[0]?.status, "failed");
  assert.match(runStore.list()[0]?.errorMessage ?? "", /Codex app-server 当前不可用/);
  assert.deepEqual(scheduledItemIds, [`error:${runStore.list()[0]!.runId}`]);
  assert.match(conversationStore.list()[0]?.content ?? "", /Codex app-server 当前不可用/);
  assert.equal(sessionStore.get("oc_group_1")?.activeRunId, undefined);
  assert.equal(sessionStore.get("oc_group_1")?.threadId, "thread_existing_1");
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
    createScheduleService(),
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
  assert.match(sentTexts[0] ?? "", /@机器人 把这个群绑定到 codex 的 2 号目录/);
});

test("ChatOrchestrator binds group workspace when mentioned with a numeric code", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  let runTurnCalls = 0;
  const sentTexts: string[] = [];
  const replyMessageIds: Array<string | undefined> = [];
  const replyInThreads: Array<boolean | undefined> = [];

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
        replyMessageIds.push(input.replyToMessageId);
        replyInThreads.push(input.replyInThread);
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
          cli: "codex",
          entry: {
            code: "12",
            workspace: "Quant/project-a",
            workspaceId: "/home/overlogged/Quant/project-a"
          },
          configFilePath: "/home/overlogged/.codex-feishu-bot/chat-workspaces.json"
        };
      }
    }),
    createScheduleService(),
    "/home/overlogged",
    createLogger(),
    createGroupControlAgent({
      async interpret(_message, _context, options) {
        assert.equal(options?.controlThreadId, undefined);
        return createControlResult({
          kind: "bind_workspace",
          cli: "codex",
          code: "12"
        });
      }
    })
  );

  orchestrator.enqueue(
    createControlSession({
      messageId: "om_group_bind_1",
      text: "@托帕 12"
    })
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(runTurnCalls, 0);
  assert.equal(runStore.list().length, 0);
  assert.deepEqual(replyMessageIds, [undefined]);
  assert.deepEqual(replyInThreads, [undefined]);
  assertMentionedControlReply(sentTexts[0], "ou_user_1", "user-1");
  assert.match(sentTexts[0] ?? "", /已将这个群绑定到 Codex CLI 工作区 12: Quant\/project-a/);
  assert.match(sentTexts[0] ?? "", /群里 @机器人的消息会继续进入这个群单独复用的配置线程/);
  assert.equal(sessionStore.get("oc_group_1")?.cli, "codex");
  assert.equal(sessionStore.get("oc_group_1")?.controlThreadId, "thread_control_1");
  assert.equal(sessionStore.get("oc_group_1")?.controlReplyToMessageId, undefined);
});

test("ChatOrchestrator binds group workspace with an explicit cli selector", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  const sentTexts: string[] = [];
  let bindInput:
    | {
        chatId: string;
        cli: "codex" | "claude" | "kimi" | "pi";
        code: string;
      }
    | undefined;

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient({
      async sendText(input) {
        sentTexts.push(input.content);
        return "om_text_group_bound_claude";
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
    {
      async ensureThread() {
        return "thread_should_not_start";
      },
      async *runTurn(): AsyncGenerator<CodexEvent> {}
    },
    createWorkspaceResolver({
      async bindGroupWorkspace(input) {
        bindInput = input;
        return {
          ok: true,
          cli: "claude",
          entry: {
            code: "12",
            workspace: "Quant/project-a",
            workspaceId: "/home/overlogged/Quant/project-a"
          },
          configFilePath: "/home/overlogged/.codex-feishu-bot/chat-workspaces.json"
        };
      }
    }),
    createScheduleService(),
    "/home/overlogged",
    createLogger(),
    createGroupControlAgent({
      async interpret() {
        return createControlResult({
          kind: "bind_workspace",
          cli: "claude",
          code: "12"
        });
      }
    })
  );

  orchestrator.enqueue(
    createControlSession({
      messageId: "om_group_bind_claude_1",
      text: "@托帕 claude 12"
    })
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(bindInput, {
    chatId: "oc_group_1",
    cli: "claude",
    code: "12",
    provider: undefined,
    model: undefined,
    thinking: undefined
  });
  assert.match(sentTexts[0] ?? "", /Claude CLI/);
});



test("ChatOrchestrator creates a group scheduled task without starting a run", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  let runTurnCalls = 0;
  const sentTexts: string[] = [];
  let createTaskInput:
    | {
        chatId: string;
        cron: string;
        prompt: string;
        createdById?: string;
        createdByName?: string;
      }
    | undefined;

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
        return "om_text_schedule_create";
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
      async resolve() {
        return {
          ok: true,
          workspaceId: "/home/overlogged/Quant",
          cli: "codex",
        };
      }
    }),
    createScheduleService({
      createTask(input) {
        createTaskInput = input;
        return {
          ok: true,
          task: {
            chatId: input.chatId,
            taskId: "3",
            cron: input.cron,
            prompt: input.prompt,
            status: "enabled",
            createdAt: "2026-04-04T00:00:00.000Z",
            updatedAt: "2026-04-04T00:00:00.000Z",
            nextRunAt: "2026-04-04T01:00:00.000Z",
            createdById: input.createdById,
            createdByName: input.createdByName
          }
        };
      }
    }),
    "/home/overlogged",
    createLogger(),
    createGroupControlAgent({
      async interpret() {
        return createControlResult({
          kind: "create_schedule",
          cron: "0 9 * * 1-5",
          prompt: "生成工作日报"
        });
      }
    })
  );

  orchestrator.enqueue(
    createControlSession({
      messageId: "om_group_schedule_add_1",
      text: "@托帕 定时任务 添加 0 9 * * 1-5 | 生成工作日报"
    })
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(runTurnCalls, 0);
  assert.equal(runStore.list().length, 0);
  assert.deepEqual(createTaskInput, {
    chatId: "oc_group_1",
    cron: "0 9 * * 1-5",
    prompt: "生成工作日报",
    createdById: "ou_user_1",
    createdByName: "user-1"
  });
  assert.equal(sentTexts.length, 1);
  assert.match(sentTexts[0] ?? "", /已创建这个群的定时任务 3/);
  assert.match(sentTexts[0] ?? "", /工作区：\/home\/overlogged\/Quant/);
});

test("ChatOrchestrator creates a group one-time task without starting a run", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  let runTurnCalls = 0;
  const sentTexts: string[] = [];
  let createOneTimeTaskInput:
    | {
        chatId: string;
        runAt?: string;
        prompt: string;
        createdById?: string;
        createdByName?: string;
      }
    | undefined;

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
        return "om_text_one_time_schedule_create";
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
      async resolve() {
        return {
          ok: true,
          workspaceId: "/home/overlogged/Quant",
          cli: "codex",
        };
      }
    }),
    createScheduleService({
      createOneTimeTask(input) {
        createOneTimeTaskInput = input;
        return {
          ok: true,
          task: {
            chatId: input.chatId,
            taskId: "5",
            kind: "once",
            runAt: input.runAt,
            prompt: input.prompt,
            status: "enabled",
            createdAt: "2026-07-01T09:00:00.000Z",
            updatedAt: "2026-07-01T09:00:00.000Z",
            nextRunAt: "2026-07-01T10:30:00.000Z",
            createdById: input.createdById,
            createdByName: input.createdByName
          }
        };
      }
    }),
    "/home/overlogged",
    createLogger(),
    createGroupControlAgent({
      async interpret() {
        return createControlResult({
          kind: "create_one_time_schedule",
          runAt: "2026-07-01T18:30:00+08:00",
          prompt: "检查线上流水线"
        });
      }
    })
  );

  orchestrator.enqueue(
    createControlSession({
      messageId: "om_group_schedule_once_1",
      text: "@托帕 临时任务：今天 18:30 检查线上流水线"
    })
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(runTurnCalls, 0);
  assert.equal(runStore.list().length, 0);
  assert.deepEqual(createOneTimeTaskInput, {
    chatId: "oc_group_1",
    runAt: "2026-07-01T18:30:00+08:00",
    prompt: "检查线上流水线",
    createdById: "ou_user_1",
    createdByName: "user-1"
  });
  assert.equal(sentTexts.length, 1);
  assert.match(sentTexts[0] ?? "", /已创建这个群的临时任务 5/);
  assert.match(sentTexts[0] ?? "", /执行一次后会自动删除/);
  assert.match(sentTexts[0] ?? "", /工作区：\/home\/overlogged\/Quant/);
});

test("ChatOrchestrator executes multiple control actions in order", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  const sentTexts: string[] = [];
  const replyMessageIds: Array<string | undefined> = [];
  let bound = false;
  let createTaskInput:
    | {
        chatId: string;
        cron: string;
        prompt: string;
        createdById?: string;
        createdByName?: string;
      }
    | undefined;

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient({
      async sendText(input) {
        sentTexts.push(input.content);
        replyMessageIds.push(input.replyToMessageId);
        return `om_text_multi_${sentTexts.length}`;
      }
    }),
    createNoopDeliveryService(),
    projector,
    createNoopCodexWorker(),
    createWorkspaceResolver({
      async resolve() {
        if (!bound) {
          return {
            ok: false,
            reason: "group_workspace_unconfigured",
            detail: "这个群还没有绑定工作区。",
            configFilePath: "/home/overlogged/.codex-feishu-bot/chat-workspaces.json",
            chatId: "oc_group_1"
          };
        }

        return {
          ok: true,
          workspaceId: "/home/overlogged/Quant",
          cli: "codex",
        };
      },
      async bindGroupWorkspace() {
        bound = true;
        return {
          ok: true,
          cli: "codex",
          entry: {
            code: "12",
            workspace: "Quant",
            workspaceId: "/home/overlogged/Quant"
          },
          configFilePath: "/home/overlogged/.codex-feishu-bot/chat-workspaces.json"
        };
      }
    }),
    createScheduleService({
      createTask(input) {
        createTaskInput = input;
        return {
          ok: true,
          task: {
            chatId: input.chatId,
            taskId: "4",
            cron: input.cron,
            prompt: input.prompt,
            status: "enabled",
            createdAt: "2026-04-04T00:00:00.000Z",
            updatedAt: "2026-04-04T00:00:00.000Z",
            nextRunAt: "2026-04-04T01:00:00.000Z",
            createdById: input.createdById,
            createdByName: input.createdByName
          }
        };
      }
    }),
    "/home/overlogged",
    createLogger(),
    createGroupControlAgent({
      async interpret() {
        return createControlResult([
          {
            kind: "bind_workspace",
            cli: "codex",
            code: "12"
          },
          {
            kind: "create_schedule",
            cron: "0 9 * * 1-5",
            prompt: "生成工作日报"
          }
        ]);
      }
    })
  );

  orchestrator.enqueue(
    createControlSession({
      messageId: "om_group_multi_action_1",
      text: "@托帕 把这个群绑定到 codex 的 12 号目录，然后工作日早上 9 点生成工作日报"
    })
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(createTaskInput, {
    chatId: "oc_group_1",
    cron: "0 9 * * 1-5",
    prompt: "生成工作日报",
    createdById: "ou_user_1",
    createdByName: "user-1"
  });
  assert.equal(sentTexts.length, 2);
  assertMentionedControlReply(sentTexts[0], "ou_user_1", "user-1");
  assert.doesNotMatch(sentTexts[1] ?? "", /<at user_id=/);
  assert.deepEqual(replyMessageIds, [undefined, undefined]);
  assert.match(sentTexts[0] ?? "", /已将这个群绑定到 Codex CLI 工作区 12: Quant/);
  assert.match(sentTexts[1] ?? "", /已创建这个群的定时任务 4/);
});

test("ChatOrchestrator routes natural-language group mentions into the reusable control thread", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  const sentTexts: string[] = [];
  const replyMessageIds: Array<string | undefined> = [];
  const replyInThreads: Array<boolean | undefined> = [];
  let groupControlInterpretCalls = 0;

  sessionStore.save({
    chatId: "oc_group_1",
    chatType: "group",
    chatName: "测试群",
    chatDisplayName: "测试群",
    threadId: "thread_group_main",
    cli: "codex",
    workspaceId: "/home/overlogged/Quant",
    controlThreadId: "thread_control_existing",
    controlReplyToMessageId: "om_group_control_root_1",
    updatedAt: new Date().toISOString()
  });

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient({
      async sendText(input) {
        sentTexts.push(input.content);
        replyMessageIds.push(input.replyToMessageId);
        replyInThreads.push(input.replyInThread);
        return "om_text_group_control_help";
      }
    }),
    createNoopDeliveryService(),
    projector,
    createNoopCodexWorker(),
    createBoundWorkspaceResolver(),
    createScheduleService(),
    "/home/overlogged",
    createLogger(),
    createGroupControlAgent({
      async interpret(_message, _context, options) {
        groupControlInterpretCalls += 1;
        assert.equal(options?.controlThreadId, "thread_control_existing");
        return createControlResult({
          kind: "help",
          detail: "请直接说你想怎么配置这个群。"
        }, "thread_control_existing");
      }
    })
  );

  orchestrator.enqueue(
    createControlSession({
      messageId: "om_group_mention_plain_1",
      text: "@托帕 帮我把这个群切到 pi 模式"
    })
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(groupControlInterpretCalls, 1);
  assert.equal(runStore.list().length, 0);
  assert.equal(sessionStore.get("oc_group_1")?.threadId, "thread_group_main");
  assert.equal(sessionStore.get("oc_group_1")?.controlThreadId, "thread_control_existing");
  assert.equal(sessionStore.get("oc_group_1")?.controlReplyToMessageId, "om_group_control_root_1");
  assert.deepEqual(replyMessageIds, [undefined]);
  assert.deepEqual(replyInThreads, [undefined]);
  assertMentionedControlReply(sentTexts[0], "ou_user_1", "user-1");
  assert.match(sentTexts[0] ?? "", /请直接说你想怎么配置这个群/);
});

test("ChatOrchestrator sets a native Codex goal and streams the goal turn", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  const sentTexts: string[] = [];
  let capturedRunObjective: string | undefined;
  let capturedEnsureLegacyGoal: string | undefined;
  let runGoalCalls = 0;
  let resolveRun: (() => void) | undefined;
  const runCompleted = new Promise<void>((resolve) => {
    resolveRun = resolve;
  });

  sessionStore.save({
    chatId: "oc_group_1",
    chatType: "group",
    threadId: "thread_group_main",
    cli: "codex",
    workspaceId: "/home/overlogged/Quant",
    controlThreadId: "thread_control_existing",
    updatedAt: new Date().toISOString()
  });

  const codexWorker: CodexWorker = {
    async ensureThread(context) {
      capturedEnsureLegacyGoal = (context.session as { goal?: string } | undefined)?.goal;
      return context.session?.threadId ?? "thread_group_main";
    },
    async *runGoal(context): AsyncGenerator<CodexEvent> {
      runGoalCalls += 1;
      capturedRunObjective = context.objective;
      yield {
        kind: "thread_bound",
        threadId: context.threadId
      };
      yield {
        kind: "turn_bound",
        turnId: "turn_goal_1"
      };
      yield {
        kind: "assistant_message_started",
        itemId: "msg_final_goal_1",
        source: "final_answer"
      };
      yield {
        kind: "assistant_message_completed",
        itemId: "msg_final_goal_1",
        text: "收到 goal"
      };
      yield {
        kind: "run_status",
        status: "completed"
      };
      resolveRun?.();
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      throw new Error("runTurn should not be used for native goal");
    }
  };

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient({
      async sendText(input) {
        sentTexts.push(input.content);
        return `om_text_goal_${sentTexts.length}`;
      }
    }),
    createNoopDeliveryService(),
    projector,
    codexWorker,
    createBoundWorkspaceResolver(),
    createScheduleService(),
    "/home/overlogged",
    createLogger(),
    createGroupControlAgent({
      async interpret(_message, context, options) {
        assert.equal(options?.controlThreadId, "thread_control_existing");
        assert.equal(context.goal, undefined);
        return createControlResult({
          kind: "set_goal",
          goal: "每次改代码前先看测试"
        }, "thread_control_existing");
      }
    })
  );

  orchestrator.enqueue(
    createControlSession({
      messageId: "om_group_set_goal_1",
      text: "@托帕 设置 goal 为每次改代码前先看测试"
    })
  );

  await runCompleted;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal((sessionStore.get("oc_group_1") as { goal?: string } | undefined)?.goal, undefined);
  assertMentionedControlReply(sentTexts[0], "ou_user_1", "user-1");
  assert.match(sentTexts[0] ?? "", /已调用 Codex native \/goal 设置目标/);
  assert.equal(capturedEnsureLegacyGoal, undefined);
  assert.equal(capturedRunObjective, "每次改代码前先看测试");
  assert.equal(runGoalCalls, 1);
});

test("ChatOrchestrator clears a native Codex goal from the control plane", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  const sentTexts: string[] = [];
  let runTurnCalls = 0;
  let clearGoalCalls = 0;
  let clearGoalThreadId: string | undefined;

  sessionStore.save({
    chatId: "oc_group_1",
    chatType: "group",
    threadId: "thread_group_main",
    cli: "codex",
    workspaceId: "/home/overlogged/Quant",
    goal: "每次改代码前先看测试",
    controlThreadId: "thread_control_existing",
    updatedAt: new Date().toISOString()
  } as never);

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient({
      async sendText(input) {
        sentTexts.push(input.content);
        return "om_text_clear_goal";
      }
    }),
    createNoopDeliveryService(),
    projector,
    {
      async ensureThread() {
        return "thread_should_not_start";
      },
      async getGoal() {
        return {
          threadId: "thread_group_main",
          objective: "每次改代码前先看测试",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1
        };
      },
      async clearGoal(context) {
        clearGoalCalls += 1;
        clearGoalThreadId = context.threadId;
        return true;
      },
      async *runTurn(): AsyncGenerator<CodexEvent> {
        runTurnCalls += 1;
      }
    },
    createBoundWorkspaceResolver(),
    createScheduleService(),
    "/home/overlogged",
    createLogger(),
    createGroupControlAgent({
      async interpret(_message, context) {
        assert.equal(context.goal, "每次改代码前先看测试");
        return createControlResult({
          kind: "clear_goal"
        }, "thread_control_existing");
      }
    })
  );

  orchestrator.enqueue(
    createControlSession({
      messageId: "om_group_clear_goal_1",
      text: "@托帕 清除 goal"
    })
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(runTurnCalls, 0);
  assert.equal(clearGoalCalls, 1);
  assert.equal(clearGoalThreadId, "thread_group_main");
  assert.equal(runStore.list().length, 0);
  assert.equal((sessionStore.get("oc_group_1") as { goal?: string } | undefined)?.goal, undefined);
  assertMentionedControlReply(sentTexts[0], "ou_user_1", "user-1");
  assert.match(sentTexts[0] ?? "", /已调用 Codex native \/goal clear/);
});

test("ChatOrchestrator routes scheduled tasks into the active session", async () => {
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
    cli: "codex",
    workspaceId: "/home/overlogged/Quant",
    activeRunId: existingRun.runId,
    activeTurnId: "turn_active_1",
    updatedAt: new Date().toISOString()
  });

  let runTurnCalls = 0;
  let steerCalls = 0;
  const codexWorker: CodexWorker = {
    async ensureThread() {
      return "thread_active_1";
    },
    async steerTurn() {
      steerCalls += 1;
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
    createWorkspaceResolver({
      async resolve() {
        return {
          ok: true,
          workspaceId: "/home/overlogged/Quant",
          cli: "codex",
        };
      }
    }),
    createScheduleService(),
    "/home/overlogged",
    createLogger(),
    createGroupControlAgent({
      async interpret() {
        return createControlResult({
          kind: "new_session"
        });
      }
    })
  );

  const result = await orchestrator.triggerScheduledTask({
    chatId: "oc_group_1",
    taskId: "2",
    cron: "0 9 * * 1-5",
    prompt: "生成工作日报",
    status: "enabled",
    createdAt: "2026-04-04T00:00:00.000Z",
    updatedAt: "2026-04-04T00:00:00.000Z",
    nextRunAt: "2026-04-04T01:00:00.000Z"
  });

  assert.deepEqual(result, {
    outcome: "triggered"
  });
  assert.equal(runTurnCalls, 0);
  assert.equal(steerCalls, 1);
});

test("ChatOrchestrator creates a fresh session when asked", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  const sentTexts: string[] = [];
  let ensureThreadCalls = 0;

  sessionStore.save({
    chatId: "oc_group_1",
    threadId: "thread_old",
    cli: "codex",
    workspaceId: "/home/overlogged/Quant",
    updatedAt: new Date().toISOString()
  });

  const codexWorker: CodexWorker = {
    async ensureThread() {
      ensureThreadCalls += 1;
      return "thread_new";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      throw new Error("should not run a turn");
    }
  };

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient({
      async sendText(input) {
        sentTexts.push(input.content);
        return "om_text_new_session";
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
      async resolve() {
        return {
          ok: true,
          workspaceId: "/home/overlogged/Quant",
          cli: "codex",
        };
      }
    }),
    createScheduleService(),
    "/home/overlogged",
    createLogger(),
    createGroupControlAgent({
      async interpret() {
        return createControlResult({
          kind: "new_session"
        });
      }
    })
  );

  orchestrator.enqueue(
    createControlSession({
      messageId: "om_group_new_session_1",
      text: "@托帕 新会话"
    })
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(ensureThreadCalls, 1);
  assert.equal(sessionStore.get("oc_group_1")?.threadId, "thread_new");
  assert.equal(runStore.list().length, 0);
  assert.match(sentTexts[0] ?? "", /已为这个群创建新的会话/);
});

test("ChatOrchestrator interrupts the active run before creating a fresh session", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  const sentTexts: string[] = [];
  let interruptCalls = 0;
  let ensureThreadCalls = 0;

  sessionStore.save({
    chatId: "oc_group_1",
    threadId: "thread_old",
    cli: "codex",
    workspaceId: "/home/overlogged/Quant",
    activeRunId: "run_active",
    activeTurnId: "turn_active",
    updatedAt: new Date().toISOString()
  });
  runStore.save({
    runId: "run_active",
    chatId: "oc_group_1",
    threadId: "thread_old",
    sourceMessageId: "om_old_run",
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const codexWorker: CodexWorker = {
    async ensureThread() {
      ensureThreadCalls += 1;
      return "thread_new";
    },
    async interruptTurn(context) {
      interruptCalls += 1;
      assert.equal(context.threadId, "thread_old");
      assert.equal(context.turnId, "turn_active");
      assert.equal(context.workspaceId, "/home/overlogged/Quant");
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      throw new Error("should not run a turn");
    }
  };

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient({
      async sendText(input) {
        sentTexts.push(input.content);
        return "om_text_new_session_interrupt";
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
      async resolve() {
        return {
          ok: true,
          workspaceId: "/home/overlogged/Quant",
          cli: "codex",
        };
      }
    }),
    createScheduleService(),
    "/home/overlogged",
    createLogger(),
    createGroupControlAgent({
      async interpret() {
        return createControlResult({
          kind: "new_session"
        });
      }
    })
  );

  orchestrator.enqueue(
    createControlSession({
      messageId: "om_group_new_session_interrupt_1",
      text: "@托帕 新会话"
    })
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(interruptCalls, 1);
  assert.equal(ensureThreadCalls, 1);
  assert.equal(sessionStore.get("oc_group_1")?.threadId, "thread_new");
  assert.equal(sessionStore.get("oc_group_1")?.activeRunId, undefined);
  assert.equal(runStore.get("run_active")?.status, "failed");
  assert.match(runStore.get("run_active")?.errorMessage ?? "", /新会话/);
  assert.match(sentTexts[0] ?? "", /已结束这个群当前的活跃任务，并创建新的会话/);
});

test("ChatOrchestrator hands off context from the previous cli session file on switch", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);

  const codexHome = await mkdtemp(join(tmpdir(), "orchestrator-handoff-codex-"));
  const sessionsDir = join(codexHome, "sessions", "2026", "06", "28");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, "rollout-2026-06-28T13-29-02-thread_old_1.jsonl"),
    [
      JSON.stringify({ type: "session_meta", payload: { id: "thread_old_1" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "分析一下库存" }]
        }
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "库存结构是这样" }]
        }
      })
    ].join("\n"),
    "utf8"
  );

  sessionStore.save({
    chatId: "oc_group_1",
    threadId: "thread_old_1",
    cli: "codex",
    workspaceId: "/workspace",
    updatedAt: new Date().toISOString()
  });

  const sentTexts: string[] = [];
  const calledClis: string[] = [];
  let capturedText = "";
  let resolveTurn: (() => void) | undefined;
  const turnCompleted = new Promise<void>((resolve) => {
    resolveTurn = resolve;
  });

  const codexWorker: CodexWorker = {
    async ensureThread() {
      return "thread_old_1";
    },
    async *runTurn(context): AsyncGenerator<CodexEvent> {
      calledClis.push(context.cli);
      capturedText = context.message.text;
      yield {
        kind: "thread_bound",
        threadId: "thread_pi_1"
      };
      yield {
        kind: "turn_bound",
        turnId: "turn_pi_1"
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
    createFeishuClient({
      async sendText(input) {
        sentTexts.push(input.content);
        return "om_notice_1";
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
      async resolve() {
        return {
          ok: true,
          workspaceId: "/workspace",
          cli: "pi",
        };
      }
    }),
    createScheduleService(),
    "/workspace",
    createLogger()
  );

  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    orchestrator.enqueue(createMessage({ text: "继续" }));
    await turnCompleted;
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calledClis, ["pi"]);
  assert.match(capturedText, /系统交接说明/);
  assert.match(capturedText, /分析一下库存/);
  assert.match(capturedText, /库存结构是这样/);
  assert.match(capturedText, /用户的新消息：\n继续/);
  assert.ok(
    sentTexts.some((text) => text.includes("已从 Codex 切换到 Pi，并恢复了之前的上下文。")),
    `expected a switch notice, got: ${JSON.stringify(sentTexts)}`
  );
  assert.equal(sessionStore.get("oc_group_1")?.cli, "pi");
  assert.equal(sessionStore.get("oc_group_1")?.threadId, "thread_pi_1");
});
