import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ChatCli,
  ConversationItem,
  RunRecord,
  ChatSession,
  ScheduledTaskRecord
} from "../domain/types.js";
import { ConversationStore } from "./conversation-store.js";
import { RunStore } from "./run-store.js";
import { ScheduledTaskStore } from "./scheduled-task-store.js";
import { SessionStore } from "./session-store.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

interface RuntimeStateSnapshot {
  version: 3;
  savedAt: string;
  sessions: ChatSession[];
  runs: RunRecord[];
  items: ConversationItem[];
  scheduledTasks: ScheduledTaskRecord[];
}

interface RuntimeStores {
  sessionStore: SessionStore;
  runStore: RunStore;
  conversationStore: ConversationStore;
  scheduledTaskStore: ScheduledTaskStore;
}

const MAX_PERSISTED_CONVERSATION_ITEMS = 5_000;
const MAX_PERSISTED_CONTENT_CHARS = 20_000;
const MAX_PERSISTED_OUTPUT_CHARS = 12_000;
const MAX_PERSISTED_DETAIL_CHARS = 8_000;
const MAX_PERSISTED_DETAILS = 20;
const MAX_PERSISTED_FILE_PATHS = 100;
const MAX_PERSISTED_FEISHU_MESSAGE_IDS = 50;

