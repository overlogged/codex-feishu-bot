/** Generic proxy variables must not leak into Feishu or other CLI backends. */
const proxyKeys = [
  "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY",
  "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY"
] as const;

export function clearProxyEnv(env: NodeJS.ProcessEnv): void {
  for (const key of proxyKeys) delete env[key];
}

/** Apply the dedicated proxy only to a Codex / codex-auth child process. */
export function codexProxyEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  clearProxyEnv(env);
  const proxy = source.CODEX_PROXY_URL?.trim();
  if (proxy) {
    env.http_proxy = env.https_proxy = env.HTTP_PROXY = env.HTTPS_PROXY = proxy;
    env.no_proxy = env.NO_PROXY = "localhost,127.0.0.1,::1";
  }
  return env;
}
