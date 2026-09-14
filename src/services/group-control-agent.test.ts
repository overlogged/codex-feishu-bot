import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        text: '{"kind":"bind_workspace","cli":"claude","code":"2"}'
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
        code: "2",
        provider: undefined,
        model: undefined,
        thinking: undefined
      }
    ],
    threadId: "thread_control_1",
    cli: "codex"
  });
  assert.equal(runTurnCalls, 1);
  assert.match(lastPrompt, /多动作时返回/);
  assert.match(lastPrompt, /2: Quant/);
  assert.match(lastPrompt, /model=gpt-6-astra/);
  assert.match(lastPrompt, /model=gpt-5\.6-sol/);
  assert.match(lastPrompt, /thinking 默认返回 high/);
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
    threadId: "thread_control_existing",
    cli: "codex"
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
    threadId: "thread_control_recovered",
    cli: "codex"
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

test("CodexGroupControlAgent interprets one-time schedule intents", async () => {
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
        text: '{"kind":"create_one_time_schedule","runAt":"2026-07-01T18:30:00+08:00","prompt":"检查线上流水线"}'
      };
    }
  };

  const agent = new CodexGroupControlAgent(worker, "/home/overlogged");
  const result = await agent.interpret(
    createMessage({
      text: "@托帕 临时任务：今天 18:30 检查线上流水线"
    }),
    {
      catalog: [],
      scheduledTasks: [
        {
          chatId: "oc_group_1",
          taskId: "1",
          kind: "once",
          runAt: "2026-07-01T10:30:00.000Z",
          prompt: "旧临时任务",
          status: "enabled",
          createdAt: "2026-07-01T09:00:00.000Z",
          updatedAt: "2026-07-01T09:00:00.000Z",
          nextRunAt: "2026-07-01T10:30:00.000Z"
        }
      ],
      currentBinding: {
        configured: true,
        cli: "codex",
        workspaceId: "/home/overlogged/Quant"
      }
    }
  );

  assert.deepEqual(result.intents, [
    {
      kind: "create_one_time_schedule",
      prompt: "检查线上流水线",
      runAt: "2026-07-01T18:30:00+08:00"
    }
  ]);
  assert.match(lastPrompt, /"kind":"create_one_time_schedule"/);
  assert.match(lastPrompt, /当前时间（Asia\/Shanghai）/);
  assert.match(lastPrompt, /once \| runAt=2026-07-01T10:30:00.000Z/);
  assert.doesNotMatch(lastPrompt, /不支持一次性/);
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
  assert.match(lastPrompt, /当前群 Codex native goal：\n旧 goal/);
  assert.match(lastPrompt, /"kind":"set_goal"/);
  assert.match(lastPrompt, /goal 指 Codex 原生 \/goal 功能/);
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
        text: '{"kind":"bind_workspace","cli":"pi","code":"2"}'
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
      code: "2",
      provider: undefined,
      model: undefined,
      thinking: undefined
    }
  ]);
  assert.match(result.threadId, /^pending:group-control:oc_group_1:/);
});

test("CodexGroupControlAgent interprets DeepSeek V4 Pro bind intent as V4.1 Flash", async () => {
  const worker: CodexWorker = {
    async ensureThread() {
      return "thread_should_not_be_used";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      yield {
        kind: "assistant_message_completed",
        itemId: "final_1",
        text: '{"kind":"bind_workspace","cli":"deepseek","code":"2","model":"deepseek-flash"}'
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
      code: "2",
      provider: undefined,
      model: "deepseek-flash",
      thinking: undefined
    }
  ]);
});

test("CodexGroupControlAgent interprets GLM flash bind intent as pi with openmodel provider", async () => {
  const worker: CodexWorker = {
    async ensureThread() {
      return "thread_should_not_be_used";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      yield {
        kind: "assistant_message_completed",
        itemId: "final_1",
        text: '{"kind":"bind_workspace","cli":"glm","code":"2","provider":"openmodel","model":"glm-5.3-flash"}'
      };
    }
  };

  const agent = new CodexGroupControlAgent(worker, "/home/overlogged");
  const result = await agent.interpret(
    createMessage({
      text: "@托帕 把这个群绑定到 openmodel 的 GLM 5.3 Flash 的 Quant"
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
      code: "2",
      provider: "openmodel",
      model: "glm-5.3-flash",
      thinking: undefined
    }
  ]);
});



