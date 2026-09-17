import assert from "node:assert/strict";
import test from "node:test";

import type { ChatSession } from "../domain/types.js";
import { SessionStore } from "../stores/session-store.js";
import {
  formatTimeOfDay,
  parseTimeOfDay,
  TokenDailyReportService
} from "./token-daily-report-service.js";
import type { UsageStatsService } from "./usage-stats-service.js";

function createSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    chatId: "oc_group_1",
    threadId: "thread_1",
    cli: "codex",
    workspaceId: "/workspace",
    updatedAt: "2026-09-17T00:00:00.000Z",
    ...overrides
  };
}

function createService(options: {
  sessions: ChatSession[];
  now: Date;
  onReport?: () => void;
  sent: string[];
}) {
  const sessionStore = new SessionStore();
  for (const session of options.sessions) {
    sessionStore.save(session);
  }

  const usageStatsService = {
    async buildDailyReport() {
      options.onReport?.();
      return "Token 消耗日报（今日）";
    }
  } as unknown as UsageStatsService;

  const service = new TokenDailyReportService(
    sessionStore,
    usageStatsService,
    async (chatId, content) => {
      options.sent.push(`${chatId}:${content}`);
    },
    undefined,
    {
      defaultTime: "23:00",
      tickMs: 5,
      now: () => options.now
    }
  );

  return { sessionStore, service };
}

test("parseTimeOfDay / formatTimeOfDay normalize HH:mm values", () => {
  assert.deepEqual(parseTimeOfDay("23:30"), { hour: 23, minute: 30 });
  assert.deepEqual(parseTimeOfDay("9:05"), { hour: 9, minute: 5 });
  assert.equal(parseTimeOfDay("24:00"), undefined);
  assert.equal(parseTimeOfDay("abc"), undefined);
  assert.equal(formatTimeOfDay("9:05", "23:00"), "09:05");
  assert.equal(formatTimeOfDay(undefined, "23:00"), "23:00");
});

test("TokenDailyReportService sends the daily report at the configured time", async () => {
  const sent: string[] = [];
  let reportCount = 0;
  const now = new Date("2026-09-17T23:10:00");
  const { sessionStore, service } = createService({
    sessions: [
      createSession({
        tokenDailyReportEnabled: true,
        tokenDailyReportTime: "23:00"
      })
    ],
    now,
    sent,
    onReport: () => {
      reportCount += 1;
    }
  });

  service.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  service.stop();

  assert.equal(reportCount, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /oc_group_1:Token 消耗日报/);
  assert.equal(sessionStore.get("oc_group_1")?.tokenDailyReportLastSentDate, "2026-09-17");
});

test("TokenDailyReportService does not resend on the same day or before the time", async () => {
  const sent: string[] = [];
  const now = new Date("2026-09-17T22:00:00");
  const { service } = createService({
    sessions: [
      createSession({
        tokenDailyReportEnabled: true,
        tokenDailyReportTime: "23:00"
      })
    ],
    now,
    sent
  });

  service.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  service.stop();
  assert.equal(sent.length, 0);

  const alreadySent = createService({
    sessions: [
      createSession({
        tokenDailyReportEnabled: true,
        tokenDailyReportTime: "23:00",
        tokenDailyReportLastSentDate: "2026-09-17"
      })
    ],
    now: new Date("2026-09-17T23:30:00"),
    sent
  });
  alreadySent.service.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  alreadySent.service.stop();
  assert.equal(sent.length, 0);
});

test("TokenDailyReportService ignores sessions without the toggle", async () => {
  const sent: string[] = [];
  const { service } = createService({
    sessions: [createSession()],
    now: new Date("2026-09-17T23:59:00"),
    sent
  });

  service.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  service.stop();
  assert.equal(sent.length, 0);
});
