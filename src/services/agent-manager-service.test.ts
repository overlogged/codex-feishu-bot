import assert from "node:assert/strict";
import test from "node:test";

import type { IncomingChatMessage } from "../domain/types.js";
import type { FeishuMessageClient } from "../integrations/feishu/feishu-message-client.js";
import { ConversationStore } from "../stores/conversation-store.js";
import { RunStore } from "../stores/run-store.js";
import { SessionStore } from "../stores/session-store.js";
import { AgentManagerService } from "./agent-manager-service.js";

function createFeishuClient(sentTexts: Array<{ chatId: string; content: string }>): FeishuMessageClient {
  return {
    async sendText(input) {
      sentTexts.push({
        chatId: input.chatId,
        content: input.content
      });
      return "om_text_agent_manager";
    },
    async updateText() {
      return undefined;
    },
    async sendCard() {
      return "om_card_agent_manager";
    },
    async updateCard() {
      return undefined;
    },
    async sendFile() {
      return "om_file_agent_manager";
    }
  };
}

test("AgentManagerService picks the latest p2p session as main and summarizes current focus", () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();

  sessionStore.save({
    chatId: "oc_p2p_old",
    chatType: "p2p",
    chatName: "旧私聊",
    threadId: "thread_p2p_old",
    cli: "codex",
    workspaceId: "/home/overlogged",
    lastInboundAt: "2026-04-04T10:00:00.000Z",
    lastSenderName: "老王",
    lastMessagePreview: "旧消息",
    lastUserMessagePreview: "旧消息",
    updatedAt: "2026-04-04T10:00:00.000Z"
  });
  sessionStore.save({
    chatId: "oc_p2p_new",
    chatType: "p2p",
    chatName: "新私聊",
    threadId: "thread_p2p_new",
    cli: "codex",
    workspaceId: "/home/overlogged",
    lastInboundAt: "2026-04-04T12:00:00.000Z",
    lastSenderName: "小李",
    lastMessagePreview: "请继续",
    lastUserMessagePreview: "请继续",
    updatedAt: "2026-04-04T12:00:00.000Z"
  });

  const groupRun = runStore.create({
    chatId: "oc_group_1",
    threadId: "thread_group_1",
    sourceMessageId: "om_group_1"
  });
  runStore.setStatus(groupRun.runId, "running");
  sessionStore.save({
    chatId: "oc_group_1",
    chatType: "group",
    chatName: "项目群",
    threadId: "thread_group_1",
    cli: "claude",
    workspaceId: "/home/overlogged/Quant",
    activeRunId: groupRun.runId,
    activeTurnId: "turn_group_1",
    lastInboundAt: "2026-04-04T11:00:00.000Z",
    lastSenderName: "张三",
    lastMessagePreview: "帮我跑一下测试",
    lastUserMessagePreview: "帮我跑一下测试",
    updatedAt: "2026-04-04T11:00:00.000Z"
  });
  conversationStore.save({
    runId: groupRun.runId,
    chatId: "oc_group_1",
    sourceMessageId: "om_group_1",
    itemId: "tool_1",
    order: 1,
    kind: "tool_card",
    source: "tool",
    phase: "streaming",
    title: "执行 git status",
    details: [],
    filePaths: [],
    createdAt: "2026-04-04T11:00:10.000Z",
    updatedAt: "2026-04-04T11:00:10.000Z"
  });

  const service = new AgentManagerService(
    "/home/overlogged",
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient([]),
    {
      enqueue() {
        return undefined;
      }
    }
  );

  const main = service.getMainPrivateSession();
  assert.equal(main?.chatId, "oc_p2p_new");
  assert.equal(main?.isMainPrivateSession, true);
  assert.match(main?.focus ?? "", /空闲/);
  assert.equal(main?.lastUserMessagePreview, "请继续");

  const group = service.getSession("oc_group_1");
  assert.equal(group?.title, "项目群");
  assert.equal(group?.runStatus, "running");
  assert.match(group?.focus ?? "", /执行 git status/);
  assert.equal(group?.lastUserMessagePreview, "帮我跑一下测试");
});

test("AgentManagerService includes the latest assistant paragraph in session summaries", () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();

  sessionStore.save({
    chatId: "oc_group_target",
    chatType: "group",
    chatName: "目标群",
    threadId: "thread_group_target",
    cli: "codex",
    workspaceId: "/home/overlogged/Quant",
    updatedAt: "2026-04-04T12:00:00.000Z"
  });

  const run = runStore.create({
    chatId: "oc_group_target",
    threadId: "thread_group_target",
    sourceMessageId: "om_group_target"
  });
  runStore.setStatus(run.runId, "completed");

  conversationStore.save({
    runId: run.runId,
    chatId: "oc_group_target",
    sourceMessageId: "om_group_target",
    itemId: "msg_reply",
    order: 1,
    kind: "assistant_text",
    source: "final_answer",
    phase: "completed",
    content: "第一段概述。\n\n第二段细节。\n\n最后一段结论。",
    details: [],
    filePaths: [],
    createdAt: "2026-04-04T12:00:10.000Z",
    updatedAt: "2026-04-04T12:00:10.000Z"
  });

  const service = new AgentManagerService(
    "/home/overlogged",
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient([]),
    {
      enqueue() {
        return undefined;
      }
    }
  );

  const session = service.getSession("oc_group_target");
  assert.equal(session?.lastReplyPreview, "最后一段结论。");
});

