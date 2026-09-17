import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { KimiQuotaClient, parseKimiQuotaResponse } from "./kimi-quota-client.js";

function createLogger() {
  return {
    info() {
      return undefined;
    },
    warn() {
      return undefined;
    },
    error() {
      return undefined;
    }
  };
}

const quotaResponseFixture = {
  usage: {
    limit: "100",
    used: "68",
    remaining: "32",
    resetTime: "2026-09-18T01:32:10.948244Z"
  },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", used: "77", remaining: "23", resetTime: "2026-09-16T17:32:10Z" }
    }
  ],
  usages: {
    limit_5h: { used_ratio: 0.768033, reset_time: "2026-09-16T17:32:10Z" },
    limit_7d: { used_ratio: 0.681582, reset_time: "2026-09-18T01:32:10Z" }
  },
  boosterWallet: null
};

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function createFetchStub(
  handler: (call: FetchCall) => { status?: number; body: unknown }
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: unknown, init?: { method?: string; headers?: unknown; body?: unknown }) => {
    const call: FetchCall = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined
    };
    calls.push(call);
    const { status = 200, body } = handler(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return body;
      }
    } as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function createCredentialsFile(credentials: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kimi-quota-client-test-"));
  const file = join(dir, "kimi-code.json");
  await writeFile(file, JSON.stringify(credentials), { mode: 0o600 });
  return file;
}

test("KimiQuotaClient reads quota with a valid token without refreshing", async () => {
  const credentialsFile = await createCredentialsFile({
    access_token: "token_valid",
    refresh_token: "refresh_1",
    expires_at: Math.floor(Date.now() / 1000) + 600,
    scope: "coding",
    token_type: "Bearer"
  });
  const { fetchImpl, calls } = createFetchStub(() => ({ body: quotaResponseFixture }));
  const client = new KimiQuotaClient({
    credentialsFile,
    logger: createLogger(),
    fetchImpl
  });

  const quota = await client.readQuota();

  assert.ok(quota);
  assert.equal(quota.limit5h?.usedRatio, 0.768033);
  assert.equal(quota.limit5h?.resetAt, "2026-09-16T17:32:10Z");
  assert.equal(quota.limit7d?.usedRatio, 0.681582);
  assert.equal(quota.boosterWallet, null);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.url, "https://api.kimi.com/coding/v1/usages");
  assert.equal(calls[0]?.headers.Authorization, "Bearer token_valid");
  assert.equal(calls[0]?.headers.Accept, "application/json");
});

test("KimiQuotaClient refreshes an expired token and rewrites the credentials file", async () => {
  const credentialsFile = await createCredentialsFile({
    access_token: "token_expired",
    refresh_token: "refresh_old",
    expires_at: Math.floor(Date.now() / 1000) - 10,
    scope: "coding",
    token_type: "Bearer"
  });
  const { fetchImpl, calls } = createFetchStub((call) => {
    if (call.method === "POST") {
      return {
        body: {
          access_token: "token_fresh",
          refresh_token: "refresh_new",
          expires_in: 900
        }
      };
    }
    return { body: quotaResponseFixture };
  });
  const client = new KimiQuotaClient({
    credentialsFile,
    logger: createLogger(),
    fetchImpl
  });

  const quota = await client.readQuota();

  assert.ok(quota);
  assert.equal(calls.length, 2);

  const refreshCall = calls[0];
  assert.equal(refreshCall?.method, "POST");
  assert.equal(refreshCall?.url, "https://auth.kimi.com/v1/oauth/token");
  assert.equal(
    refreshCall?.headers["Content-Type"],
    "application/x-www-form-urlencoded"
  );
  const body = new URLSearchParams(refreshCall?.body ?? "");
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), "refresh_old");
  assert.equal(body.get("client_id"), "17e5f671-d194-4dfb-9706-5516cb48c098");

  assert.equal(calls[1]?.headers.Authorization, "Bearer token_fresh");

  const rewritten = JSON.parse(await readFile(credentialsFile, "utf8")) as Record<string, unknown>;
  assert.equal(rewritten.access_token, "token_fresh");
  assert.equal(rewritten.refresh_token, "refresh_new");
  assert.equal(rewritten.scope, "coding");
  assert.equal(typeof rewritten.expires_at, "number");
  assert.ok((rewritten.expires_at as number) > Date.now() / 1000);
  assert.equal((await stat(credentialsFile)).mode & 0o777, 0o600);

  // 第二次调用直接用内存缓存的新 token，不再刷新
  const secondQuota = await client.readQuota();
  assert.ok(secondQuota);
  assert.equal(calls.length, 3);
  assert.equal(calls[2]?.headers.Authorization, "Bearer token_fresh");
});

test("KimiQuotaClient returns null when the credentials file is missing", async () => {
  const { fetchImpl, calls } = createFetchStub(() => ({ body: quotaResponseFixture }));
  const client = new KimiQuotaClient({
    credentialsFile: join(tmpdir(), "kimi-quota-client-test-missing.json"),
    logger: createLogger(),
    fetchImpl
  });

  assert.equal(await client.readQuota(), null);
  assert.equal(calls.length, 0);
});

test("KimiQuotaClient returns null when the quota endpoint errors", async () => {
  const credentialsFile = await createCredentialsFile({
    access_token: "token_valid",
    refresh_token: "refresh_1",
    expires_at: Math.floor(Date.now() / 1000) + 600
  });
  const { fetchImpl } = createFetchStub(() => ({ status: 500, body: {} }));
  const client = new KimiQuotaClient({
    credentialsFile,
    logger: createLogger(),
    fetchImpl
  });

  assert.equal(await client.readQuota(), null);
});

test("parseKimiQuotaResponse converts the booster wallet fixed-point balance", () => {
  const quota = parseKimiQuotaResponse({
    ...quotaResponseFixture,
    boosterWallet: {
      balance: { type: "BOOSTER", amount: 20_000_000_000, amountLeft: 12_345_000_000 },
      monthlyChargeLimit: { priceInCents: 9900, currency: "CNY" },
      monthlyUsed: 0,
      monthlyChargeLimitEnabled: true
    }
  });

  assert.ok(quota);
  assert.equal(quota.boosterWallet?.balanceCents, 12345);
  assert.equal(quota.boosterWallet?.currency, "CNY");
});

test("parseKimiQuotaResponse tolerates unknown shapes", () => {
  assert.equal(parseKimiQuotaResponse(null), null);
  assert.equal(parseKimiQuotaResponse({}), null);
  assert.equal(parseKimiQuotaResponse({ usages: { limit_5h: { reset_time: "x" } } }), null);
});
