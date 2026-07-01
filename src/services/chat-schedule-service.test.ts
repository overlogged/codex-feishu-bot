import assert from "node:assert/strict";
import test from "node:test";

import { ScheduledTaskStore } from "../stores/scheduled-task-store.js";
import {
  ChatScheduleService,
  getNextCronOccurrence,
  parseCronExpression
} from "./chat-schedule-service.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("parseCronExpression calculates the next matching local minute", () => {
  const parsed = parseCronExpression("0 9 * * 1-5");
  const next = getNextCronOccurrence(parsed, new Date("2026-04-03T08:58:30+08:00"));
  assert.ok(next);
  assert.equal(next.toISOString(), "2026-04-03T01:00:00.000Z");
});

test("ChatScheduleService creates numbered tasks per chat", () => {
  let now = new Date("2026-04-04T08:58:00+08:00");
  const store = new ScheduledTaskStore();
  const service = new ChatScheduleService(store, console, {
    now: () => new Date(now)
  });

  const first = service.createTask({
    chatId: "oc_group_1",
    cron: "0 9 * * *",
    prompt: "生成日报"
  });
  const second = service.createTask({
    chatId: "oc_group_1",
    cron: "30 18 * * *",
    prompt: "生成晚报"
  });
  const third = service.createTask({
    chatId: "oc_group_2",
    cron: "0 10 * * *",
    prompt: "生成别的群日报"
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(third.ok, true);
  assert.equal(first.ok && first.task.taskId, "1");
  assert.equal(second.ok && second.task.taskId, "2");
  assert.equal(third.ok && third.task.taskId, "1");
  assert.equal(first.ok && first.task.nextRunAt, "2026-04-04T01:00:00.000Z");
});

test("ChatScheduleService updates cron and prompt while preserving task identity", () => {
  let now = new Date("2026-04-04T08:58:00+08:00");
  const store = new ScheduledTaskStore();
  const service = new ChatScheduleService(store, console, {
    now: () => new Date(now)
  });

  const created = service.createTask({
    chatId: "oc_group_1",
    cron: "0 9 * * *",
    prompt: "生成日报"
  });
  assert.equal(created.ok, true);

  now = new Date("2026-04-04T09:05:00+08:00");
  const updated = service.updateTask({
    chatId: "oc_group_1",
    taskId: "1",
    cron: "30 18 * * 1-5",
    prompt: "生成晚报"
  });

  assert.equal(updated.ok, true);
  assert.equal(updated.ok && updated.task.taskId, "1");
  assert.equal(updated.ok && updated.task.cron, "30 18 * * 1-5");
  assert.equal(updated.ok && updated.task.prompt, "生成晚报");
  assert.equal(updated.ok && updated.task.nextRunAt, "2026-04-06T10:30:00.000Z");
});

test("ChatScheduleService deletes one-time tasks after a successful trigger", async () => {
  let now = new Date("2026-04-04T08:58:00+08:00");
  const store = new ScheduledTaskStore();
  const service = new ChatScheduleService(store, console, {
    now: () => new Date(now),
    tickMs: 5
  });

  const created = service.createOneTimeTask({
    chatId: "oc_group_1",
    runAt: "2026-04-04 09:00",
    prompt: "检查线上流水线"
  });

  assert.equal(created.ok, true);
  assert.equal(created.ok && created.task.kind, "once");
  assert.equal(created.ok && created.task.runAt, "2026-04-04T01:00:00.000Z");
  assert.equal(created.ok && created.task.nextRunAt, "2026-04-04T01:00:00.000Z");

  now = new Date("2026-04-04T09:00:00+08:00");
  const triggeredTaskIds: string[] = [];
  service.start(async (task) => {
    triggeredTaskIds.push(task.taskId);
    return {
      outcome: "triggered"
    };
  });

  await sleep(30);
  service.stop();

  assert.deepEqual(triggeredTaskIds, ["1"]);
  assert.equal(store.get("oc_group_1", "1"), undefined);
});

test("ChatScheduleService keeps one-time tasks when the active session is busy", async () => {
  let now = new Date("2026-04-04T08:58:00+08:00");
  const store = new ScheduledTaskStore();
  const service = new ChatScheduleService(store, console, {
    now: () => new Date(now),
    tickMs: 5
  });

  const created = service.createOneTimeTask({
    chatId: "oc_group_1",
    runAt: "2026-04-04 09:00",
    prompt: "忙时稍后再跑"
  });

  assert.equal(created.ok, true);
  now = new Date("2026-04-04T09:00:00+08:00");
  let triggerCalls = 0;
  service.start(async () => {
    triggerCalls += 1;
    return {
      outcome: "busy"
    };
  });

  await sleep(30);
  service.stop();

  assert.ok(triggerCalls > 0);
  const task = store.get("oc_group_1", "1");
  assert.ok(task);
  assert.equal(task.kind, "once");
  assert.equal(task.status, "enabled");
  assert.equal(task.nextRunAt, "2026-04-04T01:00:00.000Z");
});

test("ChatScheduleService retries busy tasks and pauses invalid tasks", async () => {
  let now = new Date("2026-04-04T09:00:00+08:00");
  const store = new ScheduledTaskStore();
  store.save({
    chatId: "oc_group_1",
    taskId: "1",
    cron: "* * * * *",
    prompt: "忙时稍后再跑",
    status: "enabled",
    createdAt: "2026-04-04T00:00:00.000Z",
    updatedAt: "2026-04-04T00:00:00.000Z",
    nextRunAt: "2026-04-04T01:00:00.000Z"
  });
  store.save({
    chatId: "oc_group_1",
    taskId: "2",
    cron: "* * * * *",
    prompt: "坏工作区自动暂停",
    status: "enabled",
    createdAt: "2026-04-04T00:00:00.000Z",
    updatedAt: "2026-04-04T00:00:00.000Z",
    nextRunAt: "2026-04-04T01:00:00.000Z"
  });

  const triggeredTaskIds: string[] = [];
  const service = new ChatScheduleService(store, console, {
    now: () => new Date(now),
    tickMs: 5
  });

  service.start(async (task) => {
    triggeredTaskIds.push(task.taskId);
    if (task.taskId === "1") {
      return {
        outcome: "busy"
      };
    }

    return {
      outcome: "pause",
      reason: "这个群当前没有有效工作区配置。"
    };
  });

  await sleep(30);
  service.stop();

  assert.ok(triggeredTaskIds.includes("1"));
  assert.ok(triggeredTaskIds.includes("2"));

  const busyTask = store.get("oc_group_1", "1");
  assert.ok(busyTask);
  assert.equal(busyTask.status, "enabled");
  assert.equal(busyTask.nextRunAt, "2026-04-04T01:00:00.000Z");

  const pausedTask = store.get("oc_group_1", "2");
  assert.ok(pausedTask);
  assert.equal(pausedTask.status, "paused");
  assert.equal(pausedTask.nextRunAt, undefined);
  assert.match(pausedTask.lastError ?? "", /没有有效工作区配置/);
});

test("ChatScheduleService preserves a manual pause while the due run is still finishing", async () => {
  let now = new Date("2026-04-04T09:00:00+08:00");
  const store = new ScheduledTaskStore();
  store.save({
    chatId: "oc_group_1",
    taskId: "1",
    cron: "*/30 * * * *",
    prompt: "运行中稍后暂停",
    status: "enabled",
    createdAt: "2026-04-04T00:00:00.000Z",
    updatedAt: "2026-04-04T00:00:00.000Z",
    nextRunAt: "2026-04-04T01:00:00.000Z"
  });

  let releaseTrigger!: () => void;
  const triggerFinished = new Promise<void>((resolve) => {
    releaseTrigger = resolve;
  });

  const service = new ChatScheduleService(store, console, {
    now: () => new Date(now),
    tickMs: 5
  });

  let triggerCalls = 0;
  service.start(async () => {
    triggerCalls += 1;
    await triggerFinished;
    return {
      outcome: "triggered"
    };
  });

  await sleep(10);
  const paused = service.pauseTask("oc_group_1", "1");
  assert.equal(paused.ok, true);

  releaseTrigger();
  await sleep(20);
  service.stop();

  assert.equal(triggerCalls, 1);
  const task = store.get("oc_group_1", "1");
  assert.ok(task);
  assert.equal(task.status, "paused");
  assert.equal(task.nextRunAt, undefined);
});
