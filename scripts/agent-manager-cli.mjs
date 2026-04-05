#!/usr/bin/env node

const DEFAULT_BASE_URL = process.env.AGENT_MANAGER_BASE_URL ?? "http://127.0.0.1:3000";

function printHelp() {
  console.log(`Agent Manager CLI

用法:
  codex-feishu-agent help
  codex-feishu-agent main
  codex-feishu-agent list
  codex-feishu-agent show <chatId>
  codex-feishu-agent update [--chat-id <chatId>]
  codex-feishu-agent send-main --from <来源名> --content <消息内容>
  codex-feishu-agent send --chat-id <chatId> --from <来源名> --content <消息内容> [--mirror]
  codex-feishu-agent phone-send --content <消息内容> [--from <来源名>]
  codex-feishu-agent phone-recv [--chat-id <chatId>] [--after-id <消息ID>] [--source <commentary|final_answer|all>] [--limit <数量>] [--follow]

可选参数:
  --base-url <url>   默认是 ${DEFAULT_BASE_URL}

说明:
  1. main: 查看当前私聊主 session（最近一个私聊 session）
  2. list: 列出所有 session，包括群标题、当前状态、主要在做什么
  3. show: 查看某个 session 的详细摘要
  4. update: 用飞书接口回填旧快照里的 chat 类型和名称
  5. send-main: 给当前私聊主 session 注入消息，并同步在飞书私聊里发送“来自XX说：”
  6. send: 给指定 chatId 的 session 注入消息；默认只注入，不往飞书同步，带 --mirror 才同步
  7. phone-send: 电话桥发送模式。会自动在内容前加上“当前是电话模式”的提示，并要求最终回复使用可朗读纯文本
  8. phone-recv: 电话桥接收模式。只输出已经稳定的 assistant 文本消息，每行一条 JSON，带稳定 id

示例:
  codex-feishu-agent list
  codex-feishu-agent main
  codex-feishu-agent update
  codex-feishu-agent update --chat-id oc_xxx
  codex-feishu-agent send-main --from monitor --content "请汇报一下刚才的进度"
  codex-feishu-agent send --chat-id oc_xxx --from supervisor --content "改成先跑测试" --mirror
  codex-feishu-agent phone-send --content "请汇报一下当前进度"
  codex-feishu-agent phone-recv --follow
  codex-feishu-agent phone-recv --source final_answer --after-id <消息ID>

兼容调用:
  pnpm agent:cli <command>
`);
}

function consumeOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }

  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} 缺少值。`);
  }

  args.splice(index, 2);
  return value;
}

function consumeFlag(args, name) {
  const index = args.indexOf(name);
  if (index < 0) {
    return false;
  }

  args.splice(index, 1);
  return true;
}

async function requestJson(baseUrl, path, init) {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error ?? `请求失败：${response.status}`);
  }

  return payload;
}

async function readContent(args) {
  const content = consumeOption(args, "--content");
  if (content) {
    return content;
  }

  if (process.stdin.isTTY) {
    return undefined;
  }

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }

  const value = chunks.join("").trim();
  return value || undefined;
}

function buildPhoneModeContent(content) {
  return [
    "当前是电话模式。",
    "用户会通过电话直接收听你的最终回复。",
    "请先理解下面的用户内容。",
    "在最终回复时，只输出适合直接朗读的纯文本。",
    "不要使用 Markdown，不要使用表格，不要使用代码块，不要使用链接，不要使用表情，不要使用特殊符号。",
    "请用自然口语表达，句子简短清楚，信息完整。",
    "",
    "用户说：",
    content
  ].join("\n");
}

function printPhoneMessage(message) {
  process.stdout.write(
    `${JSON.stringify({
      id: message.id,
      chatId: message.chatId,
      title: message.title,
      runId: message.runId,
      itemId: message.itemId,
      source: message.source,
      phase: message.phase,
      content: message.content,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt
    })}\n`
  );
}

function printSession(session) {
  console.log(`${session.isMainPrivateSession ? "[main] " : ""}${session.title}`);
  console.log(`  chatId: ${session.chatId}`);
  console.log(`  chatType: ${session.chatType}`);
  console.log(`  cli: ${session.cli}`);
  console.log(`  executionMode: ${session.executionMode}`);
  console.log(`  workspace: ${session.workspaceId}`);
  console.log(`  threadId: ${session.threadId}`);
  console.log(`  runStatus: ${session.runStatus}`);
  console.log(`  focus: ${session.focus}`);
  if (session.chatName) {
    console.log(`  chatName: ${session.chatName}`);
  }
  if (session.lastSenderName) {
    console.log(`  lastSender: ${session.lastSenderName}`);
  }
  if (session.lastInboundAt) {
    console.log(`  lastInboundAt: ${session.lastInboundAt}`);
  }
  if (session.lastUserMessagePreview) {
    console.log(`  lastUserMessage: ${session.lastUserMessagePreview}`);
  }
  if (session.lastMessagePreview) {
    console.log(`  lastMessage: ${session.lastMessagePreview}`);
  }
  if (session.lastReplyPreview) {
    console.log(`  lastReply: ${session.lastReplyPreview}`);
  }
}

function printUpdateResult(payload) {
  console.log(
    `总计 ${payload.total} 个 session，更新 ${payload.updated} 个，未变化 ${payload.unchanged} 个，失败 ${payload.failed} 个。`
  );
  console.log("");
  for (const item of payload.results ?? []) {
    console.log(`${item.status === "updated" ? "[updated]" : item.status === "unchanged" ? "[unchanged]" : "[failed]"} ${item.title} (${item.chatId})`);
    if (Array.isArray(item.changedFields) && item.changedFields.length > 0) {
      console.log(`  changed: ${item.changedFields.join(", ")}`);
    }
    if (Array.isArray(item.warnings)) {
      for (const warning of item.warnings) {
        console.log(`  warning: ${warning}`);
      }
    }
    if (item.error) {
      console.log(`  error: ${item.error}`);
    }
    console.log("");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const baseUrl = consumeOption(args, "--base-url") ?? DEFAULT_BASE_URL;
  const command = args.shift() ?? "help";

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "main": {
      const payload = await requestJson(baseUrl, "/agent-manager/main-session");
      printSession(payload.session);
      return;
    }
    case "list":
    case "sessions": {
      const payload = await requestJson(baseUrl, "/agent-manager/sessions");
      if (!Array.isArray(payload.sessions) || payload.sessions.length === 0) {
        console.log("当前没有 session。");
        return;
      }

      for (const session of payload.sessions) {
        printSession(session);
        console.log("");
      }
      return;
    }
    case "show": {
      const chatId = args.shift();
      if (!chatId) {
        throw new Error("show 需要一个 chatId。");
      }

      const payload = await requestJson(
        baseUrl,
        `/agent-manager/sessions/${encodeURIComponent(chatId)}`
      );
      printSession(payload.session);
      return;
    }
    case "update": {
      const chatId = consumeOption(args, "--chat-id");
      const payload = await requestJson(baseUrl, "/agent-manager/sessions/update", {
        method: "POST",
        body: JSON.stringify({
          chatId
        })
      });
      printUpdateResult(payload);
      return;
    }
    case "send-main": {
      const from = consumeOption(args, "--from");
      const content = await readContent(args);
      if (!from || !content) {
        throw new Error("send-main 需要 --from 和 --content。");
      }

      const payload = await requestJson(baseUrl, "/agent-manager/main-session/messages", {
        method: "POST",
        body: JSON.stringify({
          from,
          content
        })
      });
      console.log(`已注入到主私聊 session：${payload.session.title} (${payload.session.chatId})`);
      console.log(`sourceMessageId: ${payload.sourceMessageId}`);
      console.log(payload.forwardedText);
      return;
    }
    case "send": {
      const chatId = consumeOption(args, "--chat-id");
      const from = consumeOption(args, "--from");
      const content = await readContent(args);
      const mirror = consumeFlag(args, "--mirror");
      if (!chatId || !from || !content) {
        throw new Error("send 需要 --chat-id、--from 和 --content。");
      }

      const payload = await requestJson(
        baseUrl,
        `/agent-manager/sessions/${encodeURIComponent(chatId)}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            from,
            content,
            mirrorToFeishu: mirror
          })
        }
      );
      console.log(`已注入到 session：${payload.session.title} (${payload.session.chatId})`);
      console.log(`sourceMessageId: ${payload.sourceMessageId}`);
      console.log(`mirroredToFeishu: ${payload.mirroredToFeishu}`);
      console.log(payload.forwardedText);
      return;
    }
    case "phone-send": {
      const from = consumeOption(args, "--from") ?? "phone-bridge";
      const content = await readContent(args);
      if (!content) {
        throw new Error("phone-send 需要 --content，或者从 stdin 传入消息内容。");
      }

      const payload = await requestJson(baseUrl, "/agent-manager/main-session/messages", {
        method: "POST",
        body: JSON.stringify({
          from,
          content: buildPhoneModeContent(content)
        })
      });
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          mode: "phone-send",
          chatId: payload.session.chatId,
          title: payload.session.title,
          sourceMessageId: payload.sourceMessageId,
          mirroredToFeishu: payload.mirroredToFeishu
        })}\n`
      );
      return;
    }
    case "phone-recv": {
      const chatId = consumeOption(args, "--chat-id");
      const afterIdOption = consumeOption(args, "--after-id");
      const sourceOption = consumeOption(args, "--source");
      const limitOption = consumeOption(args, "--limit");
      const follow = consumeFlag(args, "--follow");
      const intervalMs = Number.parseInt(
        consumeOption(args, "--poll-interval-ms") ?? "1500",
        10
      );
      const query = new URLSearchParams();
      let cursor = afterIdOption;
      if (sourceOption) {
        query.set("source", sourceOption);
      }
      if (limitOption) {
        query.set("limit", limitOption);
      }

      const buildPath = () => {
        const params = new URLSearchParams(query);
        if (cursor) {
          params.set("afterId", cursor);
        }
        const suffix = params.toString() ? `?${params.toString()}` : "";
        return chatId
          ? `/agent-manager/sessions/${encodeURIComponent(chatId)}/stable-messages${suffix}`
          : `/agent-manager/main-session/stable-messages${suffix}`;
      };

      do {
        const payload = await requestJson(baseUrl, buildPath());
        for (const message of payload.messages ?? []) {
          printPhoneMessage(message);
          cursor = message.id;
        }

        if (!follow) {
          return;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 1500)
        );
      } while (true);
    }
    default:
      throw new Error(`不支持的命令：${command}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("");
  printHelp();
  process.exitCode = 1;
});
