/**
 * 飞书长连接看门狗。
 *
 * 背景：`@larksuiteoapi/node-sdk` 的 WSClient 断线重连是「固定间隔 + 连接超时」的慢速循环
 * （默认 reconnectInterval 120s，外加最多 30s 的 reconnectNonce），网络抖动后经常十几分钟
 * 才恢复。长连接断开期间飞书不会补发事件（没有回调地址时事件即丢），用户消息会静默消失。
 *
 * 这个看门狗周期性检查 ws 实例的 readyState；连续掉线超过 `staleAfterMs` 时回调 `onStale`，
 * 由调用方强制重建 WebSocket 客户端（不重启整个进程，避免打断进行中的会话）。
 */

export interface FeishuWsWatchdogLogger {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

export interface FeishuWsWatchdogParams {
  isConnected: () => boolean;
  logger: FeishuWsWatchdogLogger;
  /** 健康检查间隔，默认 60s。 */
  checkIntervalMs?: number;
  /** 掉线多久判定为卡死，默认 180s。 */
  staleAfterMs?: number;
  /** 判定卡死时的动作，由调用方决定如何重建长连接。 */
  onStale?: (info: { downMs: number }) => void;
  now?: () => number;
  scheduleInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  cancelInterval?: (timer: ReturnType<typeof setInterval>) => void;
}

export type FeishuWsWatchdogState = "connected" | "connecting" | "stale";

export class FeishuWsWatchdog {
  private readonly checkIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly now: () => number;

  private timer: ReturnType<typeof setInterval> | undefined;
  private state: FeishuWsWatchdogState = "connecting";
  private disconnectedAt: number | null = null;
  private staleReported = false;

  constructor(private readonly params: FeishuWsWatchdogParams) {
    this.checkIntervalMs = params.checkIntervalMs ?? 60_000;
    this.staleAfterMs = params.staleAfterMs ?? 180_000;
    this.now = params.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.tick();

    const schedule = this.params.scheduleInterval ?? ((handler, ms) => setInterval(handler, ms));
    this.timer = schedule(() => {
      this.tick();
    }, this.checkIntervalMs);

    // 看门狗不应该阻止进程退出
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    const cancel = this.params.cancelInterval ?? ((timer) => clearInterval(timer));
    cancel(this.timer);
    this.timer = undefined;
  }

  /** 单次健康检查；返回判定结果，便于测试与观测。 */
  tick(): FeishuWsWatchdogState {
    const now = this.now();

    if (this.params.isConnected()) {
      if (this.state !== "connected") {
        this.params.logger.info(
          {
            downMs: this.disconnectedAt === null ? 0 : now - this.disconnectedAt,
            previousState: this.state
          },
          "飞书 WebSocket 长连接已恢复"
        );
      }

      this.state = "connected";
      this.disconnectedAt = null;
      this.staleReported = false;
      return "connected";
    }

    if (this.state === "connected") {
      this.params.logger.warn("飞书 WebSocket 长连接已断开，等待 SDK 自动重连");
    }

    if (this.disconnectedAt === null) {
      this.disconnectedAt = now;
    }

    const downMs = now - this.disconnectedAt;
    if (downMs < this.staleAfterMs) {
      this.state = "connecting";
      return "connecting";
    }

    this.state = "stale";

    if (!this.staleReported) {
      this.staleReported = true;
      this.params.logger.error(
        {
          downMs,
          staleAfterMs: this.staleAfterMs,
          checkIntervalMs: this.checkIntervalMs
        },
        "飞书 WebSocket 长连接长时间未恢复，强制重建客户端"
      );
      this.params.onStale?.({
        downMs
      });
    }

    return "stale";
  }
}