test("AgentManagerService falls back to lastMessagePreview when old snapshots lack lastUserMessagePreview", () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();

  sessionStore.save({
    chatId: "oc_group_legacy",
    chatType: "group",
    chatName: "旧快照群",
    threadId: "thread_group_legacy",
    cli: "codex",
    workspaceId: "/home/overlogged/Quant",
    lastSenderId: "ou_legacy_user",
    lastMessagePreview: "这是旧快照里保存的最后一条消息",
    updatedAt: "2026-04-04T12:30:00.000Z"
  });

  const service = new AgentManagerService(
    "/home/overlogged",
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient([]),
    {
      enqueue() {
        return undefined;
      }
    }
  );

  const session = service.getSession("oc_group_legacy");
  assert.equal(session?.lastUserMessagePreview, "这是旧快照里保存的最后一条消息");
});

test("AgentManagerService does not treat legacy system-injected messages as last user messages", () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();

  sessionStore.save({
    chatId: "oc_p2p_legacy_system",
    chatType: "p2p",
    chatName: "旧系统会话",
    threadId: "thread_p2p_legacy_system",
    cli: "codex",
    workspaceId: "/home/overlogged",
    lastSenderId: "system:agent-manager:http:voicebridge",
    lastMessagePreview: "来自voicebridge说：请继续",
    updatedAt: "2026-04-04T12:35:00.000Z"
  });

  const service = new AgentManagerService(
    "/home/overlogged",
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient([]),
    {
      enqueue() {
        return undefined;
      }
    }
  );

  const session = service.getSession("oc_p2p_legacy_system");
  assert.equal(session?.lastUserMessagePreview, undefined);
});

test("AgentManagerService forwards to the main private session and mirrors the message to Feishu", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const sentTexts: Array<{ chatId: string; content: string }> = [];
  const enqueuedMessages: IncomingChatMessage[] = [];

  sessionStore.save({
    chatId: "oc_p2p_main",
    chatType: "p2p",
    chatName: "主管私聊",
    threadId: "thread_p2p_main",
    cli: "codex",
    workspaceId: "/home/overlogged",
    lastInboundAt: "2026-04-04T12:00:00.000Z",
    lastSenderName: "主管",
    lastMessagePreview: "最近进度如何",
    updatedAt: "2026-04-04T12:00:00.000Z"
  });

  const service = new AgentManagerService(
    "/home/overlogged",
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient(sentTexts),
    {
      enqueue(message) {
        enqueuedMessages.push(message);
      }
    }
  );

  const result = await service.sendToMainPrivateSession({
    from: "monitor",
    content: "请汇总一下刚才的进度",
    source: "http"
  });

  assert.equal(sentTexts.length, 1);
  assert.deepEqual(sentTexts[0], {
    chatId: "oc_p2p_main",
    content: "来自monitor说：\n请汇总一下刚才的进度"
  });
  assert.equal(enqueuedMessages.length, 1);
  assert.equal(enqueuedMessages[0]?.chatId, "oc_p2p_main");
  assert.equal(enqueuedMessages[0]?.chatType, "p2p");
  assert.equal(enqueuedMessages[0]?.senderType, "system");
  assert.equal(enqueuedMessages[0]?.text, "来自monitor说：\n请汇总一下刚才的进度");
  assert.equal(result.mirroredToFeishu, true);
});

test("AgentManagerService can inject a message into a specific session without mirroring to Feishu", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const sentTexts: Array<{ chatId: string; content: string }> = [];
  const enqueuedMessages: IncomingChatMessage[] = [];

  sessionStore.save({
    chatId: "oc_group_target",
    chatType: "group",
    chatName: "目标群",
    threadId: "thread_group_target",
    cli: "kimi",
    workspaceId: "/home/overlogged/Downloads",
    lastInboundAt: "2026-04-04T13:00:00.000Z",
    lastSenderName: "李四",
    lastMessagePreview: "先暂停一下",
    updatedAt: "2026-04-04T13:00:00.000Z"
  });

  const service = new AgentManagerService(
    "/home/overlogged",
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient(sentTexts),
    {
      enqueue(message) {
        enqueuedMessages.push(message);
      }
    }
  );

  const result = await service.sendToSession("oc_group_target", {
    from: "supervisor",
    content: "改成先收集失败日志",
    source: "cli"
  });

  assert.equal(sentTexts.length, 0);
  assert.equal(enqueuedMessages.length, 1);
  assert.equal(enqueuedMessages[0]?.chatId, "oc_group_target");
  assert.equal(enqueuedMessages[0]?.chatType, "group");
  assert.equal(enqueuedMessages[0]?.text, "来自supervisor说：\n改成先收集失败日志");
  assert.equal(result.mirroredToFeishu, false);
});

