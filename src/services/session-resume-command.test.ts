import assert from "node:assert/strict";
import test from "node:test";

import type { ChatSession } from "../domain/types.js";
import {
  buildSessionResumeCommand,
  renderSessionResumeLine
} from "./session-resume-command.js";

function buildSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    chatId: "oc_chat",
    threadId: "thread-123",
    cli: "kimi",
    workspaceId: "/home/user/work",
    updatedAt: new Date().toISOString(),
    ...overrides
  } as ChatSession;
}

test("buildSessionResumeCommand renders per-CLI resume commands", () => {
  assert.equal(
    buildSessionResumeCommand("codex", "abc", "/home/user/work"),
    "cd /home/user/work && codex resume abc"
  );
  assert.equal(
    buildSessionResumeCommand("kimi", "abc", "/home/user/work", { kimi: "/home/user/.kimi-code/bin/kimi" }),
    "cd /home/user/work && /home/user/.kimi-code/bin/kimi --session abc"
  );
  assert.equal(
    buildSessionResumeCommand("claude", "abc", "/home/user/work", { claude: "cl" }),
    "cd /home/user/work && cl --resume abc"
  );
  assert.equal(
    buildSessionResumeCommand("pi", "/home/user/.pi/agent/sessions/x.jsonl", "/home/user/work"),
    "cd /home/user/work && pi --session /home/user/.pi/agent/sessions/x.jsonl"
  );
});

test("buildSessionResumeCommand quotes arguments containing whitespace", () => {
  assert.equal(
    buildSessionResumeCommand("kimi", "thread 1", "/home/user/my work"),
    'cd "/home/user/my work" && kimi --session "thread 1"'
  );
});

test("renderSessionResumeLine renders the resume command for a matching session", () => {
  const line = renderSessionResumeLine(
    { cli: "kimi", workspaceId: "/home/user/work" },
    buildSession(),
    { kimi: "/home/user/.kimi-code/bin/kimi" }
  );
  assert.equal(
    line,
    "本机恢复会话：cd /home/user/work && /home/user/.kimi-code/bin/kimi --session thread-123"
  );
});

test("renderSessionResumeLine reports no session when thread is pending or mismatched", () => {
  const binding = { cli: "kimi", workspaceId: "/home/user/work" } as const;
  assert.match(renderSessionResumeLine(binding, undefined), /暂无/);
  assert.match(
    renderSessionResumeLine(binding, buildSession({ threadId: "pending:oc_chat:1" })),
    /暂无/
  );
  assert.match(renderSessionResumeLine(binding, buildSession({ cli: "codex" })), /暂无/);
  assert.match(
    renderSessionResumeLine(binding, buildSession({ workspaceId: "/other" })),
    /暂无/
  );
});
