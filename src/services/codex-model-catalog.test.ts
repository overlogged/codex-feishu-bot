import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexModelCatalogFile, findCodexBindingModel, getCodexModelCatalog, normalizeCodexBindingModel } from "./codex-model-catalog.js";
import { FileBackedChatWorkspaceResolver } from "./chat-workspace-resolver.js";

const initial = {
  defaultModel: "gpt-6-astra", defaultThinking: "high",
  models: [{ id: "gpt-6-astra", aliases: ["GPT6", "6"] }, { id: "gpt-6.1-sol", aliases: ["6.1 Sol"] }]
};

test("hot reload updates model aliases, defaults and existing resolver without restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-models-"));
  const path = join(root, "models.json");
  const previous = process.env.CODEX_BINDING_MODELS_FILE;
  process.env.CODEX_BINDING_MODELS_FILE = path;
  try {
    await writeFile(path, JSON.stringify(initial));
    await mkdir(join(root, "project"));
    const resolver = new FileBackedChatWorkspaceResolver(root, join(root, ".bindings.json"));
    assert.equal(findCodexBindingModel("codex gpt-6.1-sol high 12"), "gpt-6.1-sol");
    assert.equal(findCodexBindingModel("codex 6"), undefined);
    assert.equal(normalizeCodexBindingModel("future sol"), undefined);
    const updated = { ...initial, defaultModel: "test-future-model", defaultThinking: "xhigh", models: [...initial.models, { id: "test-future-model", aliases: ["future sol"] }] };
    await writeFile(path, JSON.stringify(updated));
    assert.equal(normalizeCodexBindingModel("Future_Sol"), "test-future-model");
    assert.equal(findCodexBindingModel("codex future sol high 12"), "test-future-model");
    assert.equal(getCodexModelCatalog().defaultThinking, "xhigh");
    const result = await resolver.bindGroupWorkspace({ chatId: "test", cli: "codex", code: "1" });
    assert.ok(result.ok);
    assert.equal(result.model, "test-future-model");
    assert.equal(result.thinking, "xhigh");
    await writeFile(path, "{");
    assert.equal(normalizeCodexBindingModel("future sol"), "test-future-model");
    await writeFile(path, JSON.stringify(initial));
    assert.equal(normalizeCodexBindingModel("future sol"), undefined);
    assert.equal(normalizeCodexBindingModel(), "gpt-6-astra");
  } finally {
    if (previous === undefined) delete process.env.CODEX_BINDING_MODELS_FILE;
    else process.env.CODEX_BINDING_MODELS_FILE = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid startup configuration and retains valid config on invalid reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-models-invalid-"));
  const path = join(root, "models.json");
  const file = new CodexModelCatalogFile(path);
  try {
    assert.throws(() => file.read(), /Cannot load/);
    await writeFile(path, JSON.stringify(initial));
    assert.equal(file.read().defaultModel, initial.defaultModel);
    for (const bad of [
      { ...initial, defaultModel: "missing" },
      { ...initial, defaultThinking: "invalid" },
      { ...initial, models: [...initial.models, { id: "other", aliases: ["GPT6"] }] },
      { ...initial, models: [...initial.models, initial.models[0]] }
    ]) {
      await writeFile(path, JSON.stringify(bad));
      assert.deepEqual(file.read(), initial);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
