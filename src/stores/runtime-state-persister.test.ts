import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { ConversationStore } from "./conversation-store.js";
import { RunStore } from "./run-store.js";
import { RuntimeStatePersister } from "./runtime-state-persister.js";
import { ScheduledTaskStore } from "./scheduled-task-store.js";
import { SessionStore } from "./session-store.js";

test("RuntimeStatePersister restores sessions and clears stale active run state", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "codex-feishu-state-"));
  const filePath = join(tempDir, "runtime-state.json");

  const persister = new RuntimeStatePersister(filePath);
  const persist = () => persister.scheduleSave();
  const sessionStore = new SessionStore(persist);
  const runStore = new RunStore(persist);
  const conversationStore = new ConversationStore(persist);
  const scheduledTaskStore = new ScheduledTaskStore(persist);

  persister.attach({
    sessionStore,
    runStore,
    conversationStore,
    scheduledTaskStore
  });

  sessionStore.save({
    chatId: "oc_chat_1",
    threadId: "thread_1",
    cli: "codex",
    workspaceId: "/workspace",
    goal: "每次改代码前先看测试",
    goalUpdatedAt: "2026-03-09T00:00:00.000Z",
    activeRunId: "run_1",
    activeTurnId: "turn_1",
    updatedAt: "2026-03-09T00:00:00.000Z"
  } as never);
  sessionStore.save({
    chatId: "oc_chat_pi",
    threadId: "thread_pi",
    cli: "pi",
    workspaceId: "/workspace",
    executionMode: "docker",
    goal: "Pi 也带上这个 goal",
    goalUpdatedAt: "2026-03-09T00:00:00.000Z",
    updatedAt: "2026-03-09T00:00:00.000Z"
  } as never);
  runStore.save({
    runId: "run_1",
    chatId: "oc_chat_1",
    threadId: "thread_1",
    sourceMessageId: "om_1",
    status: "running",
    startedAt: "2026-03-09T00:00:00.000Z",
    updatedAt: "2026-03-09T00:00:00.000Z"
  });
  conversationStore.save({
    runId: "run_1",
    chatId: "oc_chat_1",
    sourceMessageId: "om_1",
    itemId: "msg_1",
    order: 1,
    kind: "assistant_text",
    source: "commentary",
    phase: "completed",
    content: "hello",
    details: [],
    filePaths: [],
    createdAt: "2026-03-09T00:00:00.000Z",
    updatedAt: "2026-03-09T00:00:00.000Z"
  });
  scheduledTaskStore.save({
    chatId: "oc_chat_1",
    taskId: "1",
    cron: "0 9 * * *",
    prompt: "hello",
    status: "enabled",
    createdAt: "2026-03-09T00:00:00.000Z",
    updatedAt: "2026-03-09T00:00:00.000Z",
    nextRunAt: "2026-03-10T01:00:00.000Z"
  });

  await persister.flush();

  const restoredSessionStore = new SessionStore();
  const restoredRunStore = new RunStore();
  const restoredConversationStore = new ConversationStore();
  const restoredScheduledTaskStore = new ScheduledTaskStore();
  const restoredPersister = new RuntimeStatePersister(filePath);

  const restored = await restoredPersister.restore({
    sessionStore: restoredSessionStore,
    runStore: restoredRunStore,
    conversationStore: restoredConversationStore,
    scheduledTaskStore: restoredScheduledTaskStore
  });

  assert.deepEqual(restored.interruptedRuns, [
    {
      chatId: "oc_chat_1",
      threadId: "thread_1",
      runId: "run_1",
      sourceMessageId: "om_1"
    }
  ]);

  const restoredSession = restoredSessionStore.get("oc_chat_1");
  assert.ok(restoredSession);
  assert.equal(restoredSession.threadId, "thread_1");
  assert.equal(restoredSession.cli, "codex");
  assert.equal((restoredSession as { goal?: string }).goal, undefined);
  assert.equal((restoredSession as { goalUpdatedAt?: string }).goalUpdatedAt, undefined);
  assert.equal(restoredSession.activeRunId, undefined);
  assert.equal(restoredSession.activeTurnId, undefined);

  const restoredPiSession = restoredSessionStore.get("oc_chat_pi");
  assert.ok(restoredPiSession);
  assert.equal(restoredPiSession.cli, "pi");
  assert.equal((restoredPiSession as { goal?: string }).goal, undefined);
  assert.equal((restoredPiSession as { goalUpdatedAt?: string }).goalUpdatedAt, undefined);

  const restoredRun = restoredRunStore.get("run_1");
  assert.ok(restoredRun);
  assert.equal(restoredRun.status, "failed");
  assert.match(restoredRun.errorMessage ?? "", /服务重启后中断/);

  const restoredItem = restoredConversationStore.get("run_1", "msg_1");
  assert.ok(restoredItem);
  assert.equal(restoredItem.content, "hello");

  const restoredTask = restoredScheduledTaskStore.get("oc_chat_1", "1");
  assert.ok(restoredTask);
  assert.equal(restoredTask.prompt, "hello");

  await restoredPersister.flush();
  const raw = await readFile(filePath, "utf8");
  assert.match(raw, /"threadId":"thread_1"/);
  assert.doesNotMatch(raw, /goalUpdatedAt/);
  assert.match(raw, /"status":"failed"/);
  assert.match(raw, /"scheduledTasks"/);
});