test("CodexGroupControlAgent passes custom cli to runTurn", async () => {
  let capturedCli: string | undefined;
  let capturedModel: string | undefined;
  const worker: CodexWorker = {
    async ensureThread() {
      return "thread_should_not_be_used";
    },
    async *runTurn(context): AsyncGenerator<CodexEvent> {
      capturedCli = context.cli;
      capturedModel = context.model;
      yield {
        kind: "assistant_message_completed",
        itemId: "final_1",
        text: '{"kind":"show_binding"}'
      };
    }
  };

  const agent = new CodexGroupControlAgent(
    worker,
    "/home/overlogged",
    undefined,
    "pi",
    "deepseek-v4-flash"
  );
  const result = await agent.interpret(createMessage(), {
    catalog: [],
    scheduledTasks: [],
    currentBinding: {
      configured: false,
      detail: "未绑定"
    }
  });

  assert.equal(capturedCli, "pi");
  assert.equal(capturedModel, "deepseek-v4-flash");
  assert.deepEqual(result.intents, [{ kind: "show_binding" }]);
});

async function withCodexHome<T>(codexHome: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previous;
    }
  }
}

test("CodexGroupControlAgent recovers handoff context from the previous cli session file", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "control-handoff-codex-"));
  const sessionsDir = join(codexHome, "sessions", "2026", "06", "28");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, "rollout-2026-06-28T13-29-02-thread_control_old.jsonl"),
    [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "一堆 prompt\n用户原始消息：\n@托帕 绑定到 2 号目录\n\n用户消息（已去掉 @提及）：\n绑定到 2 号目录"
            }
          ]
        }
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: '{"kind":"bind_workspace","code":"2"}' }]
        }
      })
    ].join("\n"),
    "utf8"
  );

  const calledClis: string[] = [];
  let capturedPrompt = "";
  let capturedThreadId = "";
  const worker: CodexWorker = {
    async ensureThread() {
      return "thread_should_not_be_used";
    },
    async *runTurn(context): AsyncGenerator<CodexEvent> {
      calledClis.push(context.cli);
      capturedPrompt = context.message.text;
      capturedThreadId = context.threadId;
      yield {
        kind: "thread_bound",
        threadId: "pi_control_1"
      };
      yield {
        kind: "assistant_message_completed",
        itemId: "final_1",
        text: '{"kind":"show_binding"}'
      };
    }
  };

  const agent = new CodexGroupControlAgent(
    worker,
    "/home/overlogged",
    undefined,
    "pi",
    "deepseek-v4-flash"
  );
  const result = await withCodexHome(codexHome, () =>
    agent.interpret(
      createMessage(),
      {
        catalog: [],
        scheduledTasks: [],
        currentBinding: {
          configured: false,
          detail: "未绑定"
        }
      },
      {
        controlThreadId: "thread_control_old",
        controlThreadCli: "codex"
      }
    )
  );

  assert.deepEqual(calledClis, ["pi"]);
  assert.match(capturedThreadId, /^pending:group-control:oc_group_1:/);
  assert.match(capturedPrompt, /前序控制面交接摘要/);
  assert.match(capturedPrompt, /绑定到 2 号目录/);
  assert.equal(result.threadId, "pi_control_1");
  assert.equal(result.cli, "pi");
  assert.deepEqual(result.intents, [{ kind: "show_binding" }]);
});

test("CodexGroupControlAgent falls back to a live summary when the old session file is missing", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "control-handoff-empty-"));
  const calledClis: string[] = [];
  let capturedPrompt = "";
  const worker: CodexWorker = {
    async ensureThread() {
      return "thread_should_not_be_used";
    },
    async *runTurn(context): AsyncGenerator<CodexEvent> {
      calledClis.push(context.cli);
      if (context.cli === "codex") {
        assert.equal(context.threadId, "thread_control_old");
        yield {
          kind: "assistant_message_completed",
          itemId: "summary_1",
          text: "之前把这个群绑到了 Quant 的 2 号目录"
        };
        return;
      }

      capturedPrompt = context.message.text;
      yield {
        kind: "thread_bound",
        threadId: "pi_control_1"
      };
      yield {
        kind: "assistant_message_completed",
        itemId: "final_1",
        text: '{"kind":"show_binding"}'
      };
    }
  };

  const agent = new CodexGroupControlAgent(
    worker,
    "/home/overlogged",
    undefined,
    "pi",
    "deepseek-v4-flash"
  );
  const result = await withCodexHome(codexHome, () =>
    agent.interpret(
      createMessage(),
      {
        catalog: [],
        scheduledTasks: [],
        currentBinding: {
          configured: false,
          detail: "未绑定"
        }
      },
      {
        controlThreadId: "thread_control_old",
        controlThreadCli: "codex"
      }
    )
  );

  assert.deepEqual(calledClis, ["codex", "pi"]);
  assert.match(capturedPrompt, /前序控制面交接摘要/);
  assert.match(capturedPrompt, /之前把这个群绑到了 Quant 的 2 号目录/);
  assert.equal(result.threadId, "pi_control_1");
  assert.equal(result.cli, "pi");
});