function truncateString(value: string | undefined, maxChars: number): string | undefined {
  if (value === undefined || value.length <= maxChars) {
    return value;
  }

  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n[truncated ${omitted} chars from runtime snapshot]`;
}

function truncateArray(values: string[], maxItems: number, maxChars: number): string[] {
  return values
    .slice(-maxItems)
    .map((value) => truncateString(value, maxChars) ?? "");
}

function compactConversationItem(item: ConversationItem): ConversationItem {
  return {
    ...item,
    title: truncateString(item.title, MAX_PERSISTED_DETAIL_CHARS),
    content: truncateString(item.content, MAX_PERSISTED_CONTENT_CHARS),
    command: truncateString(item.command, MAX_PERSISTED_DETAIL_CHARS),
    output: truncateString(item.output, MAX_PERSISTED_OUTPUT_CHARS),
    details: truncateArray(
      Array.isArray(item.details) ? item.details : [],
      MAX_PERSISTED_DETAILS,
      MAX_PERSISTED_DETAIL_CHARS
    ),
    filePaths: Array.isArray(item.filePaths)
      ? item.filePaths.slice(-MAX_PERSISTED_FILE_PATHS)
      : [],
    feishuMessageIds: Array.isArray(item.feishuMessageIds)
      ? item.feishuMessageIds.slice(-MAX_PERSISTED_FEISHU_MESSAGE_IDS)
      : undefined
  };
}

function compactConversationItems(items: ConversationItem[]): {
  items: ConversationItem[];
  droppedItems: number;
} {
  const compacted = items.slice(-MAX_PERSISTED_CONVERSATION_ITEMS).map(compactConversationItem);
  return {
    items: compacted,
    droppedItems: Math.max(0, items.length - compacted.length)
  };
}

export interface InterruptedRunNotice {
  chatId: string;
  threadId: string;
  runId: string;
  sourceMessageId: string;
}

export interface RuntimeRestoreResult {
  interruptedRuns: InterruptedRunNotice[];
}

function normalizeCli(value: unknown): ChatCli {
  return value === "claude" || value === "kimi" || value === "pi" ? value : "codex";
}

export class RuntimeStatePersister {
  private timer?: NodeJS.Timeout;
  private latestWrite?: Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly debounceMs: number;
  private stores?: RuntimeStores;

  constructor(
    private readonly filePath: string,
    private readonly logger?: LoggerLike,
    debounceMs = 250
  ) {
    this.debounceMs = debounceMs;
  }

  attach(stores: RuntimeStores): void {
    this.stores = stores;
  }

  scheduleSave(): void {
    if (!this.stores) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.startQueuedWrite({ logErrors: true });
    }, this.debounceMs);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      await this.startQueuedWrite({ logErrors: false });
      return;
    }

    await this.latestWrite;
  }

  async restore(stores: RuntimeStores): Promise<RuntimeRestoreResult> {
    this.stores = stores;

    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.logger?.info(
          {
            filePath: this.filePath
          },
          "未找到运行态快照文件，跳过恢复"
        );
        return {
          interruptedRuns: []
        };
      }

      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<RuntimeStateSnapshot>;
      const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      const runs = Array.isArray(parsed.runs) ? parsed.runs : [];
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      const scheduledTasks = Array.isArray(parsed.scheduledTasks) ? parsed.scheduledTasks : [];
      const interruptedRuns = runs
        .filter((run): run is RunRecord => Boolean(run && typeof run === "object"))
        .filter((run) => run.status === "running" || run.status === "queued")
        .map((run) => ({
          chatId: run.chatId,
          threadId: run.threadId,
          runId: run.runId,
          sourceMessageId: run.sourceMessageId
        }));

      const sanitizedRuns = runs.map((run) =>
        run.status === "running" || run.status === "queued"
          ? {
              ...run,
              status: "failed" as const,
              errorMessage: run.errorMessage ?? "服务重启后中断，已结束此前未完成任务。"
            }
          : run
      );

      const sanitizedSessions = sessions.map((session) => ({
        ...session,
        cli: normalizeCli((session as Partial<ChatSession>).cli),
        activeRunId: undefined,
        activeTurnId: undefined
      }));

      stores.sessionStore.replaceAll(sanitizedSessions);
      stores.runStore.replaceAll(sanitizedRuns);
      stores.conversationStore.replaceAll(items);
      stores.scheduledTaskStore.replaceAll(scheduledTasks);

      this.logger?.info(
        {
          filePath: this.filePath,
          sessions: sanitizedSessions.length,
          runs: sanitizedRuns.length,
          items: items.length,
          scheduledTasks: scheduledTasks.length,
          interruptedRuns: interruptedRuns.length
        },
        "已从运行态快照恢复内存状态"
      );

      this.scheduleSave();
      return {
        interruptedRuns
      };
    } catch (error) {
      this.logger?.error(
        {
          filePath: this.filePath,
          error: error instanceof Error ? error.message : String(error)
        },
        "解析运行态快照失败，已跳过恢复"
      );
      return {
        interruptedRuns: []
      };
    }
  }

  private snapshot(): RuntimeStateSnapshot {
    if (!this.stores) {
      throw new Error("runtime stores not attached");
    }

    const compactedItems = compactConversationItems(this.stores.conversationStore.list());

    return {
      version: 3,
      savedAt: new Date().toISOString(),
      sessions: this.stores.sessionStore.list(),
      runs: this.stores.runStore.list(),
      items: compactedItems.items,
      scheduledTasks: this.stores.scheduledTaskStore.list()
    };
  }

  private startQueuedWrite(options: { logErrors: boolean }): Promise<void> {
    const writePromise = this.writeQueue
      .catch(() => undefined)
      .then(() => this.writeSnapshot());

    this.writeQueue = writePromise;
    this.latestWrite = writePromise;

    if (options.logErrors) {
      void writePromise.catch((error) => {
        this.logger?.error(
          {
            filePath: this.filePath,
            error: error instanceof Error ? error.message : String(error)
          },
          "运行态快照持久化失败"
        );
      });
    }

    void writePromise.then(
      () => {
        if (this.latestWrite === writePromise) {
          this.latestWrite = undefined;
        }
      },
      () => {
        if (this.latestWrite === writePromise) {
          this.latestWrite = undefined;
        }
      }
    );

    return writePromise;
  }

  private async writeSnapshot(): Promise<void> {
    if (!this.stores) {
      throw new Error("runtime stores not attached");
    }

    const originalItemCount = this.stores.conversationStore.list().length;
    const snapshot = this.snapshot();
    const dir = dirname(this.filePath);
    const tempFile = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;

    await mkdir(dir, { recursive: true });
    await writeFile(tempFile, JSON.stringify(snapshot), "utf8");
    await rename(tempFile, this.filePath);

    this.logger?.info(
      {
        filePath: this.filePath,
        sessions: snapshot.sessions.length,
        runs: snapshot.runs.length,
        items: snapshot.items.length,
        droppedItems: Math.max(0, originalItemCount - snapshot.items.length),
        scheduledTasks: snapshot.scheduledTasks.length
      },
      "运行态快照已持久化"
    );
  }
}
