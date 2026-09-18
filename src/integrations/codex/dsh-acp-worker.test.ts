import assert from "node:assert/strict";
import type { ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";
import test from "node:test";

import type { CodexEvent, IncomingChatMessage } from "../../domain/types.js";
import { DshAcpWorker } from "./dsh-acp-worker.js";
import type { KimiAcpRuntime } from "./kimi-acp-worker.js";

function createFakeDshRuntime(): {
  runtime: KimiAcpRuntime;
  spawnOptions: Array<{ args: string[]; cwd: string }>;
} {
  const spawnOptions: Array<{ args: string[]; cwd: string }> = [];
  const runtime: KimiAcpRuntime = {
    spawnProcess(options) {
      spawnOptions.push({ args: options.args, cwd: options.context.workspaceId });
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = new EventEmitter() as ChildProcessByStdio<Writable, Readable, Readable>;
      Object.assign(child, {
        stdin,
        stdout,
        stderr,
        killed: false,
        exitCode: null,
        kill() {
          (child as { killed: boolean }).killed = true;
          child.emit("close", 0, null);
          return true;
        }
      });

      const write = (message: Record<string, unknown>) => {
        stdout.write(`${JSON.stringify(message)}\n`);
      };

      let buffer = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf("\n");
          if (!line) {
            continue;
          }

          const message = JSON.parse(line) as { id?: number; method?: string };
          if (message.method === "initialize" && message.id !== undefined) {
            write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
            continue;
          }

          if (message.method === "session/new" && message.id !== undefined) {
            write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "dsh_session_1" } });
            continue;
          }

          if (message.method === "session/prompt" && message.id !== undefined) {
            const id = message.id;
            setImmediate(() => {
              write({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: "dsh_session_1",
                  update: {
                    sessionUpdate: "agent_thought_chunk",
                    content: { type: "text", text: "先想一下。" }
                  }
                }
              });
              write({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: "dsh_session_1",
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "OK" }
                  }
                }
              });
              write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
            });
            continue;
          }

          if (message.method === "session/cancel") {
            continue;
          }
        }
      });

      return {
        child,
        stop: async () => {
          (child as { killed: boolean }).killed = true;
          child.emit("close", 0, null);
        }
      };
    }
  };

  return { runtime, spawnOptions };
}

function buildMessage(): IncomingChatMessage {
  return {
    chatId: "oc_dsh_test",
    chatType: "group",
    messageId: "om_dsh_test",
    senderId: "ou_test",
    senderName: "tester",
    senderType: "user",
    text: "处理一下",
    mentionsBot: false,
    raw: {}
  };
}

async function collectEvents(worker: DshAcpWorker, threadId: string): Promise<CodexEvent[]> {
  const events: CodexEvent[] = [];
  for await (const event of worker.runTurn({
    cli: "dsh",
    workspaceId: "/tmp/dsh-workspace",
    message: buildMessage(),
    threadId
  })) {
    events.push(event);
  }
  return events;
}

test("DshAcpWorker runs a turn over ACP and binds the new session", async () => {
  const { runtime, spawnOptions } = createFakeDshRuntime();
  const worker = new DshAcpWorker(
    { DSH_ACP_COMMAND: "dsh", DSH_ACP_PROFILE: "acp" },
    undefined,
    runtime
  );

  const events = await collectEvents(worker, "pending:dsh-acp:test");

  assert.deepEqual(
    events.map((event) => event.kind),
    [
      "turn_bound",
      "run_status",
      "thread_bound",
      "assistant_message_started",
      "assistant_message_delta",
      "assistant_message_started",
      "assistant_message_delta",
      "assistant_message_completed",
      "assistant_message_completed"
    ]
  );
  const threadBound = events.find((event) => event.kind === "thread_bound");
  assert.equal(
    threadBound?.kind === "thread_bound" && threadBound.threadId,
    "dsh_session_1"
  );
  assert.ok(
    events.some(
      (event) =>
        event.kind === "assistant_message_completed" &&
        event.text === "OK" &&
        event.itemId.includes(":final")
    )
  );
  assert.deepEqual(spawnOptions, [{ args: ["--profile", "acp"], cwd: "/tmp/dsh-workspace" }]);

  await worker.close();
});

test("DshAcpWorker ensureThread returns a pending dsh thread id", async () => {
  const { runtime } = createFakeDshRuntime();
  const worker = new DshAcpWorker(
    { DSH_ACP_COMMAND: "dsh", DSH_ACP_PROFILE: "acp" },
    undefined,
    runtime
  );

  const threadId = await worker.ensureThread({
    cli: "dsh",
    workspaceId: "/tmp",
    message: buildMessage()
  });
  assert.match(threadId, /^pending:dsh-acp:/);

  await worker.close();
});
