import type { ChatCli, ChatSession } from "../domain/types.js";

export interface SessionResumeBinding {
  cli: ChatCli;
  workspaceId: string;
}

export type SessionResumeCliCommands = Partial<Record<ChatCli, string>>;

function quoteArg(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

export function buildSessionResumeCommand(
  cli: ChatCli,
  threadId: string,
  workspaceId: string,
  commands: SessionResumeCliCommands = {}
): string {
  const cd = `cd ${quoteArg(workspaceId)}`;
  switch (cli) {
    case "codex":
      return `${cd} && ${commands.codex ?? "codex"} resume ${quoteArg(threadId)}`;
    case "kimi":
      return `${cd} && ${commands.kimi ?? "kimi"} --session ${quoteArg(threadId)}`;
    case "claude":
      return `${cd} && ${commands.claude ?? "claude"} --resume ${quoteArg(threadId)}`;
    case "pi":
      return `${cd} && ${commands.pi ?? "pi"} --session ${quoteArg(threadId)}`;
    case "dsh":
      // dsh 的会话恢复走 ACP / Web UI，没有等价的 CLI resume 子命令。
      return `${cd} && ${commands.dsh ?? "dsh"} web  # 在 Web UI 打开会话 ${quoteArg(threadId)}`;
  }
}

export function renderSessionResumeLine(
  binding: SessionResumeBinding,
  session: ChatSession | undefined,
  commands: SessionResumeCliCommands = {}
): string {
  if (
    !session?.threadId ||
    session.threadId.startsWith("pending:") ||
    session.cli !== binding.cli ||
    session.workspaceId !== binding.workspaceId
  ) {
    return "本机恢复会话：暂无（这个群还没有已开始的任务会话）";
  }

  return `本机恢复会话：${buildSessionResumeCommand(binding.cli, session.threadId, binding.workspaceId, commands)}`;
}