test("AgentManagerService updateSessionMetadata writes refreshed chat names back into sessions", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();

  sessionStore.save({
    chatId: "oc_group_target",
    chatType: "group",
    threadId: "thread_group_target",
    cli: "codex",
    workspaceId: "/home/overlogged/Quant",
    updatedAt: "2026-04-04T13:00:00.000Z"
  });

  const service = new AgentManagerService(
    "/home/overlogged",
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient([]),
    {
      enqueue() {
        return undefined;
      }
    },
    {
      async refreshSessionMetadata() {
        return {
          patch: {
            chatType: "group",
            chatName: "日报",
            chatDisplayName: "日报"
          },
          warnings: []
        };
      }
    }
  );

  const result = await service.updateSessionMetadata();
  assert.equal(result.updated, 1);
  assert.equal(result.failed, 0);
  assert.equal(sessionStore.get("oc_group_target")?.chatName, "日报");
  assert.equal(sessionStore.get("oc_group_target")?.chatDisplayName, "日报");
});

test("AgentManagerService updateSessionMetadata fails fast when no metadata provider is configured", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();

  const service = new AgentManagerService(
    "/home/overlogged",
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient([]),
    {
      enqueue() {
        return undefined;
      }
    }
  );

  await assert.rejects(() => service.updateSessionMetadata(), /provider/);
});

test("AgentManagerService lists only stable assistant messages for phone receive mode", () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();

  sessionStore.save({
    chatId: "oc_p2p_main",
    chatType: "p2p",
    chatName: "主管私聊",
    chatDisplayName: "主管私聊",
    threadId: "thread_p2p_main",
    cli: "codex",
    workspaceId: "/home/overlogged",
    lastInboundAt: "2026-04-04T14:00:00.000Z",
    updatedAt: "2026-04-04T14:00:00.000Z"
  });

  const run = runStore.create({
    chatId: "oc_p2p_main",
    threadId: "thread_p2p_main",
    sourceMessageId: "om_main"
  });
  runStore.setStatus(run.runId, "completed");

  conversationStore.save({
    runId: run.runId,
    chatId: "oc_p2p_main",
    sourceMessageId: "om_main",
    itemId: "msg_commentary_done",
    order: 1,
    kind: "assistant_text",
    source: "commentary",
    phase: "completed",
    content: "阶段总结一",
    details: [],
    filePaths: [],
    createdAt: "2026-04-04T14:00:01.000Z",
    updatedAt: "2026-04-04T14:00:01.000Z"
  });
  conversationStore.save({
    runId: run.runId,
    chatId: "oc_p2p_main",
    sourceMessageId: "om_main",
    itemId: "msg_commentary_streaming",
    order: 2,
    kind: "assistant_text",
    source: "commentary",
    phase: "streaming",
    content: "还在生成",
    details: [],
    filePaths: [],
    createdAt: "2026-04-04T14:00:02.000Z",
    updatedAt: "2026-04-04T14:00:02.000Z"
  });
  conversationStore.save({
    runId: run.runId,
    chatId: "oc_p2p_main",
    sourceMessageId: "om_main",
    itemId: "msg_final_done",
    order: 3,
    kind: "assistant_text",
    source: "final_answer",
    phase: "completed",
    content: "最终结论",
    details: [],
    filePaths: [],
    createdAt: "2026-04-04T14:00:03.000Z",
    updatedAt: "2026-04-04T14:00:03.000Z"
  });
  conversationStore.save({
    runId: run.runId,
    chatId: "oc_p2p_main",
    sourceMessageId: "om_main",
    itemId: "tool_done",
    order: 4,
    kind: "tool_card",
    source: "tool",
    phase: "completed",
    title: "执行 ls",
    details: [],
    filePaths: [],
    createdAt: "2026-04-04T14:00:04.000Z",
    updatedAt: "2026-04-04T14:00:04.000Z"
  });

  const service = new AgentManagerService(
    "/home/overlogged",
    sessionStore,
    runStore,
    conversationStore,
    createFeishuClient([]),
    {
      enqueue() {
        return undefined;
      }
    }
  );

  const commentaryOnly = service.listStableMessagesForMainPrivateSession();
  assert.deepEqual(
    commentaryOnly.messages.map((message) => ({
      id: message.id,
      source: message.source,
      content: message.content
    })),
    [
      {
        id: `${run.runId}:msg_commentary_done`,
        source: "commentary",
        content: "阶段总结一"
      }
    ]
  );

  const allMessages = service.listStableMessagesForMainPrivateSession({
    source: "all",
    afterId: `${run.runId}:msg_commentary_done`
  });
  assert.deepEqual(
    allMessages.messages.map((message) => ({
      id: message.id,
      source: message.source,
      content: message.content
    })),
    [
      {
        id: `${run.runId}:msg_final_done`,
        source: "final_answer",
        content: "最终结论"
      }
    ]
  );
});
