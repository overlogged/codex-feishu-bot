declare module "ws" {
  export interface RawData {
    toString(encoding?: string): string;
  }

  class WebSocket {
    static readonly OPEN: number;
    static readonly CLOSING: number;
    static readonly CLOSED: number;

    constructor(
      url: string,
      options?: {
        headers?: Record<string, string>;
      }
    );

    readyState: number;
    once(event: "open", listener: () => void): this;
    once(event: "error", listener: (error: Error) => void): this;
    once(event: "close", listener: () => void): this;
    once(
      event: "unexpected-response",
      listener: (request: unknown, response: { statusCode?: number }) => void
    ): this;
    on(event: "message", listener: (payload: RawData) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    off(event: "error", listener: (error: Error) => void): this;
    off(event: "open", listener: () => void): this;
    off(
      event: "unexpected-response",
      listener: (request: unknown, response: { statusCode?: number }) => void
    ): this;
    removeAllListeners(): this;
    close(): void;
    send(payload: string): void;
  }

  export class WebSocketServer {
    constructor(options: {
      noServer: boolean;
    });

    on(event: "connection", listener: (socket: WebSocket) => void): this;
    handleUpgrade(
      request: unknown,
      socket: unknown,
      head: unknown,
      callback: (client: WebSocket) => void
    ): void;
    emit(event: "connection", client: WebSocket, request: unknown): boolean;
  }

  export default WebSocket;
}
