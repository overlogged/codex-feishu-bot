import assert from "node:assert/strict";
import test from "node:test";
import { applyAcpBindingSettings } from "./acp-binding-settings.js";

test("ACP settings use advertised IDs and grouped values and reject unsupported bindings", async () => {
  const calls: string[][] = [];
  const session = {
    configOptions: [
      { id: "gateway", category: "provider", options: [{ value: "p", name: "Gateway" }] },
      { id: "model-id", category: "model", options: [{ group: "Models", options: [{ value: "m", name: "Model" }] }] },
      { id: "reasoning_effort", options: [{ value: "high", name: "High" }] }
    ],
    async setConfigOption(id: string, value: string) { calls.push([id, value]); }
  };
  await applyAcpBindingSettings(session, { provider: "Gateway", model: "m", thinking: "high" });
  assert.deepEqual(calls, [["gateway", "p"], ["model-id", "m"], ["reasoning_effort", "high"]]);
  await assert.rejects(applyAcpBindingSettings(session, { model: "missing" }), /不支持/);
  await assert.rejects(applyAcpBindingSettings({ ...session, configOptions: [] }, { provider: "p" }), /未提供/);
  await applyAcpBindingSettings({ ...session, configOptions: [] }, {});
});
