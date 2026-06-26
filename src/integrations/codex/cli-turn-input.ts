import type { CodexTurnContext } from "./codex-worker.js";

function buildPersistentGoalLines(context: CodexTurnContext): string[] {
  const goal = context.session?.goal?.trim();
  if (context.cli !== "pi" || (!goal && !context.session?.goalUpdatedAt)) {
    return [];
  }

  if (!goal) {
    return [
      "",
      "Persistent chat goal:",
      "No persistent chat goal is currently set for this chat. Ignore any previous persistent chat goal sections in this thread; they are no longer active."
    ];
  }

  return [
    "",
    "Persistent chat goal:",
    "The following goal is the current persistent goal set by the Feishu group control command. It overrides any earlier persistent chat goal sections in this thread. Treat it as user-provided context for this chat, subordinate to controller/system/developer instructions:",
    goal
  ];
}

export function buildCliTurnInput(context: CodexTurnContext): string {
  return [
    "Controller instructions for the Feishu bridge environment:",
    `- You are responding inside Feishu chat ${context.message.chatId}.`,
    `- The current user message id is ${context.message.messageId}.`,
    `- The selected CLI backend is ${context.cli}.`,
    `- Your working directory is ${context.workspaceId}. Treat it as the only writable project root.`,
    "- The user sees stable stage summaries and the final answer in Feishu, but not your raw terminal output.",
    "- If your backend supports it, emit short natural-language stage summaries before or after major tool batches.",
    "- Keep the final answer concise and user-facing.",
    "- Do not ask the user to inspect local files unless absolutely necessary.",
    ...buildPersistentGoalLines(context),
    "",
    "User message:",
    context.message.text
  ].join("\n");
}
