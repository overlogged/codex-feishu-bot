import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeProviderService, parseClaudeProviderCommand, parseClaudeProviders } from "./claude-provider-service.js";

const table = (current = "default") => [
  "│   ┆ ID       ┆ Name     ┆ API URL │",
  `│ ${current === "default" ? "✓" : " "} ┆ default  ┆ Default  ┆ N/A │`,
  `│ ${current === "ikuncode" ? "✓" : " "} ┆ ikuncode ┆ Ikun     ┆ https://secret@example.test/key │`
].join("\n");

test("provider commands require an explicit whole command", () => {
  for (const text of ["provider", "Claude providers", "供应商列表", "列出 claude provider"]) {
    assert.deepEqual(parseClaudeProviderCommand(text), { action: "list" });
  }
  assert.deepEqual(parseClaudeProviderCommand("切换 claude provider ikuncode"), { action: "switch", query: "ikuncode" });
  assert.equal(parseClaudeProviderCommand("帮我实现 provider 切换代码"), undefined);
});

test("lists only public provider fields and validates table format", async () => {
  assert.equal(parseClaudeProviders(table()).length, 2);
  assert.throws(() => parseClaudeProviders("unknown format"));
  const service = new ClaudeProviderService("cc-switch", async () => table());
  const report = await service.execute({ action: "list" });
  assert.match(report, /✓ default/);
  assert.match(report, /ikuncode/);
  assert.doesNotMatch(report, /secret|example.test/);
});

test("switches exact provider IDs or unique names through argv, confirms active provider", async () => {
  let current = "default";
  const calls: string[][] = [];
  const service = new ClaudeProviderService("cc-switch", async (_, args) => {
    calls.push(args);
    if (args[3] === "switch") current = args[4]!;
    return table(current);
  });
  assert.match(await service.execute({ action: "switch", query: "Ikun" }), /已切换/);
  assert.deepEqual(calls[1], ["-a", "claude", "provider", "switch", "ikuncode"]);
  const count = calls.length;
  assert.match(await service.execute({ action: "switch", query: "ikuncode; touch /tmp/injected" }), /未找到/);
  assert.equal(calls.length, count + 1);
});

test("CLI failures never leak stderr or credentials", async () => {
  const service = new ClaudeProviderService("cc-switch", async () => { throw new Error("API_KEY=secret-value"); });
  const result = await service.execute({ action: "list" });
  assert.match(result, /操作失败/);
  assert.doesNotMatch(result, /secret-value/);
});
