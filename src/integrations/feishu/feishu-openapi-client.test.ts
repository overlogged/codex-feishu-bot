import assert from "node:assert/strict";
import test from "node:test";

import { resolveFeishuWsProxyUrl } from "./feishu-openapi-client.js";
import type { Env } from "../../config/env.js";

function envWith(overrides: Partial<Env>): Env {
  return overrides as Env;
}

test("resolveFeishuWsProxyUrl 优先使用 FEISHU_WS_PROXY_URL", () => {
  assert.equal(
    resolveFeishuWsProxyUrl(
      envWith({
        FEISHU_WS_PROXY_URL: "http://explicit:8080",
        HTTPS_PROXY: "http://https-proxy:8080",
        HTTP_PROXY: "http://http-proxy:8080"
      })
    ),
    "http://explicit:8080"
  );
});

test("resolveFeishuWsProxyUrl 回退到 HTTPS_PROXY 再回退到 HTTP_PROXY", () => {
  assert.equal(
    resolveFeishuWsProxyUrl(
      envWith({
        HTTPS_PROXY: "http://https-proxy:8080",
        HTTP_PROXY: "http://http-proxy:8080"
      })
    ),
    "http://https-proxy:8080"
  );

  assert.equal(
    resolveFeishuWsProxyUrl(
      envWith({
        HTTP_PROXY: "http://http-proxy:8080"
      })
    ),
    "http://http-proxy:8080"
  );
});

test("resolveFeishuWsProxyUrl 在禁用或未配置时返回 undefined", () => {
  assert.equal(
    resolveFeishuWsProxyUrl(
      envWith({
        FEISHU_WS_PROXY_DISABLED: true,
        HTTPS_PROXY: "http://https-proxy:8080"
      })
    ),
    undefined
  );

  assert.equal(resolveFeishuWsProxyUrl(envWith({})), undefined);
  assert.equal(
    resolveFeishuWsProxyUrl(
      envWith({
        HTTPS_PROXY: "   "
      })
    ),
    undefined
  );
});
