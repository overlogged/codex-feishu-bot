import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  AgentManagerService,
  type AgentManagerSendInput
} from "../services/agent-manager-service.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isLocalRequest(request: FastifyRequest): boolean {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip);
}

function rejectNonLocal(reply: FastifyReply) {
  reply.code(403);
  return {
    ok: false,
    error: "agent-manager 接口只允许本机访问。"
  };
}

function parseSendInput(body: unknown, source: AgentManagerSendInput["source"]): AgentManagerSendInput {
  if (!isRecord(body)) {
    throw new Error("请求体必须是 JSON 对象。");
  }

  const from = typeof body.from === "string" ? body.from : "";
  const content = typeof body.content === "string" ? body.content : "";
  const mirrorToFeishu = typeof body.mirrorToFeishu === "boolean" ? body.mirrorToFeishu : undefined;

  return {
    from,
    content,
    source,
    mirrorToFeishu
  };
}

function parseUpdateInput(body: unknown): { chatId?: string } {
  if (body === undefined || body === null) {
    return {};
  }

  if (!isRecord(body)) {
    throw new Error("请求体必须是 JSON 对象。");
  }

  return {
    chatId: typeof body.chatId === "string" && body.chatId.trim() ? body.chatId.trim() : undefined
  };
}

function parseStableMessageQuery(query: unknown): {
  afterId?: string;
  limit?: number;
  source?: "commentary" | "final_answer" | "all";
} {
  if (!isRecord(query)) {
    return {};
  }

  const rawLimit = typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : undefined;
  const rawSource = typeof query.source === "string" ? query.source.trim().toLowerCase() : undefined;

  return {
    afterId:
      typeof query.afterId === "string" && query.afterId.trim() ? query.afterId.trim() : undefined,
    limit: Number.isFinite(rawLimit) && rawLimit && rawLimit > 0 ? rawLimit : undefined,
    source:
      rawSource === "commentary" || rawSource === "final_answer" || rawSource === "all"
        ? rawSource
        : undefined
  };
}

export async function registerAgentManagerRoutes(
  app: FastifyInstance,
  dependencies: {
    agentManager: AgentManagerService;
  }
): Promise<void> {
  app.get("/agent-manager/sessions", async (request, reply) => {
    if (!isLocalRequest(request)) {
      return rejectNonLocal(reply);
    }

    const sessions = dependencies.agentManager.listSessions();
    return {
      ok: true,
      mainPrivateChatId: sessions.find((session) => session.isMainPrivateSession)?.chatId,
      sessions
    };
  });

  app.get("/agent-manager/main-session", async (request, reply) => {
    if (!isLocalRequest(request)) {
      return rejectNonLocal(reply);
    }

    const session = dependencies.agentManager.getMainPrivateSession();
    if (!session) {
      reply.code(404);
      return {
        ok: false,
        error: "当前没有可用的私聊主 session。"
      };
    }

    return {
      ok: true,
      session
    };
  });

  app.get<{
    Params: {
      chatId: string;
    };
  }>("/agent-manager/sessions/:chatId", async (request, reply) => {
    if (!isLocalRequest(request)) {
      return rejectNonLocal(reply);
    }

    const session = dependencies.agentManager.getSession(request.params.chatId);
    if (!session) {
      reply.code(404);
      return {
        ok: false,
        error: `chatId=${request.params.chatId} 的 session 不存在。`
      };
    }

    return {
      ok: true,
      session
    };
  });

  app.post("/agent-manager/main-session/messages", async (request, reply) => {
    if (!isLocalRequest(request)) {
      return rejectNonLocal(reply);
    }

    try {
      const result = await dependencies.agentManager.sendToMainPrivateSession(
        parseSendInput(request.body, "http")
      );
      reply.code(202);
      return {
        ok: true,
        accepted: true,
        ...result
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      reply.code(400);
      return {
        ok: false,
        error: detail
      };
    }
  });

  app.get("/agent-manager/main-session/stable-messages", async (request, reply) => {
    if (!isLocalRequest(request)) {
      return rejectNonLocal(reply);
    }

    try {
      const result = dependencies.agentManager.listStableMessagesForMainPrivateSession(
        parseStableMessageQuery(request.query)
      );
      return {
        ok: true,
        ...result
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      reply.code(400);
      return {
        ok: false,
        error: detail
      };
    }
  });

  app.post<{
    Params: {
      chatId: string;
    };
  }>("/agent-manager/sessions/:chatId/messages", async (request, reply) => {
    if (!isLocalRequest(request)) {
      return rejectNonLocal(reply);
    }

    try {
      const result = await dependencies.agentManager.sendToSession(
        request.params.chatId,
        parseSendInput(request.body, "http")
      );
      reply.code(202);
      return {
        ok: true,
        accepted: true,
        ...result
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      reply.code(detail.includes("不存在") ? 404 : 400);
      return {
        ok: false,
        error: detail
      };
    }
  });

  app.get<{
    Params: {
      chatId: string;
    };
  }>("/agent-manager/sessions/:chatId/stable-messages", async (request, reply) => {
    if (!isLocalRequest(request)) {
      return rejectNonLocal(reply);
    }

    try {
      const result = dependencies.agentManager.listStableMessagesForSession(
        request.params.chatId,
        parseStableMessageQuery(request.query)
      );
      return {
        ok: true,
        ...result
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      reply.code(detail.includes("不存在") ? 404 : 400);
      return {
        ok: false,
        error: detail
      };
    }
  });

  app.post("/agent-manager/sessions/update", async (request, reply) => {
    if (!isLocalRequest(request)) {
      return rejectNonLocal(reply);
    }

    try {
      const result = await dependencies.agentManager.updateSessionMetadata(
        parseUpdateInput(request.body).chatId
      );
      return {
        ok: true,
        ...result
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      reply.code(detail.includes("不存在") ? 404 : 400);
      return {
        ok: false,
        error: detail
      };
    }
  });
}
