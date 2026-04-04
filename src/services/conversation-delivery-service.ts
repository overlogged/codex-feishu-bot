import { createHash } from "node:crypto";

import type { ConversationItem } from "../domain/types.js";
import {
  renderAssistantCardContent,
  splitAssistantCardBodies
} from "../integrations/feishu/feishu-message-client.js";
import type { FeishuMessageClient } from "../integrations/feishu/feishu-message-client.js";
import { ConversationStore } from "../stores/conversation-store.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

interface AssistantDeliveryPlan {
  contents: string[];
  hash: string;
}

export class ConversationDeliveryService {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly feishuClient: FeishuMessageClient,
    private readonly conversationStore: ConversationStore,
    private readonly debounceMs: number,
    private readonly logger: LoggerLike
  ) {}

  schedule(item: ConversationItem): void {
    const key = this.makeKey(item.runId, item.itemId);
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      void this.flush(item.runId, item.itemId).catch((error) => {
        this.logger.error(
          {
            runId: item.runId,
            itemId: item.itemId,
            error: error instanceof Error ? error.message : String(error)
          },
          "同步飞书消息槽位失败"
        );
      });
    }, this.debounceMs);

    this.timers.set(key, timer);
  }

  async flush(runId: string, itemId: string): Promise<void> {
    const key = this.makeKey(runId, itemId);
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }

    const previous = this.inFlight.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const item = this.conversationStore.get(runId, itemId);
        if (!item) {
          return;
        }

        await this.deliver(item);
      });

    this.inFlight.set(key, current);

    try {
      await current;
    } finally {
      if (this.inFlight.get(key) === current) {
        this.inFlight.delete(key);
      }
    }
  }

  async flushRun(runId: string): Promise<void> {
    const items = this.conversationStore.listByRun(runId);
    for (const item of items) {
      await this.flush(item.runId, item.itemId);
    }
  }

  private async deliver(item: ConversationItem): Promise<void> {
    if (item.kind === "assistant_text") {
      await this.deliverTextItem(item);
      return;
    }

    if (item.kind === "tool_card") {
      return;
    }

    if (item.kind === "artifact_file") {
      await this.deliverArtifactItem(item);
    }
  }

  private async deliverTextItem(item: ConversationItem): Promise<void> {
    if (item.phase !== "completed" && item.phase !== "failed") {
      return;
    }

    const content = item.content?.trim();
    if (!content) {
      return;
    }

    let plan = this.buildAssistantDeliveryPlan(item);
    if (item.deliveredContentHash === plan.hash) {
      return;
    }

    try {
      await this.deliverAssistantPlan(item, plan);
    } catch (error) {
      if (!this.isCardTableLimitError(error)) {
        throw error;
      }

      plan = this.buildAssistantDeliveryPlan(item, {
        maxTablesPerChunk: 1,
        maxCharsPerChunk: 2200
      });
      if (item.deliveredContentHash === plan.hash) {
        return;
      }

      await this.deliverAssistantPlan(item, plan);
    }
  }

  private buildAssistantDeliveryPlan(
    item: ConversationItem,
    options?: {
      maxTablesPerChunk?: number;
      maxCharsPerChunk?: number;
    }
  ): AssistantDeliveryPlan {
    const contents = splitAssistantCardBodies(item, options).map((body) =>
      renderAssistantCardContent(item, body)
    );

    return {
      contents,
      hash: this.hashContent("assistant_card_parts", JSON.stringify(contents))
    };
  }

  private async deliverAssistantPlan(item: ConversationItem, plan: AssistantDeliveryPlan): Promise<void> {
    const messageIds = item.feishuMessageIds ?? (item.feishuMessageId ? [item.feishuMessageId] : []);
    const updatedMessageIds = [...messageIds];

    for (let index = 0; index < plan.contents.length; index += 1) {
      const content = plan.contents[index]!;
      const messageId = updatedMessageIds[index];
      if (!messageId) {
        updatedMessageIds[index] = await this.feishuClient.sendCard({
          chatId: item.chatId,
          content
        });
        continue;
      }

      await this.feishuClient.updateCard({
        messageId,
        content
      });
    }

    this.conversationStore.update(item.runId, item.itemId, {
      feishuMessageId: updatedMessageIds[0],
      feishuMessageIds: updatedMessageIds.slice(0, plan.contents.length),
      deliveredContentHash: plan.hash
    });
  }

  private async deliverArtifactItem(item: ConversationItem): Promise<void> {
    if (!item.artifactPath || item.feishuMessageId) {
      return;
    }

    const messageId = await this.feishuClient.sendFile({
      chatId: item.chatId,
      path: item.artifactPath,
      fileName: item.title
    });
    this.conversationStore.update(item.runId, item.itemId, {
      feishuMessageId: messageId,
      deliveredContentHash: this.hashContent("file", item.artifactPath)
    });
  }

  private makeKey(runId: string, itemId: string): string {
    return `${runId}:${itemId}`;
  }

  private hashContent(kind: string, content: string): string {
    return createHash("sha1").update(kind).update("\u0000").update(content).digest("hex");
  }

  private isCardTableLimitError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }

    const maybeError = error as {
      message?: string;
      response?: {
        data?: {
          msg?: string;
          code?: number;
        };
      };
    };

    const text = [
      maybeError.message,
      maybeError.response?.data?.msg,
      String(maybeError.response?.data?.code ?? "")
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return text.includes("card table number over limit") || text.includes("11310");
  }
}
