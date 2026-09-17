import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import type { IncomingChatMessage } from "../domain/types.js";
import { FileBackedChatWorkspaceResolver } from "./chat-workspace-resolver.js";

function createMessage(overrides: Partial<IncomingChatMessage> = {}): IncomingChatMessage {
  return {
    chatId: "oc_group_1",
    chatType: "group",
    messageId: "om_group_1",
    senderId: "ou_user_1",
    senderName: "user-1",
    senderType: "user",
    text: "hello",
    mentionsBot: false,
    raw: {},
    ...overrides
  };
}

test("FileBackedChatWorkspaceResolver resolves a configured existing group workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-workspace-resolver-"));
  const workspaceRoot = join(root, "workspace");
  const actualWorkspace = join(workspaceRoot, "projects", "alpha");
  const configFilePath = join(workspaceRoot, ".codex-feishu-bot", "chat-workspaces.json");

  await mkdir(actualWorkspace, { recursive: true });
  await mkdir(join(workspaceRoot, ".codex-feishu-bot"), { recursive: true });
  await writeFile(
    configFilePath,
    JSON.stringify({
      oc_group_1: {
        workspace: "projects/alpha"
      }
    }),
    "utf8"
  );

  const resolver = new FileBackedChatWorkspaceResolver(workspaceRoot, configFilePath);
  const result = await resolver.resolve({
    message: createMessage()
  });

  assert.deepEqual(result, {
    ok: true,
    workspaceId: actualWorkspace,
    cli: "kimi",
    provider: undefined,
    model: undefined,
    thinking: undefined
  });
});

test("FileBackedChatWorkspaceResolver rejects group messages when configured workspace is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-workspace-resolver-"));
  const workspaceRoot = join(root, "workspace");
  const configFilePath = join(workspaceRoot, ".codex-feishu-bot", "chat-workspaces.json");

  await mkdir(join(workspaceRoot, ".codex-feishu-bot"), { recursive: true });
  await writeFile(
    configFilePath,
    JSON.stringify({
      oc_group_1: {
        workspace: "projects/missing"
      }
    }),
    "utf8"
  );

  const resolver = new FileBackedChatWorkspaceResolver(workspaceRoot, configFilePath);
  const result = await resolver.resolve({
    message: createMessage()
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected missing workspace resolution to fail");
  }
  assert.equal(result.reason, "group_workspace_missing");
  assert.match(result.detail, /目录不存在/);
});

test("FileBackedChatWorkspaceResolver rejects group messages when configured workspace is outside root", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-workspace-resolver-"));
  const workspaceRoot = join(root, "workspace");
  const configFilePath = join(workspaceRoot, ".codex-feishu-bot", "chat-workspaces.json");

  await mkdir(join(workspaceRoot, ".codex-feishu-bot"), { recursive: true });
  await writeFile(
    configFilePath,
    JSON.stringify({
      oc_group_1: {
        workspace: "/tmp/outside-root"
      }
    }),
    "utf8"
  );

  const resolver = new FileBackedChatWorkspaceResolver(workspaceRoot, configFilePath);
  const result = await resolver.resolve({
    message: createMessage()
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected outside-root workspace resolution to fail");
  }
  assert.equal(result.reason, "group_workspace_invalid");
  assert.match(result.detail, /映射根/);
});

test("FileBackedChatWorkspaceResolver allows direct messages to use the default workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-workspace-resolver-"));
  const workspaceRoot = join(root, "workspace");
  const configFilePath = join(workspaceRoot, ".codex-feishu-bot", "chat-workspaces.json");
  const resolver = new FileBackedChatWorkspaceResolver(workspaceRoot, configFilePath);

  const result = await resolver.resolve({
    message: createMessage({
      chatId: "ou_p2p_1",
      chatType: "p2p"
    })
  });

  assert.deepEqual(result, {
    ok: true,
    workspaceId: workspaceRoot,
    cli: "codex",
    provider: undefined,
    model: undefined,
    thinking: undefined
  });
});

test("FileBackedChatWorkspaceResolver defaults legacy group bindings to kimi", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-workspace-resolver-"));
  const workspaceRoot = join(root, "workspace");
  const actualWorkspace = join(workspaceRoot, "Quant");
  const configFilePath = join(workspaceRoot, ".codex-feishu-bot", "chat-workspaces.json");

  await mkdir(actualWorkspace, { recursive: true });
  await mkdir(join(workspaceRoot, ".codex-feishu-bot"), { recursive: true });
  await writeFile(
    configFilePath,
    JSON.stringify({
      oc_group_1: {
        workspace: "Quant"
      }
    }),
    "utf8"
  );

  const resolver = new FileBackedChatWorkspaceResolver(workspaceRoot, configFilePath);
  const result = await resolver.resolve({
    message: createMessage()
  });

  assert.deepEqual(result, {
    ok: true,
    workspaceId: actualWorkspace,
    cli: "kimi",
    provider: undefined,
    model: undefined,
    thinking: undefined
  });

  const normalized = JSON.parse(await readFile(configFilePath, "utf8")) as Record<
    string,
    { workspace: string; cli: string }
  >;
  assert.equal(normalized.oc_group_1?.cli, "kimi");
});

