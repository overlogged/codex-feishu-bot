import type { Client } from "@larksuiteoapi/node-sdk";

import type { ChatSession } from "../../domain/types.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

interface FeishuApiResponse<T = unknown> {
  code?: number;
  msg?: string;
  data?: T;
}

export interface SessionMetadataProviderInput {
  session: ChatSession;
  chatType: string;
}

export interface SessionMetadataProviderResult {
  patch: Partial<Pick<ChatSession, "chatType" | "chatName" | "chatDisplayName">>;
  warnings: string[];
}

export interface SessionMetadataProvider {
  refreshSessionMetadata(input: SessionMetadataProviderInput): Promise<SessionMetadataProviderResult>;
}

function pickChatName(data: {
  name?: string;
  i18n_names?: {
    zh_cn?: string;
    en_us?: string;
    ja_jp?: string;
  };
}): string | undefined {
  return (
    data.name?.trim() ||
    data.i18n_names?.zh_cn?.trim() ||
    data.i18n_names?.en_us?.trim() ||
    data.i18n_names?.ja_jp?.trim() ||
    undefined
  );
}

function extractFeishuError(error: unknown): { code?: number; message: string } {
  if (
    error &&
    typeof error === "object" &&
    "response" in error &&
    error.response &&
    typeof error.response === "object" &&
    "data" in error.response &&
    error.response.data &&
    typeof error.response.data === "object"
  ) {
    const data = error.response.data as {
      code?: number;
      msg?: string;
    };
    return {
      code: data.code,
      message: data.msg ?? (error instanceof Error ? error.message : String(error))
    };
  }

  return {
    message: error instanceof Error ? error.message : String(error)
  };
}

export class FeishuSessionMetadataProvider implements SessionMetadataProvider {
  constructor(
    private readonly client: Client,
    private readonly logger?: LoggerLike
  ) {}

  async refreshSessionMetadata(
    input: SessionMetadataProviderInput
  ): Promise<SessionMetadataProviderResult> {
    const warnings: string[] = [];
    const chatResponse = (await this.client.im.v1.chat.get({
      path: {
        chat_id: input.session.chatId
      }
    })) as FeishuApiResponse<{
      name?: string;
      i18n_names?: {
        zh_cn?: string;
        en_us?: string;
        ja_jp?: string;
      };
      owner_id?: string;
      chat_mode?: string;
      chat_type?: string;
    }>;

    const patch: SessionMetadataProviderResult["patch"] = {};
    const chatData = chatResponse.data ?? {};
    const normalizedChatType = chatData.chat_mode === "p2p" ? "p2p" : "group";
    patch.chatType = normalizedChatType;

    const groupName = pickChatName(chatData);
    if (normalizedChatType === "group") {
      if (groupName) {
        patch.chatName = groupName;
        patch.chatDisplayName = groupName;
      }
      return {
        patch,
        warnings
      };
    }

    if (groupName) {
      patch.chatName = groupName;
      patch.chatDisplayName = groupName;
      return {
        patch,
        warnings
      };
    }

    const userId = chatData.owner_id ?? input.session.lastSenderId;
    if (!userId || userId === "unknown") {
      warnings.push("这个私聊缺少可用的用户标识，暂时无法回填对方名称。");
      return {
        patch,
        warnings
      };
    }

    try {
      const userResponse = (await this.client.contact.v3.user.get({
        params: {
          user_id_type: "open_id"
        },
        path: {
          user_id: userId
        }
      })) as FeishuApiResponse<{
        user?: {
          name?: string;
          nickname?: string;
          en_name?: string;
        };
      }>;

      const user = userResponse.data?.user;
      const displayName = user?.name?.trim() || user?.nickname?.trim() || user?.en_name?.trim();
      if (displayName) {
        patch.chatName = displayName;
        patch.chatDisplayName = displayName;
        return {
          patch,
          warnings
        };
      }

      warnings.push("拿到了私聊用户对象，但返回里没有可用名称。");
      return {
        patch,
        warnings
      };
    } catch (error) {
      const detail = extractFeishuError(error);
      if (detail.code === 99991672) {
        warnings.push("缺少飞书通讯录只读权限，暂时无法回填私聊对象名称。");
      } else {
        warnings.push(`回填私聊对象名称失败：${detail.message}`);
      }
      this.logger?.warn(
        {
          chatId: input.session.chatId,
          chatType: input.chatType,
          userId,
          errorCode: detail.code,
          error: detail.message
        },
        "回填飞书私聊对象名称失败"
      );
      return {
        patch,
        warnings
      };
    }
  }
}
