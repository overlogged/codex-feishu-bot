import assert from "node:assert/strict";
import test from "node:test";

import {
  extractKimiSessionId,
  KimiStreamProjector,
  parseKimiStreamLine
} from "./kimi-cli-worker.js";

test("parseKimiStreamLine extracts assistant text and tool calls", () => {
  const parsed = parseKimiStreamLine(
    JSON.stringify({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "我先检查一下仓库状态。"
        }
      ],
      tool_calls: [
        {
          id: "call_1",
          function: {
            name: "Shell",
            arguments: JSON.stringify({
              command: "git status --short"
            })
          }
        }
      ],
      session_id: "kimi-session-1"
    })
  );

  assert.deepEqual(parsed, {
    role: "assistant",
    text: "我先检查一下仓库状态。",
    toolCalls: [
      {
        id: "call_1",
        name: "Shell",
        arguments: {
          command: "git status --short"
        }
      }
    ],
    toolCallId: undefined,
    toolName: undefined,
    sessionId: "kimi-session-1"
  });
});

test("KimiStreamProjector turns stream-json lines into commentary, tool, and final events", () => {
  const projector = new KimiStreamProjector("turn_1");

  const firstBatch = projector.ingestLine(
    JSON.stringify({
      role: "assistant",
      content: "我先看看 git 状态。",
      tool_calls: [
        {
          id: "call_1",
          function: {
            name: "Shell",
            arguments: JSON.stringify({
              command: "git status --short"
            })
          }
        }
      ]
    })
  );
  assert.equal(firstBatch.length, 0);

  const secondBatch = projector.ingestLine(
    JSON.stringify({
      role: "tool",
      tool_call_id: "call_1",
      name: "Shell",
      content: " M README.md"
    })
  );
  assert.deepEqual(secondBatch, [
    {
      kind: "assistant_message_started",
      itemId: "assistant:turn_1:1",
      source: "commentary"
    },
    {
      kind: "assistant_message_completed",
      itemId: "assistant:turn_1:1",
      text: "我先看看 git 状态。"
    },
    {
      kind: "tool_call_started",
      itemId: "tool:turn_1:1",
      title: "执行命令",
      command: "git status --short"
    },
    {
      kind: "tool_call_delta",
      itemId: "tool:turn_1:1",
      output: "M README.md",
      detail: "M README.md"
    },
    {
      kind: "tool_call_completed",
      itemId: "tool:turn_1:1",
      title: "调用 Shell",
      status: "completed",
      output: "M README.md"
    }
  ]);

  const thirdBatch = projector.ingestLine(
    JSON.stringify({
      role: "assistant",
      content: "README.md 有本地改动。"
    })
  );
  assert.equal(thirdBatch.length, 0);

  const finalBatch = projector.finalize({
    sessionId: "9a8e0a1c-0abc-4af2-8fd1-7487c908e3a2"
  });
  assert.deepEqual(finalBatch, [
    {
      kind: "thread_bound",
      threadId: "9a8e0a1c-0abc-4af2-8fd1-7487c908e3a2"
    },
    {
      kind: "assistant_message_started",
      itemId: "assistant:turn_1:2",
      source: "final_answer"
    },
    {
      kind: "assistant_message_completed",
      itemId: "assistant:turn_1:2",
      text: "README.md 有本地改动。"
    }
  ]);
});

test("KimiStreamProjector keeps commentary and fails when the CLI exits with an error", () => {
  const projector = new KimiStreamProjector("turn_2");

  projector.ingestLine(
    JSON.stringify({
      role: "assistant",
      content: "我已经开始处理这个请求。"
    })
  );

  const events = projector.finalize({
    errorMessage: "Kimi CLI 执行失败。"
  });

  assert.deepEqual(events, [
    {
      kind: "assistant_message_started",
      itemId: "assistant:turn_2:1",
      source: "commentary"
    },
    {
      kind: "assistant_message_completed",
      itemId: "assistant:turn_2:1",
      text: "我已经开始处理这个请求。"
    },
    {
      kind: "error",
      message: "Kimi CLI 执行失败。"
    }
  ]);
});

test("extractKimiSessionId parses resume hints from raw output", () => {
  assert.equal(
    extractKimiSessionId("To resume this session: kimi -r 01234567-89ab-cdef-0123-456789abcdef"),
    "01234567-89ab-cdef-0123-456789abcdef"
  );
});
