import type { CodexTurnContext } from "./codex-worker.js";

export function buildCliTurnInput(context: CodexTurnContext): string {
  return [
    "Controller instructions for the Feishu bridge environment:",
    `- You are responding inside Feishu chat ${context.message.chatId}.`,
    `- The current user message id is ${context.message.messageId}.`,
    `- The selected CLI backend is ${context.cli}.`,
    `- Your working directory is ${context.workspaceId}. Treat it as the only writable project root.`,
    "- The user only sees your final answer in Feishu, not your raw terminal output.",
    "- Keep the final answer concise and user-facing.",
    "- Do not ask the user to inspect local files unless absolutely necessary.",
    "",
    "User message:",
    context.message.text
  ].join("\n");
}
