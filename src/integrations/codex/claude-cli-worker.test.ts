import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildClaudeArgs, claudeProcessEnv, ClaudeCliWorker, ClaudeStreamProjector } from "./claude-cli-worker.js";
import type { Env } from "../../config/env.js";
import type { CodexTurnContext } from "./codex-worker.js";

test("Claude creates the first session, resumes persisted turns and honors a bound model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-args-"));
  try {
    const context: CodexTurnContext & { threadId: string } = {
      cli: "claude", workspaceId: "/work/my_project", threadId: "9f074d7e-a84d-436e-a532-7ffb20a3e595",
      message: { chatId: "test", chatType: "group", messageId: "m1", senderId: "u", senderName: "tester", senderType: "user", text: "hello", mentionsBot: false, raw: {} }
    };
    const first = await buildClaudeArgs(context, dir);
    assert.ok(first.includes("--session-id"));
    assert.ok(first.includes("--dangerously-skip-permissions"));
    assert.ok(!first.includes("--model"));
    await mkdir(join(dir, "projects", "-work-my-project"), { recursive: true });
    await writeFile(join(dir, "projects", "-work-my-project", "9f074d7e-a84d-436e-a532-7ffb20a3e595.jsonl"), "{}\n");
    const resumed = await buildClaudeArgs({ ...context, model: "claude-opus-5-5" }, dir);
    assert.ok(resumed.includes("--resume"));
    assert.ok(!resumed.includes("--session-id"));
    assert.equal(resumed[resumed.indexOf("--model") + 1], "claude-opus-5-5");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Claude proxy stays isolated from the parent and other backends", () => {
  const source = { HTTPS_PROXY: "http://old:1", ALL_PROXY: "socks5://old:2", HOME: "/home/test" };
  assert.equal(claudeProcessEnv(undefined, source).HTTPS_PROXY, undefined);
  const env = claudeProcessEnv("http://dedicated:3", source);
  assert.equal(env.HTTPS_PROXY, "http://dedicated:3");
  assert.equal(env.ALL_PROXY, undefined);
  assert.equal(env.HOME, source.HOME);
  assert.equal(source.HTTPS_PROXY, "http://old:1");
});

test("Claude normalizes pending first-turn and persisted invalid IDs before spawning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-session-"));
  try {
    const script = join(dir, "fake-claude.mjs");
    await writeFile(script, `
      await new Promise(resolve => process.stdin.once('data', chunk => {
        console.log(chunk.toString().trim()); resolve();
      }));
      const args = process.argv.slice(2);
      const id = args[args.indexOf('--session-id') + 1];
      if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) process.exit(1);
      console.log(JSON.stringify({type:'result',session_id:id,result:id}));
    `);
    const worker = new ClaudeCliWorker({ CLAUDE_CLI_COMMAND: `${process.execPath} ${script}` } as Env);
    const context: CodexTurnContext = {
      cli: "claude", workspaceId: dir,
      message: { chatId: "test", chatType: "group", messageId: "m1", senderId: "u", senderName: "tester", senderType: "user", text: "hello", mentionsBot: false, raw: {} }
    };
    const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
    for (const threadId of ["pending:test:123", "/old/pi/session.jsonl", "invalid"]) {
      const events = [];
      for await (const event of worker.runTurn({ ...context, threadId })) events.push(event);
      const bound = events.find((event) => event.kind === "thread_bound");
      assert.ok(bound && bound.kind === "thread_bound");
      assert.match(bound.threadId, uuid);
      const final = events.find((event) => event.kind === "assistant_message_completed");
      assert.ok(final && final.kind === "assistant_message_completed");
      assert.equal(final.text, bound.threadId);
      const session = { chatId: "test", cli: "claude" as const, workspaceId: dir, threadId, updatedAt: new Date().toISOString() };
      assert.match(await worker.ensureThread({ ...context, session }), uuid);
      assert.equal(await worker.ensureThread({ ...context, session: { ...session, threadId: bound.threadId } }), bound.threadId);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Claude projects stage summaries and tool state without copying private payloads", () => {
  const stream = new ClaudeStreamProjector("turn");
  const events = stream.consume(JSON.stringify({ type: "assistant", message: { content: [
    { type: "thinking", thinking: "private reasoning" },
    { type: "text", text: "我先检查项目文档。" },
    { type: "tool_use", id: "tool1", name: "Read", input: { token: "secret" } }
  ] } }));
  assert.ok(events.some((e) => e.kind === "assistant_message_completed" && e.text === "我先检查项目文档。"));
  assert.ok(events.some((e) => e.kind === "tool_call_started" && e.itemId === "tool1"));
  assert.doesNotMatch(JSON.stringify(events), /private reasoning|secret/);
  assert.deepEqual(stream.consume(JSON.stringify({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "tool1", is_error: true, content: "private output" }
  ] } })), [{ kind: "tool_call_completed", itemId: "tool1", status: "failed" }]);
  assert.deepEqual(stream.consume(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "最终结论" }] } })), []);
  assert.deepEqual(stream.consume(JSON.stringify({ type: "result", result: "最终结论" })), []);
  assert.equal(stream.finalText(), "最终结论");
});

