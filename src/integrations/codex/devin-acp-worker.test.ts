import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { KimiAcpRuntime } from "./kimi-acp-worker.js";
import { DevinAcpWorker, resolveDevinModel } from "./devin-acp-worker.js";
import type { CodexTurnContext } from "./codex-worker.js";

function fakeRuntime(failLoad = false) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let processes = 0;
  const runtime: KimiAcpRuntime = { spawnProcess() {
    processes++;
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false, exitCode: null });
    const write = (data: unknown) => child.stdout.write(JSON.stringify(data) + "\n");
    let buffer = "";
    child.stdin.on("data", (chunk) => {
      buffer += String(chunk);
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        calls.push(request);
        if (request.method === "session/load" && failLoad) {
          write({ id: request.id, error: { code: -32000, message: "session missing" } }); continue;
        }
        if (request.method === "session/load") {
          write({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD HISTORY" } } } });
        }
        if (request.method === "session/prompt") {
          for (const update of [
            { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Checking" } },
            { sessionUpdate: "tool_call", toolCallId: "tool1", title: "Read file", status: "completed" },
            { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "DONE" } }
          ]) write({ method: "session/update", params: { update } });
        }
        write({ id: request.id, result: { ...(request.method === "session/new" ? { sessionId: `devin-${processes}` } : { stopReason: "end_turn" }), configOptions: modelCatalog } });
      }
    });
    return { child: child as never, stop: async () => { child.killed = true; child.emit("close", 0, null); } };
  } };
  return { runtime, calls, processes: () => processes };
}
const context: CodexTurnContext = { cli: "devin", workspaceId: "/tmp", message: {
  chatId: "chat", chatType: "group", messageId: "message", senderId: "user", senderName: "User", senderType: "user", text: "hello", mentionsBot: false, raw: {}
} };
async function collect(worker: DevinAcpWorker, threadId: string, workspaceId = "/tmp") {
  const events = [];
  for await (const event of worker.runTurn({ ...context, threadId, workspaceId })) events.push(event);
  return events;
}

test("Devin streams ACP text/tools, reuses sessions and isolates new threads/workspaces", async () => {
  const fake = fakeRuntime();
  const worker = new DevinAcpWorker({ DEVIN_ACP_COMMAND: "devin" }, undefined, fake.runtime);
  try {
    assert.equal(worker.supportsSteer(), false);
    const events = await collect(worker, "pending:devin:1");
    assert.ok(events.some(e => e.kind === "thread_bound" && e.threadId === "devin-1"));
    assert.ok(events.some(e => e.kind === "tool_call_started"));
    assert.ok(events.some(e => e.kind === "assistant_message_completed" && e.text === "DONE"));
    await collect(worker, "devin-1");
    assert.equal(fake.processes(), 1);
    await collect(worker, "pending:devin:2");
    assert.equal(fake.processes(), 2);
    await collect(worker, "pending:devin:3", "/other");
    assert.equal(fake.processes(), 3);
    assert.equal(fake.calls.filter(c => c.method === "session/set_config_option" && c.params.configId === "mode" && c.params.value === "bypass").length, 4);
  } finally { await worker.close(); }
});

test("Devin resumes persisted session with session/load without re-emitting old history", async () => {
  const fake = fakeRuntime();
  const worker = new DevinAcpWorker({ DEVIN_ACP_COMMAND: "devin" }, undefined, fake.runtime);
  try {
    const events = await collect(worker, "persisted-slug");
    assert.ok(fake.calls.some(c => c.method === "session/load" && c.params.sessionId === "persisted-slug"));
    assert.ok(!fake.calls.some(c => c.method === "session/new"));
    assert.ok(!JSON.stringify(events).includes("OLD HISTORY"));
  } finally { await worker.close(); }
});

test("Devin reports resume failure instead of silently losing conversation history", async () => {
  const fake = fakeRuntime(true);
  const worker = new DevinAcpWorker({ DEVIN_ACP_COMMAND: "devin" }, undefined, fake.runtime);
  try {
    await assert.rejects(collect(worker, "missing-session"), /session missing/);
    assert.ok(!fake.calls.some(c => c.method === "session/new"));
  } finally { await worker.close(); }
});

const modelCatalog = [{ id: "model", currentValue: "swe-2-high", options: [
  { value: "swe-2-high", name: "SWE-2 high" },
  { value: "claude-opus-5-5-medium", name: "Claude Opus 5.5 medium" },
  { value: "claude-opus-5-5-high", name: "Claude Opus 5.5 high" }
] }];

test("Devin resolves Opus aliases from live options and rejects unknown models", () => {
  for (const alias of ["claude-opus-5.5", "Claude Opus 5.5", "opus5.5"])
    assert.equal(resolveDevinModel(alias, modelCatalog), "claude-opus-5-5-medium");
  assert.equal(resolveDevinModel("claude-opus-5-5-high", modelCatalog), "claude-opus-5-5-high");
  assert.throws(() => resolveDevinModel("opus4", modelCatalog), /无法匹配模型/);
  assert.throws(() => resolveDevinModel("opus5.5", []), /未返回可用模型列表/);
});

test("Devin sends resolved model ID for both new and restored sessions", async () => {
  for (const threadId of ["pending:devin:opus", "persisted-opus"]) {
    const fake = fakeRuntime();
    const worker = new DevinAcpWorker({ DEVIN_ACP_COMMAND: "devin" }, undefined, fake.runtime);
    try {
      for await (const _event of worker.runTurn({ ...context, threadId, model: "claude-opus-5.5" })) { /* consume */ }
      assert.ok(fake.calls.some(c => c.method === "session/set_config_option" && c.params.configId === "model" && c.params.value === "claude-opus-5-5-medium"));
      assert.ok(fake.calls.some(c => c.method === "session/prompt"));
    } finally { await worker.close(); }
  }
});

test("concurrent Devin turns share one process and never replace each other's event handler", async () => {
  const fake = fakeRuntime();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let preparations = 0;
  fake.runtime.prepare = async () => { preparations++; await gate; };
  const worker = new DevinAcpWorker({ DEVIN_ACP_COMMAND: "devin" }, undefined, fake.runtime);
  try {
    const first = collect(worker, "pending:devin:race");
    const second = collect(worker, "pending:devin:race");
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(preparations, 1);
    release();
    const results = await Promise.all([first, second]);
    assert.equal(fake.processes(), 1);
    for (const events of results) {
      assert.equal(events.filter(e => e.kind === "assistant_message_completed" && e.text === "DONE").length, 1);
    }
    assert.equal(fake.calls.filter(c => c.method === "session/new").length, 1);
    assert.equal(fake.calls.filter(c => c.method === "session/prompt").length, 2);
  } finally { release(); await worker.close(); }
});

test("a failed Devin turn releases its lock for the next request", async () => {
  const fake = fakeRuntime();
  const worker = new DevinAcpWorker({ DEVIN_ACP_COMMAND: "devin" }, undefined, fake.runtime);
  try {
    await assert.rejects(async () => {
      for await (const _ of worker.runTurn({ ...context, threadId: "pending:devin:failure", model: "missing-model" })) {}
    }, /无法匹配/);
    assert.ok((await collect(worker, "pending:devin:failure")).some(e => e.kind === "assistant_message_completed"));
    assert.equal(fake.processes(), 1);
  } finally { await worker.close(); }
});
