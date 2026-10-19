import * as Lark from "@larksuiteoapi/node-sdk";

import type { Env } from "../../config/env.js";
import type { IncomingChatMessage } from "../../domain/types.js";
import { createFeishuWsClient } from "./feishu-openapi-client.js";
import { FeishuWsWatchdog } from "./feishu-ws-watchdog.js";
import {
  parseFeishuMessageEventResult,
  summarizeFeishuPayload
} from "./parse-feishu-message.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

interface FeishuWsSubscriberParams {
  env: Env;
  onMessage: (message: IncomingChatMessage) => void;
  logger: LoggerLike;
}

export class FeishuWsSubscriber {
  private wsClient: Lark.WSClient;
  private readonly eventDispatcher;
  private watchdog: FeishuWsWatchdog | undefined;
  private rebuilding = false;
  /** 最近一次在长连接上观察到任何活动的时刻；null 表示尚未连上。 */
  private lastActivityAt: number | null = null;
  private activityProbe: (() => void) | undefined;

  constructor(private readonly params: FeishuWsSubscriberParams) {
    this.wsClient = createFeishuWsClient(params.env);
    this.eventDispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": (data) => {
        const parsed = parseFeishuMessageEventResult(data);
        if (!parsed.ok) {
          this.params.logger.warn(
            {
              failure: parsed.failure,
              payloadShape: summarizeFeishuPayload(data)
            },
            "忽略无法解析的飞书消息事件"
          );
          return;
        }

        this.params.logger.info(
          {
            chatId: parsed.message.chatId,
            messageId: parsed.message.messageId,
            chatType: parsed.message.chatType,
            textPreview: parsed.message.text.slice(0, 120)
          },
          "收到飞书消息事件"
        );
        this.params.onMessage(parsed.message);
      }
    });
  }

  async start(): Promise<void> {
    this.params.logger.info("正在建立飞书 WebSocket 长连接");
    await this.wsClient.start({
      eventDispatcher: this.eventDispatcher
    });
    this.lastActivityAt = Date.now();
    this.attachActivityProbe();
    this.params.logger.info("飞书 WebSocket 长连接已启动");
    this.ensureWatchdog();
  }

  async close(): Promise<void> {
    this.watchdog?.stop();
    this.watchdog = undefined;
    this.detachActivityProbe();
    this.wsClient.close();
    this.params.logger.info("飞书 WebSocket 长连接已关闭");
  }

  /**
   * 读取当前 ws 实例；不存在时返回 null。
   *
   * SDK 只在 `open` 事件里把实例写进 wsConfig，重连时会置空。
   */
  private getWsInstance(): { readyState?: number; on?: unknown; removeListener?: unknown } | null {
    const wsConfig = (
      this.wsClient as unknown as {
        wsConfig?: { getWSInstance?: () => { readyState?: number } | null };
      }
    ).wsConfig;
    return wsConfig?.getWSInstance?.() ?? null;
  }

  /**
   * 监听长连接上的任何活动（消息、PING/PONG、SDK 自身的控制帧）。
   *
   * 半开连接下 `readyState` 会一直停在 OPEN，看门狗仅凭它无法发现故障；
   * 但只要还有帧到达就说明链路是通的，所以这里用「最后一次活动时间」
   * 作为活性信号交给看门狗判断。
   */
  private attachActivityProbe(): void {
    const instance = this.getWsInstance() as
      | {
          on?: (event: string, handler: () => void) => void;
          removeListener?: (event: string, handler: () => void) => void;
        }
      | null;
    if (!instance || typeof instance.on !== "function") {
      // 拿不到 ws 实例时退化为只看 readyState，不影响原有断线检测。
      return;
    }

    const markActive = () => {
      this.lastActivityAt = Date.now();
    };

    this.activityProbe = markActive;
    for (const event of ["message", "ping", "pong", "open"]) {
      instance.on?.(event, markActive);
    }
  }

  private detachActivityProbe(): void {
    const instance = this.getWsInstance() as
      | {
          removeListener?: (event: string, handler: () => void) => void;
        }
      | null;
    if (instance && typeof instance.removeListener === "function" && this.activityProbe) {
      for (const event of ["message", "ping", "pong", "open"]) {
        instance.removeListener?.(event, this.activityProbe);
      }
    }
    this.activityProbe = undefined;
  }

  /**
   * 长连接是否真的处于 OPEN。
   *
   * SDK 只在 `open` 事件里把实例写进 wsConfig，重连时会置空，所以这里以 readyState 为准。
   * 注意这只覆盖「明确断开」；半开连接由看门狗的静默检测负责（见 attachActivityProbe）。
   */
  isConnected(): boolean {
    const instance = this.getWsInstance();
    return Boolean(instance) && instance?.readyState === 1;
  }

  private ensureWatchdog(): void {
    if (!this.params.env.FEISHU_WS_WATCHDOG_ENABLED || this.watchdog) {
      return;
    }

    this.watchdog = new FeishuWsWatchdog({
      isConnected: () => this.isConnected(),
      lastActivityAt: () => this.lastActivityAt,
      checkIntervalMs: this.params.env.FEISHU_WS_WATCHDOG_INTERVAL_MS,
      staleAfterMs: this.params.env.FEISHU_WS_WATCHDOG_STALE_MS,
      silentAfterMs: this.params.env.FEISHU_WS_WATCHDOG_SILENT_MS,
      logger: this.params.logger,
      onStale: ({ downMs, reason }) => {
        void this.rebuildClient(downMs, reason);
      }
    });
    this.watchdog.start();
    this.params.logger.info(
      {
        checkIntervalMs: this.params.env.FEISHU_WS_WATCHDOG_INTERVAL_MS,
        staleAfterMs: this.params.env.FEISHU_WS_WATCHDOG_STALE_MS,
        silentAfterMs: this.params.env.FEISHU_WS_WATCHDOG_SILENT_MS
      },
      "飞书 WebSocket 长连接看门狗已启动"
    );
  }

  /**
   * 重建 WebSocket 客户端。
   *
   * SDK 的重连定时器可能处于很长的等待窗口里，直接重建客户端可以立刻重新走一遍
   * 「拉取连接配置 + 建连」，比等 120s 甚至更久快得多，也不需要重启进程打断进行中的会话。
   */
  private async rebuildClient(downMs: number, reason: "disconnected" | "silent"): Promise<void> {
    if (this.rebuilding) {
      return;
    }

    this.rebuilding = true;

    // 旧实例上的监听随实例一起丢弃，这里先摘干净避免泄漏。
    this.detachActivityProbe();

    try {
      this.wsClient.close();
    } catch (error) {
      this.params.logger.warn(
        {
          error: error instanceof Error ? error.message : String(error)
        },
        "关闭旧飞书 WebSocket 客户端失败，继续重建"
      );
    }

    this.wsClient = createFeishuWsClient(this.params.env);
    // 重建后必须重新计时，否则会拿旧连接的活动时间误判新连接已经静默。
    this.lastActivityAt = null;

    try {
      await this.wsClient.start({
        eventDispatcher: this.eventDispatcher
      });
      this.lastActivityAt = Date.now();
      this.attachActivityProbe();
      this.params.logger.info(
        {
          downMs,
          reason
        },
        "已重建飞书 WebSocket 客户端，等待重新建立长连接"
      );
    } catch (error) {
      this.params.logger.error(
        {
          error: error instanceof Error ? error.message : String(error)
        },
        "重建飞书 WebSocket 客户端失败，看门狗将在下一轮重试"
      );
    } finally {
      this.rebuilding = false;
    }
  }
}
