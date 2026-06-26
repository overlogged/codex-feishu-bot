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
  let runTurnCalls = 0;
  let lastPrompt = "";
  const worker: CodexWorker = {
    async ensureThread() {
      return "thread_should_not_be_used";
    },
    async *runTurn(context): AsyncGenerator<CodexEvent> {
      runTurnCalls += 1;
      lastPrompt = context.message.text;
      assert.equal(context.cli, "codex");
      assert.match(context.threadId, /^pending:group-control:oc_group_1:/);
      yield {
        kind: "thread_bound",
        threadId: "thread_control_1"
      };
      yield {
        kind: "assistant_message_completed",
        itemId: "final_1",
        text: '{"kind":"bind_workspace","cli":"claude","executionMode":"host","code":"2"}'
      };
    }
  };

  const agent = new CodexGroupControlAgent(worker, "/home/overlogged");
  const result = await agent.interpret(createMessage(), {
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

  assert.deepEqual(result, {
    intents: [
      {
        kind: "bind_workspace",
        cli: "claude",
        executionMode: "host",
        code: "2",
        provider: undefined,
        model: undefined,
        thinking: undefined
      }
    ],
    threadId: "thread_control_1"
  });
  assert.equal(runTurnCalls, 1);
  assert.match(lastPrompt, /多动作时返回/);
  assert.match(lastPrompt, /2: Quant/);
});

test("CodexGroupControlAgent reuses the existing control thread when provided", async () => {
  const worker: CodexWorker = {
    async ensureThread() {
      return "thread_should_not_be_used";
    },
    async *runTurn(context): AsyncGenerator<CodexEvent> {
      assert.equal(context.threadId, "thread_control_existing");
      yield {
        kind: "assistant_message_completed",
        itemId: "final_1",
        text: '{"kind":"show_binding"}'
      };
    }
  };

  const agent = new CodexGroupControlAgent(worker, "/home/overlogged");
  const result = await agent.interpret(
    createMessage({
      text: "@托帕 看看这个群现在绑到哪"
    }),
    {
      catalog: [],
      scheduledTasks: [],
      currentBinding: {
        configured: false,
        detail: "未绑定"
      }
    },
    {
      controlThreadId: "thread_control_existing"
    }
  );

  assert.deepEqual(result, {
    intents: [
      {
        kind: "show_binding"
      }
    ],
    threadId: "thread_control_existing"
  });
});

test("CodexGroupControlAgent falls back to a fresh control thread when the reused one has no rollout", async () => {
  const seenThreadIds: string[] = [];
  const worker: CodexWorker = {
    async ensureThread() {
      return "thread_should_not_be_used";
    },
    async *runTurn(context): AsyncGenerator<CodexEvent> {
      seenThreadIds.push(context.threadId);
      if (seenThreadIds.length === 1) {
        throw new Error(`no rollout found for thread id ${context.threadId}`);
      }

      assert.match(context.threadId, /^pending:group-control:oc_group_1:/);
      yield {
        kind: "thread_bound",
        threadId: "thread_control_recovered"
      };
      yield {
        kind: "assistant_message_completed",
        itemId: "final_1",
        text: '{"kind":"show_binding"}'
      };
    }
  };

  const agent = new CodexGroupControlAgent(worker, "/home/overlogged");
  const result = await agent.interpret(
    createMessage({
      text: "@托帕 看看这个群现在绑到哪"
    }),
    {
      catalog: [],
      scheduledTasks: [],
      currentBinding: {
        configured: false,
        detail: "未绑定"
      }
    },
    {
      controlThreadId: "thread_control_existing"
    }
  );

  assert.equal(seenThreadIds[0], "thread_control_existing");
  assert.match(seenThreadIds[1] ?? "", /^pending:group-control:oc_group_1:/);
  assert.deepEqual(result, {
    intents: [
      {
        kind: "show_binding"
      }
    ],
    threadId: "thread_control_recovered"
  });
});

test("CodexGroupControlAgent parses multiple actions from an actions array", async () => {
  const worker: CodexWorker = {
    async ensureThread() {
      return "thread_should_not_be_used";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      yield {
        kind: "assistant_message_completed",
        itemId: "final_1",
        text: '{"actions":[{"kind":"pause_schedule","taskId":"1"},{"kind":"update_schedule","taskId":"2","cron":"0 9 * * 1-5","prompt":"生成工作日报"}]}'
      };
    }
  };

  const agent = new CodexGroupControlAgent(worker, "/home/overlogged");
  const result = await agent.interpret(
    createMessage({
      text: "@托帕 暂停第一个定时任务，再把第二个改成工作日 9 点生成工作日报"
    }),
    {
      catalog: [],
      scheduledTasks: [],
      currentBinding: {
        configured: false,
        detail: "未绑定"
      }
    }
  );

  assert.deepEqual(result.intents, [
    {
      kind: "pause_schedule",
      taskId: "1"
    },
    {
      kind: "update_schedule",
      taskId: "2",
      cron: "0 9 * * 1-5",
      prompt: "生成工作日报"
    }
  ]);
  assert.match(result.threadId, /^pending:group-control:oc_group_1:/);
});