test("FileBackedChatWorkspaceResolver lists numbered workspace catalog entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-workspace-resolver-"));
  const workspaceRoot = join(root, "workspace");

  await mkdir(join(workspaceRoot, "Quant", "project-a"), { recursive: true });
  await mkdir(join(workspaceRoot, "Quant", "project-b"), { recursive: true });
  await mkdir(join(workspaceRoot, "Downloads"), { recursive: true });

  const resolver = new FileBackedChatWorkspaceResolver(
    workspaceRoot,
    join(workspaceRoot, ".codex-feishu-bot", "chat-workspaces.json")
  );
  const entries = await resolver.listCatalog();

  assert.deepEqual(
    entries.map((entry) => entry.workspace),
    ["Downloads", "Quant"]
  );
  assert.deepEqual(
    entries.map((entry) => entry.code),
    ["1", "2"]
  );
});

test("FileBackedChatWorkspaceResolver lists and binds a directory symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-workspace-resolver-"));
  const workspaceRoot = join(root, "workspace");
  const linkedWorkspace = join(root, "quant_lib");
  const workspaceLink = join(workspaceRoot, "quantlib");
  const configFilePath = join(workspaceRoot, ".codex-feishu-bot", "chat-workspaces.json");

  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(linkedWorkspace, { recursive: true });
  await symlink(linkedWorkspace, workspaceLink, "dir");
  await writeFile(join(root, "not-a-directory"), "file", "utf8");
  await symlink(join(root, "not-a-directory"), join(workspaceRoot, "file-link"));
  await symlink(join(root, "missing"), join(workspaceRoot, "broken-link"));

  const resolver = new FileBackedChatWorkspaceResolver(workspaceRoot, configFilePath);
  const entries = await resolver.listCatalog();

  assert.deepEqual(entries, [
    {
      code: "1",
      workspace: "quantlib",
      workspaceId: workspaceLink
    }
  ]);

  const bindResult = await resolver.bindGroupWorkspace({
    chatId: "oc_group_1",
    cli: "codex",
    code: "1"
  });
  assert.equal(bindResult.ok, true);

  const resolution = await resolver.resolve({
    message: createMessage()
  });
  assert.deepEqual(resolution, {
    ok: true,
    workspaceId: workspaceLink,
    cli: "codex",
    provider: undefined,
    model: "gpt-6-astra",
    thinking: "high"
  });

  const persistedBindings = JSON.parse(await readFile(configFilePath, "utf8")) as Record<
    string,
    { model: string; thinking: string }
  >;
  assert.equal(persistedBindings.oc_group_1?.model, "gpt-6-astra");
  assert.equal(persistedBindings.oc_group_1?.thinking, "high");
});

test("FileBackedChatWorkspaceResolver binds a group to a numbered workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-workspace-resolver-"));
  const workspaceRoot = join(root, "workspace");
  const configFilePath = join(workspaceRoot, ".codex-feishu-bot", "chat-workspaces.json");

  await mkdir(join(workspaceRoot, "Quant", "project-a"), { recursive: true });

  const resolver = new FileBackedChatWorkspaceResolver(workspaceRoot, configFilePath);
  const bindResult = await resolver.bindGroupWorkspace({
    chatId: "oc_group_1",
    cli: "claude",
    code: "1"
  });

  assert.equal(bindResult.ok, true);
  if (!bindResult.ok) {
    throw new Error("expected bindGroupWorkspace to succeed");
  }
  assert.equal(bindResult.entry.workspace, "Quant");

  const persistedBindings = JSON.parse(await readFile(configFilePath, "utf8")) as Record<
    string,
    { workspace: string; cli: string }
  >;
  assert.deepEqual(persistedBindings, {
    oc_group_1: {
      workspace: "Quant",
      cli: "claude",
    }
  });
});


test("FileBackedChatWorkspaceResolver binds Codex 5.6 Sol with an explicit thinking depth", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-workspace-resolver-"));
  const workspaceRoot = join(root, "workspace");
  const configFilePath = join(workspaceRoot, ".codex-feishu-bot", "chat-workspaces.json");

  await mkdir(join(workspaceRoot, "Quant"), { recursive: true });

  const resolver = new FileBackedChatWorkspaceResolver(workspaceRoot, configFilePath);
  const result = await resolver.bindGroupWorkspace({
    chatId: "oc_group_1",
    cli: "codex",
    code: "1",
    model: "5.6 Soul",
    thinking: "xhigh"
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("expected Codex binding to succeed");
  }
  assert.equal(result.model, "gpt-5.6-sol");
  assert.equal(result.thinking, "xhigh");

  const persistedBindings = JSON.parse(await readFile(configFilePath, "utf8")) as Record<
    string,
    { model: string; thinking: string }
  >;
  assert.equal(persistedBindings.oc_group_1?.model, "gpt-5.6-sol");
  assert.equal(persistedBindings.oc_group_1?.thinking, "xhigh");
});

