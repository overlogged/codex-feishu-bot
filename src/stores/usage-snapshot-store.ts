import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

export interface UsageSnapshotCliTotals {
  tokens: number | null;
  cost: number | null;
}

export interface UsageSnapshot {
  /** 快照时间（ISO 字符串）。 */
  at: string;
  /** 各 CLI 当天的累计 token/费用。 */
  totals: Record<string, UsageSnapshotCliTotals>;
}

const DEFAULT_RETENTION_MS = 48 * 60 * 60 * 1000;

/**
 * 记录 ccusage 当天累计用量的时间序列快照。
 * ccusage 本身只有「按天」粒度，用快照做差可以估算「近 1 小时」消耗。
 */
export class UsageSnapshotStore {
  private snapshots: UsageSnapshot[] = [];
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath?: string,
    private readonly logger?: LoggerLike,
    private readonly retentionMs = DEFAULT_RETENTION_MS
  ) {}

  async load(): Promise<void> {
    if (this.loaded || !this.filePath) {
      this.loaded = true;
      return;
    }

    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const snapshots = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { snapshots?: unknown }).snapshots)
          ? (parsed as { snapshots: unknown[] }).snapshots
          : [];
      this.snapshots = snapshots.filter(isUsageSnapshot);
      this.prune();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger?.warn(
          {
            filePath: this.filePath,
            error: error instanceof Error ? error.message : String(error)
          },
          "读取用量快照失败，将从空历史开始"
        );
      }
    }
  }

  list(): UsageSnapshot[] {
    return this.snapshots;
  }

  async record(snapshot: UsageSnapshot): Promise<void> {
    this.snapshots.push(snapshot);
    this.prune();
    await this.persist();
  }

  private prune(): void {
    const cutoff = Date.now() - this.retentionMs;
    this.snapshots = this.snapshots
      .filter((snapshot) => {
        const at = new Date(snapshot.at).getTime();
        return Number.isFinite(at) && at >= cutoff;
      })
      .sort((left, right) => left.at.localeCompare(right.at));
  }

  private async persist(): Promise<void> {
    if (!this.filePath) {
      return;
    }

    const write = async () => {
      const dir = dirname(this.filePath!);
      const tempFile = `${this.filePath}.${process.pid}.tmp`;
      await mkdir(dir, { recursive: true });
      await writeFile(tempFile, JSON.stringify({ snapshots: this.snapshots }), "utf8");
      await rename(tempFile, this.filePath!);
    };

    this.writeQueue = this.writeQueue.catch(() => undefined).then(write);
    try {
      await this.writeQueue;
    } catch (error) {
      this.logger?.warn(
        {
          filePath: this.filePath,
          error: error instanceof Error ? error.message : String(error)
        },
        "写入用量快照失败"
      );
    }
  }
}

function isUsageSnapshot(value: unknown): value is UsageSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<UsageSnapshot>;
  return typeof record.at === "string" && Boolean(record.totals) && typeof record.totals === "object";
}
