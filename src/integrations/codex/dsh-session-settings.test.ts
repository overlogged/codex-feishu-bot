import assert from "node:assert/strict";
import test from "node:test";
import { applyDshModelSelection } from "./dsh-session-settings.js";

const value = (provider: string, model: string) => JSON.stringify([provider, model]);
function session(current: string) {
  const calls: string[] = [];
  return {
    calls,
    configOptions: [{ id: "model", category: "model", currentValue: current, options: [
      { group: "deepseek-account", options: [
        { value: value("deepseek-account", "deepseek-flash"), name: "Flash" },
        { value: value("deepseek-account", "deepseek-v4-pro"), name: "Pro" }
      ] },
      { group: "opencode-go", options: [
        { value: value("opencode-go", "deepseek-v4.1-flash"), name: "Flash" },
        { value: value("opencode-go", "deepseek-v4-pro"), name: "Pro" },
        { value: value("opencode-go", "kimi-k3"), name: "Kimi K3" }
      ] }
    ] }],
    async setConfigOption(id: string, selected: string) {
      assert.equal(id, "model");
      calls.push(selected);
    }
  };
}

test("DSH provider-only changes translate the current model ID across providers", async () => {
  const acp = session(value("opencode-go", "deepseek-v4.1-flash"));
  await applyDshModelSelection(acp, { provider: "DeepSeek 账号" });
  assert.deepEqual(acp.calls, [value("deepseek-account", "deepseek-flash")]);
});

test("DSH model-only changes keep the current provider and accept advertised opaque values", async () => {
  const acp = session(value("opencode-go", "deepseek-v4.1-flash"));
  await applyDshModelSelection(acp, { model: "pro" });
  await applyDshModelSelection(acp, { model: value("deepseek-account", "deepseek-flash") });
  assert.deepEqual(acp.calls, [value("opencode-go", "deepseek-v4-pro"), value("deepseek-account", "deepseek-flash")]);
});

test("DSH ambiguous routes fail instead of silently choosing a billing source", async () => {
  const acp = session(value("another", "unknown"));
  await assert.rejects(applyDshModelSelection(acp, { model: "pro" }), /不唯一/);
  await assert.rejects(applyDshModelSelection(acp, { provider: "opencode-go" }), /不唯一/);
  await assert.rejects(applyDshModelSelection(acp, { provider: "missing", model: "pro" }), /未提供可用模型/);
  assert.deepEqual(acp.calls, []);
});

test("DSH supports legacy plain ACP model options and native selection", async () => {
  const calls: string[] = [];
  const acp = { configOptions: [{ id: "model", options: [{ name: "Old model", value: "old" }] }],
    async setConfigOption(id: string, value: string) { calls.push(`${id}:${value}`); } };
  await applyDshModelSelection(acp, {});
  assert.deepEqual(calls, []);
  await applyDshModelSelection(acp, { model: "old" });
  assert.deepEqual(calls, ["model:old"]);
});
