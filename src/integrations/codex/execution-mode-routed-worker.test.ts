import assert from "node:assert/strict";
import test from "node:test";

import type { CodexEvent, IncomingChatMessage } from "../../domain/types.js";
import type { CodexTurnContext, CodexWorker } from "./codex-worker.js";
import { ExecutionModeRoutedCodexWorker } from "./execution-mode-routed-worker.js";

function createMessage(): IncomingChatMessage {
  return {
    chatId: "oc_group_1",
    chatType: "group",
    messageId: "om_group_1",
    senderId: "ou_user_1",
    senderName: "user-1",
    senderType: "user",
    text: "hello",
    mentionsBot: false,
    raw: {}
  };
}

function createContext(
  overrides: Partial<CodexTurnContext & { threadId: string }> = {}
): CodexTurnContext & { threadId: string } {
  return {
    cli: "codex",
    workspaceId: "/home/overlogged/project",
    executionMode: "host",
    message: createMessage(),
    threadId: "thread_1",
    ...overrides
  };
}

function createWorker(label: string): CodexWorker {
  return {
    async ensureThread() {
      return `${label}-thread`;
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      yield {
        kind: "thread_bound",
        threadId: `${label}-thread`
      };
    }
  };
}

async function collectEvents(
  iterator: AsyncGenerator<CodexEvent>
): Promise<CodexEvent[]> {
  const events: CodexEvent[] = [];
  for await (const event of iterator) {
    events.push(event);
  }
  return events;
}

test("ExecutionModeRoutedCodexWorker routes host turns to the host worker", async () => {
  const worker = new ExecutionModeRoutedCodexWorker(createWorker("host"), createWorker("docker"));

  const threadId = await worker.ensureThread(createContext());
  const events = await collectEvents(worker.runTurn(createContext()));

  assert.equal(threadId, "host-thread");
  assert.deepEqual(events, [
    {
      kind: "thread_bound",
      threadId: "host-thread"
    }
  ]);
});

test("ExecutionModeRoutedCodexWorker routes docker kimi turns to the docker worker", async () => {
  const worker = new ExecutionModeRoutedCodexWorker(createWorker("host"), createWorker("docker"));

  const context = createContext({
    cli: "kimi",
    executionMode: "docker"
  });
  const threadId = await worker.ensureThread(context);
  const events = await collectEvents(worker.runTurn(context));

  assert.equal(threadId, "docker-thread");
  assert.deepEqual(events, [
    {
      kind: "thread_bound",
      threadId: "docker-thread"
    }
  ]);
});
