import * as Lark from "@larksuiteoapi/node-sdk";
import { HttpsProxyAgent } from "https-proxy-agent";

import type { Env } from "../../config/env.js";

export function hasFeishuCredentials(env: Env): boolean {
  return Boolean(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET);
}

function resolveFeishuDomain(domain: string): string | Lark.Domain {
  if (domain === "feishu") {
    return Lark.Domain.Feishu;
  }

  if (domain === "lark") {
    return Lark.Domain.Lark;
  }

  return domain;
}

export function createFeishuOpenApiClient(env: Env): Lark.Client {
  return new Lark.Client({
    appId: env.FEISHU_APP_ID ?? "",
    appSecret: env.FEISHU_APP_SECRET ?? "",
    domain: resolveFeishuDomain(env.FEISHU_DOMAIN)
  });
}

export function createFeishuWsClient(env: Env): Lark.WSClient {
  const proxyUrl = resolveFeishuWsProxyUrl(env);

  return new Lark.WSClient({
    appId: env.FEISHU_APP_ID ?? "",
    appSecret: env.FEISHU_APP_SECRET ?? "",
    domain: resolveFeishuDomain(env.FEISHU_DOMAIN),
    loggerLevel: Lark.LoggerLevel.info,
    // SDK 的 REST 调用走 axios，会自动读 HTTPS_PROXY；但长连接是 ws 包直接建连，
    // 完全不看代理环境变量。机器只能通过代理出网时，长连接会一直建不起来
    // （表现为 ws connect failed，且 REST 发消息却正常），所以这里显式挂上代理 agent。
    ...(proxyUrl
      ? {
          agent: new HttpsProxyAgent(proxyUrl)
        }
      : {})
  });
}

/**
 * 长连接使用的代理地址。
 *
 * 优先级：FEISHU_WS_PROXY_URL > HTTPS_PROXY > HTTP_PROXY；
 * FEISHU_WS_PROXY_DISABLED=true 时强制直连（不看环境变量）。
 */
export function resolveFeishuWsProxyUrl(env: Env): string | undefined {
  if (env.FEISHU_WS_PROXY_DISABLED) {
    return undefined;
  }

  const candidate = env.FEISHU_WS_PROXY_URL ?? env.HTTPS_PROXY ?? env.HTTP_PROXY;
  const trimmed = candidate?.trim();

  return trimmed ? trimmed : undefined;
}