test("CodexGroupControlAgent interprets goal control intents", async () => {
  let lastPrompt = "";
  const worker: CodexWorker = {
    async ensureThread() {
      return "thread_should_not_be_used";
    },
    async *runTurn(context): AsyncGenerator<CodexEvent> {
      lastPrompt = context.message.text;
      yield {
        kind: "assistant_message_completed",
        itemId: "final_1",
        text: '{"actions":[{"kind":"set_goal","goal":"每次改代码前先看测试"},{"kind":"clear_goal"}]}'
      };
    }
  };

  const agent = new CodexGroupControlAgent(worker, "/home/overlogged");
  const result = await agent.interpret(
    createMessage({
      text: "@托帕 设置 goal 为每次改代码前先看测试，然后清除 goal"
    }),
    {
      catalog: [],
      scheduledTasks: [],
      goal: "旧 goal",
      currentBinding: {
        configured: true,
        cli: "codex",
        executionMode: "host",
        workspaceId: "/home/overlogged/Quant"
      }
    }
  );

  assert.deepEqual(result.intents, [
    {
      kind: "set_goal",
      goal: "每次改代码前先看测试"
    },
    {
      kind: "clear_goal"
    }
  ]);
  assert.match(lastPrompt, /当前群 goal：\n旧 goal/);
  assert.match(lastPrompt, /"kind":"set_goal"/);
  assert.match(lastPrompt, /goal 只影响后续 Codex 和 Pi 任务/);
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

test("CodexGroupControlAgent interprets pi bind intent", async () => {
  const worker: CodexWorker = {
    async ensureThread() {
      return "thread_should_not_be_used";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      yield {
        kind: "assistant_message_completed",
        itemId: "final_1",
        text: '{"kind":"bind_workspace","cli":"pi","executionMode":"host","code":"2"}'
      };
    }
  };

  const agent = new CodexGroupControlAgent(worker, "/home/overlogged");
  const result = await agent.interpret(
    createMessage({
      text: "@托帕 把这个群绑定到 pi 的 Quant"
    }),
    {
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
    }
  );

  assert.deepEqual(result.intents, [
    {
      kind: "bind_workspace",
      cli: "pi",
      executionMode: "host",
      code: "2",
      provider: undefined,
      model: undefined,
      thinking: undefined
    }
  ]);
  assert.match(result.threadId, /^pending:group-control:oc_group_1:/);
});

test("CodexGroupControlAgent interprets DeepSeek V4 Pro bind intent", async () => {
  const worker: CodexWorker = {
    async ensureThread() {
      return "thread_should_not_be_used";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      yield {
        kind: "assistant_message_completed",
        itemId: "final_1",
        text: '{"kind":"bind_workspace","cli":"deepseek","executionMode":"host","code":"2","model":"deepseek-v4-pro"}'
      };
    }
  };

  const agent = new CodexGroupControlAgent(worker, "/home/overlogged");
  const result = await agent.interpret(
    createMessage({
      text: "@托帕 把这个群绑定到 DeepSeek V4 Pro 的 Quant"
    }),
    {
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
    }
  );

  assert.deepEqual(result.intents, [
    {
      kind: "bind_workspace",
      cli: "pi",
      executionMode: "host",
      code: "2",
      provider: undefined,
      model: "deepseek-v4-pro",
      thinking: undefined
    }
  ]);
});

test("CodexGroupControlAgent interprets docker DS4 Flash bind intent", async () => {
  const worker: CodexWorker = {
    async ensureThread() {
      return "thread_should_not_be_used";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      yield {
        kind: "assistant_message_completed",
        itemId: "final_1",
        text: '{"kind":"bind_workspace","cli":"deepseek","executionMode":"docker","code":"2","model":"deepseek-v4-flash"}'
      };
    }
  };

  const agent = new CodexGroupControlAgent(worker, "/home/overlogged");
  const result = await agent.interpret(
    createMessage({
      text: "@托帕 把这个群绑定到 docker 的 DS4 Flash Quant"
    }),
    {
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
    }
  );

  assert.deepEqual(result.intents, [
    {
      kind: "bind_workspace",
      cli: "pi",
      executionMode: "docker",
      code: "2",
      provider: undefined,
      model: "deepseek-v4-flash",
      thinking: undefined
    }
  ]);
});

test("CodexGroupControlAgent normalizes ds dodocker bind intent", async () => {
  const worker: CodexWorker = {
    async ensureThread() {
      return "thread_should_not_be_used";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      yield {
        kind: "assistant_message_completed",
        itemId: "final_1",
        text: '{"kind":"bind_workspace","cli":"ds","executionMode":"dodocker","code":"2"}'
      };
    }
  };

  const agent = new CodexGroupControlAgent(worker, "/home/overlogged");
  const result = await agent.interpret(
    createMessage({
      text: "@托帕 ds dodocker Quant"
    }),
    {
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
    }
  );

  assert.deepEqual(result.intents, [
    {
      kind: "bind_workspace",
      cli: "pi",
      executionMode: "docker",
      code: "2",
      provider: undefined,
      model: undefined,
      thinking: undefined
    }
  ]);
});

test("CodexGroupControlAgent passes custom cli to runTurn", async () => {
  let capturedCli: string | undefined;
  const worker: CodexWorker = {
    async ensureThread() {
      return "thread_should_not_be_used";
    },
    async *runTurn(context): AsyncGenerator<CodexEvent> {
      capturedCli = context.cli;
      yield {
        kind: "assistant_message_completed",
        itemId: "final_1",
        text: '{"kind":"show_binding"}'
      };
    }
  };

  const agent = new CodexGroupControlAgent(worker, "/home/overlogged", undefined, "claude");
  const result = await agent.interpret(createMessage(), {
    catalog: [],
    scheduledTasks: [],
    currentBinding: {
      configured: false,
      detail: "未绑定"
    }
  });

  assert.equal(capturedCli, "claude");
  assert.deepEqual(result.intents, [{ kind: "show_binding" }]);
});
