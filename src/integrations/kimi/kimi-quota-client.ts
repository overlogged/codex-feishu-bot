import { chmod, readFile, rename, writeFile } from "node:fs/promises";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

export interface KimiQuotaWindow {
  usedRatio: number;
  resetAt: string | null;
}

export interface KimiQuota {
  limit5h: KimiQuotaWindow | null;
  limit7d: KimiQuotaWindow | null;
  boosterWallet: {
    balanceCents: number;
    currency: string;
  } | null;
}

export interface KimiQuotaClientOptions {
  credentialsFile: string;
  apiBaseUrl?: string;
  oauthHost?: string;
  logger?: LoggerLike;
  fetchImpl?: typeof fetch;
}

type FetchLike = typeof fetch;

const KIMI_OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const TOKEN_REFRESH_LEEWAY_SECONDS = 30;
const REQUEST_TIMEOUT_MS = 8_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function parseQuotaWindow(value: unknown): KimiQuotaWindow | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const usedRatio = numberOrNull(record.used_ratio);
  if (usedRatio === null) {
    return null;
  }

  return {
    usedRatio,
    resetAt: stringOrNull(record.reset_time)
  };
}

export function parseKimiQuotaResponse(payload: unknown): KimiQuota | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }

  const usages = asRecord(record.usages);
  const limit5h = parseQuotaWindow(usages?.limit_5h);
  const limit7d = parseQuotaWindow(usages?.limit_7d);

  const boosterWalletRecord = asRecord(record.boosterWallet);
  let boosterWallet: KimiQuota["boosterWallet"] = null;
  if (boosterWalletRecord) {
    const balance = asRecord(boosterWalletRecord.balance);
    const monthlyChargeLimit = asRecord(boosterWalletRecord.monthlyChargeLimit);
    const amountLeft = numberOrNull(balance?.amountLeft);
    if (amountLeft !== null) {
      boosterWallet = {
        // kimi 返回的是定点数：amountLeft / 1e6 = 余额（分）
        balanceCents: amountLeft / 1e6,
        currency: stringOrNull(monthlyChargeLimit?.currency) ?? "CNY"
      };
    }
  }

  if (!limit5h && !limit7d && !boosterWallet) {
    return null;
  }

  return {
    limit5h,
    limit7d,
    boosterWallet
  };
}

interface KimiCredentials {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  [key: string]: unknown;
}

export class KimiQuotaClient {
  private readonly credentialsFile: string;
  private readonly apiBaseUrl: string;
  private readonly oauthHost: string;
  private readonly logger?: LoggerLike;
  private readonly fetchImpl: FetchLike;
  private cachedToken: { accessToken: string; expiresAt: number } | null = null;

  constructor(options: KimiQuotaClientOptions) {
    this.credentialsFile = options.credentialsFile;
    this.apiBaseUrl =
      options.apiBaseUrl ?? process.env.KIMI_CODE_BASE_URL ?? "https://api.kimi.com/coding/v1";
    this.oauthHost =
      options.oauthHost ??
      process.env.KIMI_CODE_OAUTH_HOST ??
      process.env.KIMI_OAUTH_HOST ??
      "https://auth.kimi.com";
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async readQuota(): Promise<KimiQuota | null> {
    try {
      const accessToken = await this.resolveAccessToken();
      if (!accessToken) {
        return null;
      }

      const response = await this.fetchImpl(`${this.apiBaseUrl}/usages`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json"
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!response.ok) {
        this.logger?.warn(
          { status: response.status },
          "Kimi 额度接口返回非 2xx，本次按不可用处理"
        );
        return null;
      }

      return parseKimiQuotaResponse(await response.json());
    } catch (error) {
      this.logger?.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "读取 Kimi 账号额度失败"
      );
      return null;
    }
  }

  private async resolveAccessToken(): Promise<string | null> {
    const nowSeconds = Date.now() / 1000;
    if (
      this.cachedToken &&
      this.cachedToken.expiresAt - TOKEN_REFRESH_LEEWAY_SECONDS > nowSeconds
    ) {
      return this.cachedToken.accessToken;
    }

    const credentials = await this.readCredentialsFile();
    if (!credentials) {
      return null;
    }

    if (
      typeof credentials.access_token === "string" &&
      typeof credentials.expires_at === "number" &&
      credentials.expires_at - TOKEN_REFRESH_LEEWAY_SECONDS > nowSeconds
    ) {
      this.cachedToken = {
        accessToken: credentials.access_token,
        expiresAt: credentials.expires_at
      };
      return credentials.access_token;
    }

    return this.refreshAccessToken(credentials);
  }

  private async readCredentialsFile(): Promise<KimiCredentials | null> {
    try {
      const raw = await readFile(this.credentialsFile, "utf8");
      const parsed = asRecord(JSON.parse(raw));
      if (!parsed) {
        return null;
      }

      return parsed as KimiCredentials;
    } catch (error) {
      this.logger?.warn(
        {
          credentialsFile: this.credentialsFile,
          error: error instanceof Error ? error.message : String(error)
        },
        "读取 Kimi 登录凭证失败"
      );
      return null;
    }
  }

  private async refreshAccessToken(credentials: KimiCredentials): Promise<string | null> {
    if (typeof credentials.refresh_token !== "string" || !credentials.refresh_token) {
      return null;
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refresh_token,
      client_id: KIMI_OAUTH_CLIENT_ID
    });

    const response = await this.fetchImpl(`${this.oauthHost}/v1/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
      this.logger?.warn(
        { status: response.status },
        "刷新 Kimi access_token 返回非 2xx"
      );
      return null;
    }

    const refreshed = asRecord(await response.json());
    const accessToken = stringOrNull(refreshed?.access_token);
    if (!refreshed || !accessToken) {
      this.logger?.warn("刷新 Kimi access_token 的响应缺少 access_token");
      return null;
    }

    const expiresIn = numberOrNull(refreshed.expires_in) ?? 900;
    const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
    const merged: KimiCredentials = {
      ...credentials,
      ...refreshed,
      access_token: accessToken,
      refresh_token: stringOrNull(refreshed.refresh_token) ?? credentials.refresh_token,
      expires_at: expiresAt
    };
    await this.writeCredentialsFile(merged);

    this.cachedToken = {
      accessToken,
      expiresAt
    };
    this.logger?.info("Kimi access_token 已刷新并写回凭证文件");
    return accessToken;
  }

  private async writeCredentialsFile(credentials: KimiCredentials): Promise<void> {
    const tmpFile = `${this.credentialsFile}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpFile, `${JSON.stringify(credentials, null, 2)}\n`, {
      mode: 0o600
    });
    await chmod(tmpFile, 0o600);
    await rename(tmpFile, this.credentialsFile);
  }
}