test("RuntimeStatePersister compacts large conversation snapshots", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "codex-feishu-state-"));
  const filePath = join(tempDir, "runtime-state.json");

  const persister = new RuntimeStatePersister(filePath);
  const persist = () => persister.scheduleSave();
  const sessionStore = new SessionStore(persist);
  const runStore = new RunStore(persist);
  const conversationStore = new ConversationStore(persist);
  const scheduledTaskStore = new ScheduledTaskStore(persist);

  persister.attach({
    sessionStore,
    runStore,
    conversationStore,
    scheduledTaskStore
  });

  runStore.save({
    runId: "run_1",
    chatId: "oc_chat_1",
    threadId: "thread_1",
    sourceMessageId: "om_1",
    status: "completed",
    startedAt: "2026-03-09T00:00:00.000Z",
    updatedAt: "2026-03-09T00:00:01.000Z"
  });

  const hugeContent = "x".repeat(25_000);
  const hugeOutput = "y".repeat(15_000);
  for (let index = 0; index < 5_005; index += 1) {
    conversationStore.save({
      runId: "run_1",
      chatId: "oc_chat_1",
      sourceMessageId: "om_1",
      itemId: `item_${index}`,
      order: index,
      kind: "tool_card",
      source: "tool",
      phase: "completed",
      content: index === 5_004 ? hugeContent : `content_${index}`,
      output: index === 5_004 ? hugeOutput : `output_${index}`,
      details: Array.from({ length: 25 }, (_, detailIndex) => `detail_${index}_${detailIndex}`),
      filePaths: Array.from({ length: 110 }, (_, pathIndex) => `/tmp/${index}_${pathIndex}`),
      createdAt: "2026-03-09T00:00:00.000Z",
      updatedAt: "2026-03-09T00:00:01.000Z"
    });
  }

  await persister.flush();

  const parsed = JSON.parse(await readFile(filePath, "utf8")) as {
    items: Array<{
      itemId: string;
      content?: string;
      output?: string;
      details: string[];
      filePaths: string[];
    }>;
  };
  assert.equal(parsed.items.length, 5_000);
  assert.equal(parsed.items[0]?.itemId, "item_5");
  const lastItem = parsed.items.at(-1);
  assert.ok(lastItem);
  assert.match(lastItem.content ?? "", /truncated 5000 chars/);
  assert.match(lastItem.output ?? "", /truncated 3000 chars/);
  assert.equal(lastItem.details.length, 20);
  assert.equal(lastItem.filePaths.length, 100);
});

test("RuntimeStatePersister serializes overlapping writes that target the same snapshot", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "codex-feishu-state-"));
  const filePath = join(tempDir, "runtime-state.json");

  const persister = new RuntimeStatePersister(filePath, undefined, 0);
  const persist = () => persister.scheduleSave();
  const sessionStore = new SessionStore(persist);
  const runStore = new RunStore(persist);
  const conversationStore = new ConversationStore(persist);
  const scheduledTaskStore = new ScheduledTaskStore(persist);

  persister.attach({
    sessionStore,
    runStore,
    conversationStore,
    scheduledTaskStore
  });

  let activeWrites = 0;
  let maxActiveWrites = 0;
  let writeCalls = 0;
  let markFirstWriteStarted: (() => void) | undefined;
  const firstWriteStarted = new Promise<void>((resolve) => {
    markFirstWriteStarted = resolve;
  });
  let releaseFirstWrite: (() => void) | undefined;
  const firstWriteMayFinish = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  const originalWriteSnapshot = (
    persister as unknown as { writeSnapshot: () => Promise<void> }
  ).writeSnapshot.bind(persister);

  (persister as unknown as { writeSnapshot: () => Promise<void> }).writeSnapshot = async () => {
    writeCalls += 1;
    activeWrites += 1;
    maxActiveWrites = Math.max(maxActiveWrites, activeWrites);

    if (writeCalls === 1) {
      markFirstWriteStarted?.();
      await firstWriteMayFinish;
    }

    try {
      await originalWriteSnapshot();
    } finally {
      activeWrites -= 1;
    }
  };

  sessionStore.save({
    chatId: "oc_chat_1",
    threadId: "thread_1",
    cli: "codex",
    workspaceId: "/workspace",
    updatedAt: "2026-03-09T00:00:00.000Z"
  });

  await firstWriteStarted;

  runStore.save({
    runId: "run_1",
    chatId: "oc_chat_1",
    threadId: "thread_1",
    sourceMessageId: "om_1",
    status: "completed",
    startedAt: "2026-03-09T00:00:00.000Z",
    updatedAt: "2026-03-09T00:00:01.000Z"
  });

  const flushPromise = persister.flush();
  releaseFirstWrite?.();
  await flushPromise;

  assert.equal(writeCalls, 2);
  assert.equal(maxActiveWrites, 1);

  const raw = await readFile(filePath, "utf8");
  assert.match(raw, /"runId":"run_1"/);
});
