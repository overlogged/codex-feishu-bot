import assert from "node:assert/strict";
import test from "node:test";

import type { CodexEvent, IncomingChatMessage } from "../domain/types.js";
import type { CodexWorker } from "../integrations/codex/codex-worker.js";
import { CodexGroupControlAgent } from "./group-control-agent.js";

function createMessage(overrides: Partial<IncomingChatMessage> = {}): IncomingChatMessage {
  return {
    chatId: "oc_group_1",
    chatType: "group",
    messageId: "om_group_1",
    senderId: "ou_user_1",
    senderName: "user-1",
    senderType: "user",
    text: "@托帕 把这个群绑定到 claude 的 Quant",
    mentionsBot: true,
    raw: {},
    ...overrides
  };
}

test("CodexGroupControlAgent interprets structured bind results from a fresh codex turn", async () => {
  let ensureThreadCalls = 0;
  let runTurnCalls = 0;
  let lastPrompt = "";
  const worker: CodexWorker = {
    async ensureThread(context) {
      ensureThreadCalls += 1;
      assert.equal(context.cli, "codex");
      assert.equal(context.workspaceId, "/home/overlogged");
      assert.equal(context.session, undefined);
      return "thread_control_1";
    },
    async *runTurn(context): AsyncGenerator<CodexEvent> {
      runTurnCalls += 1;
      lastPrompt = context.message.text;
      assert.match(context.threadId, /^pending:group-control:oc_group_1:/);
      yield {
        kind: "assistant_message_completed",
        itemId: "final_1",
        text: '{"kind":"bind_workspace","cli":"claude","executionMode":"host","code":"2"}'
      };
    }
  };

  const agent = new CodexGroupControlAgent(worker, "/home/overlogged");
  const intent = await agent.interpret(createMessage(), {
    catalog: [
      {
        code: "1",
        workspace: "Downloads",
        workspaceId: "/home/overlogged/Downloads"
      },
      {
        code: "2",
        workspace: "Quant",
        workspaceId: "/home/overlogged/Quant"
      }
    ],
    scheduledTasks: [],
    currentBinding: {
      configured: false,
      detail: "这个群还没有绑定工作区。"
    }
  });

  assert.deepEqual(intent, {
    kind: "bind_workspace",
    cli: "claude",
    executionMode: "host",
    code: "2"
  });
  assert.equal(ensureThreadCalls, 0);
  assert.equal(runTurnCalls, 1);
  assert.match(lastPrompt, /只返回一个 JSON 对象/);
  assert.match(lastPrompt, /2: Quant/);
});

test("CodexGroupControlAgent rejects missing final answers", async () => {
  const worker: CodexWorker = {
    async ensureThread() {
      return "thread_control_2";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      yield {
        kind: "assistant_message_started",
        itemId: "final_1",
        source: "final_answer"
      };
    }
  };

  const agent = new CodexGroupControlAgent(worker, "/home/overlogged");

  await assert.rejects(
    agent.interpret(createMessage(), {
      catalog: [],
      scheduledTasks: [],
      currentBinding: {
        configured: false,
        detail: "未绑定"
      }
    }),
    /没有返回可见结果/
  );
});
