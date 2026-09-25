import assert from "node:assert/strict";
import test from "node:test";
import { clearProxyEnv, codexProxyEnv } from "../config/proxy-env.js";

test("bot clears inherited proxies while retaining Codex-specific config and other env", () => {
  const env = {
    HTTP_PROXY: "http://old:1", https_proxy: "http://old:2", ALL_PROXY: "socks5://old:3",
    NO_PROXY: "*", CODEX_PROXY_URL: "http://codex:7891", PATH: "/bin"
  };
  clearProxyEnv(env);
  assert.deepEqual(env, { CODEX_PROXY_URL: "http://codex:7891", PATH: "/bin" });
});

test("Codex child receives its own proxy without modifying the bot environment", () => {
  const parent = { CODEX_PROXY_URL: "http://codex:7891", PATH: "/bin", ALL_PROXY: "socks5://old:3", NO_PROXY: "*" };
  const child = codexProxyEnv(parent);
  for (const key of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"]) {
    assert.equal(child[key], parent.CODEX_PROXY_URL);
  }
  assert.equal(child.ALL_PROXY, undefined);
  assert.equal(child.NO_PROXY, "localhost,127.0.0.1,::1");
  assert.equal(child.PATH, "/bin");
  assert.equal(parent.NO_PROXY, "*");
  assert.equal("HTTP_PROXY" in parent, false);
});

test("Codex without a dedicated proxy cannot fall back to inherited generic proxies", () => {
  assert.deepEqual(codexProxyEnv({ HTTPS_PROXY: "http://old:1", all_proxy: "socks5://old:2" }), {});
});
