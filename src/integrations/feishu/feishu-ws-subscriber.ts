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
    this.params.logger.info("飞书 WebSocket 长连接已启动");
    this.ensureWatchdog();
  }

  async close(): Promise<void> {
    this.watchdog?.stop();
    this.watchdog = undefined;
    this.wsClient.close();
    this.params.logger.info("飞书 WebSocket 长连接已关闭");
  }

  /**
   * 长连接是否真的处于 OPEN。
   *
   * SDK 只在 `open` 事件里把实例写进 wsConfig，重连时会置空，所以这里以 readyState 为准；
   * 处于重连循环但没连上时都会返回 false。
   */
  isConnected(): boolean {
    const wsConfig = (
      this.wsClient as unknown as {
        wsConfig?: { getWSInstance?: () => { readyState?: number } | null };
      }
    ).wsConfig;
    const instance = wsConfig?.getWSInstance?.();

    return Boolean(instance) && instance?.readyState === 1;
  }

  private ensureWatchdog(): void {
    if (!this.params.env.FEISHU_WS_WATCHDOG_ENABLED || this.watchdog) {
      return;
    }

    this.watchdog = new FeishuWsWatchdog({
      isConnected: () => this.isConnected(),
      checkIntervalMs: this.params.env.FEISHU_WS_WATCHDOG_INTERVAL_MS,
      staleAfterMs: this.params.env.FEISHU_WS_WATCHDOG_STALE_MS,
      logger: this.params.logger,
      onStale: ({ downMs }) => {
        void this.rebuildClient(downMs);
      }
    });
    this.watchdog.start();
    this.params.logger.info(
      {
        checkIntervalMs: this.params.env.FEISHU_WS_WATCHDOG_INTERVAL_MS,
        staleAfterMs: this.params.env.FEISHU_WS_WATCHDOG_STALE_MS
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
  private async rebuildClient(downMs: number): Promise<void> {
    if (this.rebuilding) {
      return;
    }

    this.rebuilding = true;

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

    try {
      await this.wsClient.start({
        eventDispatcher: this.eventDispatcher
      });
      this.params.logger.info(
        {
          downMs
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