test("FileBackedChatWorkspaceResolver keeps openmodel for a deepseek model binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-workspace-resolver-"));
  const workspaceRoot = join(root, "workspace");
  const configFilePath = join(workspaceRoot, ".codex-feishu-bot", "chat-workspaces.json");

  await mkdir(join(workspaceRoot, "Quant"), { recursive: true });

  const resolver = new FileBackedChatWorkspaceResolver(workspaceRoot, configFilePath);
  const result = await resolver.bindGroupWorkspace({
    chatId: "oc_group_1",
    cli: "pi",
    code: "1",
    provider: "openmodel",
    model: "deepseek-flash"
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("expected pi binding to succeed");
  }
  assert.equal(result.provider, "openmodel");
  assert.equal(result.model, "deepseek-flash");

  const persistedBindings = JSON.parse(await readFile(configFilePath, "utf8")) as Record<
    string,
    { provider?: string; model?: string }
  >;
  assert.equal(persistedBindings.oc_group_1?.provider, "openmodel");
  assert.equal(persistedBindings.oc_group_1?.model, "deepseek-flash");
});

test("FileBackedChatWorkspaceResolver keeps openmodel for GLM pi bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-workspace-resolver-"));
  const workspaceRoot = join(root, "workspace");
  const configFilePath = join(workspaceRoot, ".codex-feishu-bot", "chat-workspaces.json");

  await mkdir(join(workspaceRoot, "Quant"), { recursive: true });

  const resolver = new FileBackedChatWorkspaceResolver(workspaceRoot, configFilePath);
  const result = await resolver.bindGroupWorkspace({
    chatId: "oc_group_1",
    cli: "pi",
    code: "1",
    model: "glm-5.3-flash"
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("expected pi GLM binding to succeed");
  }
  assert.equal(result.provider, "openmodel");
  assert.equal(result.model, "glm-5.3-flash");
});

test("FileBackedChatWorkspaceResolver rejects unsupported Codex model and thinking values", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-workspace-resolver-"));
  const workspaceRoot = join(root, "workspace");
  const configFilePath = join(workspaceRoot, ".codex-feishu-bot", "chat-workspaces.json");
  const resolver = new FileBackedChatWorkspaceResolver(workspaceRoot, configFilePath);

  const invalidModel = await resolver.bindGroupWorkspace({
    chatId: "oc_group_1",
    cli: "codex",
    code: "1",
    model: "gpt-5.4"
  });
  assert.equal(invalidModel.ok, false);
  if (invalidModel.ok) {
    throw new Error("expected unsupported Codex model to fail");
  }
  assert.equal(invalidModel.reason, "unsupported_codex_model");

  const invalidThinking = await resolver.bindGroupWorkspace({
    chatId: "oc_group_1",
    cli: "codex",
    code: "1",
    thinking: "minimal"
  });
  assert.equal(invalidThinking.ok, false);
  if (invalidThinking.ok) {
    throw new Error("expected unsupported Codex thinking to fail");
  }
  assert.equal(invalidThinking.reason, "unsupported_codex_thinking");
});

test("FileBackedChatWorkspaceResolver accepts every Codex thinking depth exposed by app-server", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-workspace-resolver-"));
  const workspaceRoot = join(root, "workspace");
  const configFilePath = join(workspaceRoot, ".codex-feishu-bot", "chat-workspaces.json");
  await mkdir(join(workspaceRoot, "Quant"), { recursive: true });

  const resolver = new FileBackedChatWorkspaceResolver(workspaceRoot, configFilePath);
  for (const thinking of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
    const result = await resolver.bindGroupWorkspace({
      chatId: `oc_group_${thinking}`,
      cli: "codex",
      code: "1",
      thinking
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error(`expected ${thinking} Codex thinking to succeed`);
    }
    assert.equal(result.thinking, thinking);
  }
});


test("FileBackedChatWorkspaceResolver supports pi in host mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-workspace-resolver-"));
  const workspaceRoot = join(root, "workspace");
  const actualWorkspace = join(workspaceRoot, "Quant");
  const configFilePath = join(workspaceRoot, ".codex-feishu-bot", "chat-workspaces.json");

  await mkdir(actualWorkspace, { recursive: true });
  await mkdir(join(workspaceRoot, ".codex-feishu-bot"), { recursive: true });
  await writeFile(
    configFilePath,
    JSON.stringify({
      oc_group_1: {
        workspace: "Quant",
        cli: "pi",
      }
    }),
    "utf8"
  );

  const resolver = new FileBackedChatWorkspaceResolver(workspaceRoot, configFilePath);
  const result = await resolver.resolve({
    message: createMessage()
  });

  assert.deepEqual(result, {
    ok: true,
    workspaceId: actualWorkspace,
    cli: "pi",
    provider: undefined,
    model: undefined,
    thinking: undefined
  });
});



