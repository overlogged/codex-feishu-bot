import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderCatalogFile, getProviderCatalog, normalizeCliName, resolveConfiguredSelection } from "./provider-catalog.js";
import { FileBackedChatWorkspaceResolver } from "./chat-workspace-resolver.js";
import { buildPiRpcArgs } from "../integrations/codex/pi-rpc-worker.js";
import { CodexGroupControlAgent } from "./group-control-agent.js";
import { ClaudeProviderService } from "./claude-provider-service.js";
import type { IncomingChatMessage } from "../domain/types.js";

const message: IncomingChatMessage = { chatId: "test", chatType: "group", messageId: "test", senderId: "test", senderName: "test", senderType: "user", text: "hello", mentionsBot: true, raw: {} };

test("all backend configuration reloads in existing resolver, control agent, Pi args and Claude provider service", async () => {
  const root = await mkdtemp(join(tmpdir(), "providers-hot-"));
  const file = join(root, "providers.json");
  const previous = process.env.CHAT_PROVIDER_CONFIG_FILE;
  const source = await readFile(new URL("../../config/providers.json", import.meta.url), "utf8");
  await writeFile(file, source);
  process.env.CHAT_PROVIDER_CONFIG_FILE = file;
  try {
    await mkdir(join(root, "project"));
    const resolver = new FileBackedChatWorkspaceResolver(root, join(root, ".bindings.json"));
    let prompt = "";
    const agent = new CodexGroupControlAgent({
      async ensureThread() { return "unused"; },
      async *runTurn(context) {
        prompt = context.message.text;
        yield { kind: "assistant_message_completed" as const, itemId: "final", text: '{"kind":"help","detail":"ok"}' };
      }
    }, root);
    const control = { catalog: [], scheduledTasks: [], currentBinding: { configured: false as const, detail: "none" } };
    await agent.interpret(message, control);
    assert.doesNotMatch(prompt, /test-gateway/);
    let switched = false;
    const claude = new ClaudeProviderService("test", async (_, args) => {
      if (args[3] === "switch") { assert.equal(args[4], "test-gateway"); switched = true; }
      return `│ ${switched ? "✓" : " "} ┆ test-gateway ┆ Test ┆ N/A │`;
    });
    const config = JSON.parse(source);
    for (const cli of ["claude", "kimi", "pi", "dsh", "mcode", "devin"]) {
      const backend = config.backends[cli];
      backend.nativeSettings = false;
      backend.aliases.push(`test-${cli}`);
      backend.models.push({ id: `${cli}-future`, aliases: ["future model"] });
      backend.defaultModel = `${cli}-future`;
    }
    config.backends.pi.providers.push({ id: "test-gateway", aliases: ["test gateway"] });
    config.backends.pi.defaultProvider = "test-gateway";
    config.backends.pi.models.at(-1).providerModels = { "test-gateway": "upstream/future" };
    config.backends.claude.providers.push({ id: "test-gateway", aliases: ["new provider"] });
    await writeFile(file, JSON.stringify(config));
    for (const cli of ["claude", "kimi", "pi", "dsh", "mcode", "devin"] as const) {
      assert.equal(normalizeCliName(`test-${cli}`), cli);
      const bound = await resolver.bindGroupWorkspace({ chatId: cli, cli, code: "1", model: "future model" });
      assert.ok(bound.ok);
      assert.equal(bound.model, `${cli}-future`);
      const resolved = await resolver.resolve({ message: { ...message, chatId: cli } });
      assert.ok(resolved.ok);
      assert.equal(resolved.model, `${cli}-future`);
    }
    const args = buildPiRpcArgs({ PI_CLI_PROVIDER: "openrouter", PI_CLI_MODEL: "deepseek-flash", PI_CLI_THINKING: "high" }, { cli: "pi", workspaceId: root, message }, "/tmp/test-session");
    assert.equal(args[args.indexOf("--provider") + 1], "test-gateway");
    assert.equal(args[args.indexOf("--model") + 1], "upstream/future");
    await agent.interpret(message, control);
    assert.match(prompt, /test-gateway/);
    assert.match(prompt, /test-devin/);
    assert.match(await claude.execute({ action: "switch", query: "new provider" }), /已切换/);
    await writeFile(file, "{");
    assert.equal(getProviderCatalog().backends.pi.defaultProvider, "test-gateway");
    await writeFile(file, source);
    assert.equal(normalizeCliName("test-pi"), undefined);
    assert.deepEqual(resolveConfiguredSelection("dsh", { model: "invented" }), { model: undefined, provider: undefined, thinking: undefined });
  } finally {
    if (previous === undefined) delete process.env.CHAT_PROVIDER_CONFIG_FILE;
    else process.env.CHAT_PROVIDER_CONFIG_FILE = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects ambiguous aliases, invalid references and unsupported global-provider defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "providers-invalid-"));
  const path = join(root, "providers.json");
  const source = await readFile(new URL("../../config/providers.json", import.meta.url), "utf8");
  try {
    const reader = new ProviderCatalogFile(path);
    assert.throws(() => reader.read());
    await writeFile(path, source);
    const valid = reader.read();
    for (const mutate of [
      (c: any) => c.backends.pi.aliases.push("codex"),
      (c: any) => c.backends.pi.models.push({ id: "other", aliases: ["glm"] }),
      (c: any) => c.backends.pi.defaultProvider = "missing",
      (c: any) => c.backends.pi.defaultModel = "missing",
      (c: any) => { c.backends.claude.providers.push({ id: "global" }); c.backends.claude.defaultProvider = "global"; },
      (c: any) => c.backends.dsh.defaultModel = "invalid"
    ]) {
      const broken = JSON.parse(source); mutate(broken);
      await writeFile(path, JSON.stringify(broken));
      assert.deepEqual(reader.read(), valid);
      assert.throws(() => new ProviderCatalogFile(path).read());
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
