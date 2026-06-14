import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    executionMode: "host",
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
    executionMode: "host",
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
    executionMode: "host",
    provider: undefined,
    model: undefined,
    thinking: undefined
  });

  const normalized = JSON.parse(await readFile(configFilePath, "utf8")) as Record<
    string,
    { workspace: string; cli: string; executionMode: string }
  >;
  assert.equal(normalized.oc_group_1?.cli, "kimi");
  assert.equal(normalized.oc_group_1?.executionMode, "host");
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

test("FileBackedChatWorkspaceResolver binds a group to a numbered workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-workspace-resolver-"));
  const workspaceRoot = join(root, "workspace");
  const configFilePath = join(workspaceRoot, ".codex-feishu-bot", "chat-workspaces.json");

  await mkdir(join(workspaceRoot, "Quant", "project-a"), { recursive: true });

  const resolver = new FileBackedChatWorkspaceResolver(workspaceRoot, configFilePath);
  const bindResult = await resolver.bindGroupWorkspace({
    chatId: "oc_group_1",
    cli: "claude",
    executionMode: "host",
    code: "1"
  });

  assert.equal(bindResult.ok, true);
  if (!bindResult.ok) {
    throw new Error("expected bindGroupWorkspace to succeed");
  }
  assert.equal(bindResult.entry.workspace, "Quant");

  const persistedBindings = JSON.parse(await readFile(configFilePath, "utf8")) as Record<
    string,
    { workspace: string; cli: string; executionMode: string }
  >;
  assert.deepEqual(persistedBindings, {
    oc_group_1: {
      workspace: "Quant",
      cli: "claude",
      executionMode: "host"
    }
  });
});

test("FileBackedChatWorkspaceResolver supports docker mode for codex bindings", async () => {
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
        cli: "codex",
        executionMode: "docker"
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
    cli: "codex",
    executionMode: "docker",
    provider: undefined,
    model: undefined,
    thinking: undefined
  });
});

test("FileBackedChatWorkspaceResolver supports docker mode for kimi bindings", async () => {
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
        cli: "kimi",
        executionMode: "docker"
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
    executionMode: "docker",
    provider: undefined,
    model: undefined,
    thinking: undefined
  });
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
        executionMode: "host"
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
    executionMode: "host",
    provider: undefined,
    model: undefined,
    thinking: undefined
  });
});

test("FileBackedChatWorkspaceResolver accepts docker mode for pi", async () => {
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
        executionMode: "docker",
        provider: "openrouter",
        model: "deepseek-v4-flash",
        thinking: "medium"
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
    executionMode: "docker",
    provider: "openrouter",
    model: "deepseek-v4-flash",
    thinking: "medium"
  });
});

test("FileBackedChatWorkspaceResolver binds a group with docker pi and DeepSeek V4 Pro model", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-workspace-resolver-"));
  const workspaceRoot = join(root, "workspace");
  const configFilePath = join(workspaceRoot, ".codex-feishu-bot", "chat-workspaces.json");

  await mkdir(join(workspaceRoot, "Quant", "project-a"), { recursive: true });

  const resolver = new FileBackedChatWorkspaceResolver(workspaceRoot, configFilePath);
  const bindResult = await resolver.bindGroupWorkspace({
    chatId: "oc_group_1",
    cli: "pi",
    executionMode: "docker",
    code: "1",
    provider: "openrouter",
    model: "deepseek-v4-pro",
    thinking: "medium"
  });

  assert.equal(bindResult.ok, true);
  if (!bindResult.ok) {
    throw new Error("expected bindGroupWorkspace to succeed");
  }
  assert.equal(bindResult.entry.workspace, "Quant");
  assert.equal(bindResult.model, "deepseek-v4-pro");
  assert.equal(bindResult.provider, "openrouter");
  assert.equal(bindResult.thinking, "medium");

  const persistedBindings = JSON.parse(await readFile(configFilePath, "utf8")) as Record<
    string,
    {
      workspace: string;
      cli: string;
      executionMode: string;
      model: string;
      provider: string;
      thinking: string;
    }
  >;
  assert.equal(persistedBindings.oc_group_1?.cli, "pi");
  assert.equal(persistedBindings.oc_group_1?.executionMode, "docker");
  assert.equal(persistedBindings.oc_group_1?.model, "deepseek-v4-pro");
  assert.equal(persistedBindings.oc_group_1?.provider, "openrouter");
  assert.equal(persistedBindings.oc_group_1?.thinking, "medium");
});

test("FileBackedChatWorkspaceResolver rejects docker mode for claude", async () => {
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
        cli: "claude",
        executionMode: "docker"
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
    throw new Error("expected unsupported docker binding to fail");
  }
  assert.match(result.detail, /docker 模式暂时只支持 codex \/ kimi \/ pi/);
});