test("Claude shows a compact tool status even when there is no assistant prose", () => {
  const stream = new ClaudeStreamProjector("turn");
  const events = stream.consume(JSON.stringify({ type: "assistant", message: { content: [
    { type: "tool_use", id: "tool1", name: "Bash", input: { command: "secret command" } }
  ] } }));
  assert.ok(events.some((e) => e.kind === "assistant_message_completed" && e.text.includes("Bash")));
  assert.doesNotMatch(JSON.stringify(events), /secret command/);
  assert.match(JSON.stringify(stream.finish()), /已结束/);
});

test("Claude delivers intermediate output before child exit, including split JSONL chunks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-stream-"));
  try {
    const release = join(dir, "release");
    const script = join(dir, "fake-claude.mjs");
    await writeFile(script, `
      import { existsSync } from 'node:fs';
      await new Promise(resolve => process.stdin.once('data', chunk => {
        console.log(chunk.toString().trim()); resolve();
      }));
      const text = JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'检查文档中'},{type:'tool_use',id:'read1',name:'Read'}]}})+'\\n';
      process.stdout.write(text.slice(0,30));
      await new Promise(r=>setTimeout(r,30));
      process.stdout.write(text.slice(30));
      const start=Date.now();
      while (!existsSync(${JSON.stringify(release)}) && Date.now()-start<2000) await new Promise(r=>setTimeout(r,10));
      console.log(JSON.stringify({type:'result',result:existsSync(${JSON.stringify(release)})?'streamed':'buffered'}));
    `);
    const worker = new ClaudeCliWorker({ CLAUDE_CLI_COMMAND: `${process.execPath} ${script}` } as Env);
    let final = "";
    for await (const event of worker.runTurn({ cli: "claude", workspaceId: dir, threadId: "pending:test",
      message: { chatId: "test", chatType: "group", messageId: "m1", senderId: "u", senderName: "tester", senderType: "user", text: "hello", mentionsBot: false, raw: {} }
    })) {
      if (event.kind === "assistant_message_completed") {
        if (event.text === "检查文档中") await writeFile(release, "continue");
        else final = event.text;
      }
    }
    assert.equal(final, "streamed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Claude native steer keeps one process and waits past interim results for every new input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-steer-"));
  try {
    const script = join(dir, "fake-claude.mjs");
    await writeFile(script, `
      import { createInterface } from 'node:readline';
      const inputs=[];
      const emit=e=>console.log(JSON.stringify(e));
      for await (const line of createInterface({input:process.stdin})) {
        const input=JSON.parse(line); inputs.push(input);
        if(inputs.length===1) {
          emit(input);
          emit({type:'assistant',message:{content:[{type:'tool_use',id:'ready',name:'Read'}]}});
        } else if(inputs.length===2) {
          emit({type:'result',result:'',queued_turn_count:1});
          emit(input);
        } else {
          emit(input);
          emit({type:'result',result:'old response',queued_turn_count:1});
          await new Promise(r=>setTimeout(r,30));
          emit({type:'result',result:JSON.stringify({pid:process.pid,priorities:inputs.map(i=>i.priority),contents:inputs.map(i=>i.message.content)}),queued_turn_count:0});
        }
      }
    `);
    const starts: number[] = [];
    const steers: number[] = [];
    const worker = new ClaudeCliWorker({ CLAUDE_CLI_COMMAND: `${process.execPath} ${script}` } as Env, {
      info(data: any, msg: unknown) {
        if(msg === "开始执行 Claude CLI turn") starts.push(data.pid);
        if(msg === "已向运行中的 Claude 会话追加 steer 消息") steers.push(data.pid);
      }, warn() {}, error() {}
    });
    assert.equal(worker.supportsSteer(), true);
    const context: CodexTurnContext = {cli:"claude",workspaceId:dir,message:{chatId:"test",chatType:"group",messageId:"m1",senderId:"u",senderName:"tester",senderType:"user",text:"first",mentionsBot:false,raw:{}}};
    let threadId="pending:test", turnId="", final="";
    for await (const event of worker.runTurn({...context,threadId})) {
      if(event.kind === "thread_bound") threadId=event.threadId;
      if(event.kind === "turn_bound") turnId=event.turnId;
      if(event.kind === "tool_call_started") {
        for (const text of ["second", "third"]) {
          await worker.steerTurn({...context,threadId,turnId,message:{...context.message,messageId:text,text}});
        }
      }
      if(event.kind === "assistant_message_completed" && event.itemId.startsWith("final:")) final=event.text;
      assert.notEqual(event.kind, "error");
    }
    const result=JSON.parse(final);
    assert.equal(starts.length, 1);
    assert.deepEqual(steers, [starts[0],starts[0]]);
    assert.equal(result.pid, starts[0]);
    assert.deepEqual(result.priorities, ["next", "now", "now"]);
    assert.match(result.contents[1], /second/);
    assert.match(result.contents[2], /third/);
    await assert.rejects(worker.steerTurn({...context,threadId,turnId}), {code:"CLAUDE_TURN_FINISHED"});
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("Claude reports an error when the streaming child exits without a final result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-eof-"));
  try {
    const script = join(dir, "fake-claude.mjs");
    await writeFile(script, `process.stdin.once('data', chunk => { console.log(chunk.toString().trim()); process.exit(0); });`);
    const worker = new ClaudeCliWorker({ CLAUDE_CLI_COMMAND: `${process.execPath} ${script}` } as Env);
    const events = [];
    for await (const event of worker.runTurn({cli:"claude",workspaceId:dir,threadId:"pending:test",message:{chatId:"test",chatType:"group",messageId:"m1",senderId:"u",senderName:"tester",senderType:"user",text:"first",mentionsBot:false,raw:{}}})) events.push(event);
    assert.ok(events.some(e=>e.kind === "error" && e.message.includes("提前退出")));
    assert.ok(!events.some(e=>e.kind === "assistant_message_completed" && e.itemId.startsWith("final:")));
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("explicit Claude cancellation still stops the active process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-cancel-"));
  try {
    const script = join(dir, "fake-claude.mjs");
    await writeFile(script, `process.stdin.on('data', chunk => console.log(chunk.toString().trim()));`);
    const worker = new ClaudeCliWorker({ CLAUDE_CLI_COMMAND: `${process.execPath} ${script}` } as Env);
    const context: CodexTurnContext = {cli:"claude",workspaceId:dir,message:{chatId:"test",chatType:"group",messageId:"m1",senderId:"u",senderName:"tester",senderType:"user",text:"first",mentionsBot:false,raw:{}}};
    let threadId="pending:test", error="";
    for await (const event of worker.runTurn({...context,threadId})) {
      if(event.kind === "thread_bound") threadId=event.threadId;
      if(event.kind === "turn_bound") await worker.interruptTurn({...context,threadId,turnId:event.turnId,interruptionMessage:"手动停止"});
      if(event.kind === "error") error=event.message;
    }
    assert.equal(error,"手动停止");
  } finally { await rm(dir,{recursive:true,force:true}); }
});
