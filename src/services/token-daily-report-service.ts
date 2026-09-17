import type { ChatSession } from "../domain/types.js";
import type { SessionStore } from "../stores/session-store.js";
import type { UsageStatsService } from "./usage-stats-service.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

export interface TokenDailyReportServiceOptions {
  /** 未单独配置时使用的默认发送时间（HH:mm，本地时区）。 */
  defaultTime: string;
  tickMs?: number;
  now?: () => Date;
}

export function parseTimeOfDay(value: string | undefined): { hour: number; minute: number } | undefined {
  const matched = value?.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!matched) {
    return undefined;
  }

  return {
    hour: Number.parseInt(matched[1]!, 10),
    minute: Number.parseInt(matched[2]!, 10)
  };
}

export function formatTimeOfDay(value: string | undefined, fallback: string): string {
  const parsed = parseTimeOfDay(value) ?? parseTimeOfDay(fallback);
  if (!parsed) {
    return fallback;
  }

  return `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const DEFAULT_TICK_MS = 30_000;

/**
 * 每天在配置的时间给开启了 token 日报的会话推送当天 token 消耗。
 * 用 `lastSentDate` 保证同一天只发一次，重启后也不会重复发。
 */
export class TokenDailyReportService {
  private timer?: NodeJS.Timeout;
  private scanning = false;

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly usageStatsService: UsageStatsService,
    private readonly sendText: (chatId: string, content: string) => Promise<void>,
    private readonly logger?: LoggerLike,
    private readonly options: TokenDailyReportServiceOptions = { defaultTime: "23:00" }
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    const tickMs = this.options.tickMs ?? DEFAULT_TICK_MS;
    this.timer = setInterval(() => {
      void this.tick();
    }, tickMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async sendReportNow(chatId: string): Promise<void> {
    const session = this.sessionStore.get(chatId);
    if (!session) {
      return;
    }

    await this.sendReport(session, this.now());
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async tick(): Promise<void> {
    if (this.scanning) {
      return;
    }

    this.scanning = true;
    try {
      const now = this.now();
      const today = localDateKey(now);
      const nowMinutes = now.getHours() * 60 + now.getMinutes();

      for (const session of this.sessionStore.list()) {
        if (!session.tokenDailyReportEnabled) {
          continue;
        }
        if (session.tokenDailyReportLastSentDate === today) {
          continue;
        }

        const time = formatTimeOfDay(session.tokenDailyReportTime, this.options.defaultTime);
        const parsed = parseTimeOfDay(time);
        if (!parsed) {
          continue;
        }
        if (nowMinutes < parsed.hour * 60 + parsed.minute) {
          continue;
        }

        await this.sendReport(session, now);
      }
    } finally {
      this.scanning = false;
    }
  }

  private async sendReport(session: ChatSession, now: Date): Promise<void> {
    const today = localDateKey(now);
    let content: string;
    try {
      content = await this.usageStatsService.buildDailyReport();
    } catch (error) {
      this.logger?.error(
        {
          chatId: session.chatId,
          error: error instanceof Error ? error.message : String(error)
        },
        "生成 token 日报失败"
      );
      return;
    }

    try {
      await this.sendText(session.chatId, content);
    } catch (error) {
      this.logger?.error(
        {
          chatId: session.chatId,
          error: error instanceof Error ? error.message : String(error)
        },
        "发送 token 日报失败"
      );
      return;
    }

    const latest = this.sessionStore.get(session.chatId) ?? session;
    this.sessionStore.save({
      ...latest,
      tokenDailyReportLastSentDate: today,
      updatedAt: now.toISOString()
    });
    this.logger?.info(
      {
        chatId: session.chatId,
        date: today
      },
      "已发送 token 消耗日报"
    );
  }
}
