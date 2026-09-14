import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readThreadTranscript,
  renderTranscriptExcerpt,
  unwrapUserVisibleText
} from "./thread-transcript.js";

async function withEnv<T>(overrides: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("readThreadTranscript reads pi session files by path", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-transcript-pi-"));
  const sessionPath = join(root, "session_1.jsonl");
  await writeFile(
    sessionPath,
    [
      JSON.stringify({ type: "session", version: 3, id: "s1" }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "继续挖因子" }] }
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "内部思考" },
            { type: "text", text: "好的，先看因子库" }
          ]
        }
      })
    ].join("\n"),
    "utf8"
  );

  const messages = await readThreadTranscript({
    cli: "pi",
    threadId: sessionPath,
    workspaceId: "/workspace"
  });

  assert.deepEqual(messages, [
    { role: "user", text: "继续挖因子" },
    { role: "assistant", text: "好的，先看因子库" }
  ]);
});

test("readThreadTranscript locates codex rollouts under CODEX_HOME", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-transcript-codex-"));
  const sessionsDir = join(root, "sessions", "2026", "06", "28");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, "rollout-2026-06-28T13-29-02-thread_abc.jsonl"),
    [
      JSON.stringify({ type: "session_meta", payload: { id: "thread_abc" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context>noise</environment_context>" }]
        }
      }),
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

  const messages = await withEnv({ CODEX_HOME: root }, () =>
    readThreadTranscript({
      cli: "codex",
      threadId: "thread_abc",
      workspaceId: "/workspace"
    })
  );

  assert.deepEqual(messages, [
    { role: "user", text: "分析一下库存" },
    { role: "assistant", text: "库存结构是这样" }
  ]);
});

test("readThreadTranscript reads kimi ACP session files", async () => {
  const home = await mkdtemp(join(tmpdir(), "thread-transcript-kimi-"));
  const workspaceId = "/workspace";
  const workspaceKey = "wd_workspace_0123456789ab";
  await mkdir(join(home, ".kimi-code"), { recursive: true });
  await writeFile(
    join(home, ".kimi-code", "workspaces.json"),
    JSON.stringify({
      version: 1,
      workspaces: { [workspaceKey]: { root: workspaceId, name: "workspace" } }
    }),
    "utf8"
  );

  const agentDir = join(
    home,
    ".kimi-code",
    "sessions",
    workspaceKey,
    "session_kimi_1",
    "agents",
    "main"
  );
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "wire.jsonl"),
    [
      JSON.stringify({ type: "metadata", protocol_version: "1.5" }),
      JSON.stringify({
        type: "agent.message.appended",
        message: { message: { role: "user", content: [{ type: "text", text: "日报写一下" }] } }
      }),
      JSON.stringify({
        type: "context.append_message",
        message: {
          role: "user",
          content: [{ type: "text", text: "日报写一下" }],
          origin: { kind: "user" }
        }
      }),
      JSON.stringify({
        type: "context.append_message",
        message: {
          role: "user",
          content: [{ type: "text", text: "<system-reminder>noise</system-reminder>" }],
          origin: { kind: "injection", variant: "date_change" }
        }
      }),
      JSON.stringify({
        type: "context.append_loop_event",
        event: { type: "content.part", part: { type: "think", think: "思考" } }
      }),
      JSON.stringify({
        type: "context.append_loop_event",
        event: { type: "content.part", part: { type: "text", text: "日报如下" } }
      })
    ].join("\n"),
    "utf8"
  );

  const messages = await withEnv({ HOME: home }, () =>
    readThreadTranscript({
      cli: "kimi",
      threadId: "session_kimi_1",
      workspaceId
    })
  );

  assert.deepEqual(messages, [
    { role: "user", text: "日报写一下" },
    { role: "assistant", text: "日报如下" }
  ]);
});

test("readThreadTranscript reads claude session files", async () => {
  const home = await mkdtemp(join(tmpdir(), "thread-transcript-claude-"));
  const projectDir = join(home, ".claude", "projects", "-workspace");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, "claude_thread_1.jsonl"),
    [
      JSON.stringify({ type: "file-history-snapshot", messageId: "m0" }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "<command-message>pela</command-message>" }
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "帮我看下实验结果" }
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "结果偏好" }] }
      })
    ].join("\n"),
    "utf8"
  );

  const messages = await withEnv({ HOME: home }, () =>
    readThreadTranscript({
      cli: "claude",
      threadId: "claude_thread_1",
      workspaceId: "/workspace"
    })
  );

  assert.deepEqual(messages, [
    { role: "user", text: "帮我看下实验结果" },
    { role: "assistant", text: "结果偏好" }
  ]);
});

test("readThreadTranscript returns undefined for pending or missing threads", async () => {
  assert.equal(
    await readThreadTranscript({
      cli: "codex",
      threadId: "pending:group:1",
      workspaceId: "/workspace"
    }),
    undefined
  );
  assert.equal(
    await readThreadTranscript({
      cli: "pi",
      threadId: "/nonexistent/session.jsonl",
      workspaceId: "/workspace"
    }),
    undefined
  );
});

test("unwrapUserVisibleText strips bridge and control wrappers", () => {
  assert.equal(
    unwrapUserVisibleText(
      "Controller instructions for the Feishu bridge environment:\n- line\n\nUser message:\n真正的问题"
    ),
    "真正的问题"
  );
  assert.equal(
    unwrapUserVisibleText("前面的 prompt\n用户原始消息：\n@托帕 绑定一下\n\n用户消息（已去掉 @提及）：\n绑定一下"),
    "@托帕 绑定一下"
  );
  assert.equal(unwrapUserVisibleText("普通文本"), "普通文本");
});

test("renderTranscriptExcerpt budgets messages and labels roles", () => {
  const excerpt = renderTranscriptExcerpt(
    [
      { role: "user", text: "第一个问题" },
      { role: "assistant", text: "第一个回答" },
      { role: "user", text: "第二个问题" }
    ],
    { maxMessages: 2, perMessageMaxLength: 100, totalMaxLength: 1000 }
  );

  assert.equal(excerpt, "[助手] 第一个回答\n[用户] 第二个问题");
});
