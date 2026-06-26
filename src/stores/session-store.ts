import type { ChatSession } from "../domain/types.js";

function stripLegacyGoalFields(session: ChatSession): ChatSession {
  const { goal: _goal, goalUpdatedAt: _goalUpdatedAt, ...cleanSession } =
    session as ChatSession & {
      goal?: string;
      goalUpdatedAt?: string;
    };
  return cleanSession;
}

export class SessionStore {
  private readonly sessions = new Map<string, ChatSession>();

  constructor(private readonly onChange?: () => void) {}

  get(chatId: string): ChatSession | undefined {
    return this.sessions.get(chatId);
  }

  save(session: ChatSession): ChatSession {
    const cleanSession = stripLegacyGoalFields(session);
    this.sessions.set(cleanSession.chatId, cleanSession);
    this.onChange?.();
    return cleanSession;
  }

  attachRun(chatId: string, runId: string): void {
    const session = this.sessions.get(chatId);
    if (!session) {
      return;
    }

    this.sessions.set(chatId, {
      ...session,
      activeRunId: runId,
      updatedAt: new Date().toISOString()
    });
    this.onChange?.();
  }

  bindTurn(chatId: string, turnId: string, runId?: string): void {
    const session = this.sessions.get(chatId);
    if (!session || (runId && session.activeRunId !== runId)) {
      return;
    }

    this.sessions.set(chatId, {
      ...session,
      activeTurnId: turnId,
      updatedAt: new Date().toISOString()
    });
    this.onChange?.();
  }

  updateBoundRun(chatId: string, runId: string, patch: Partial<ChatSession>): void {
    const session = this.sessions.get(chatId);
    if (!session || session.activeRunId !== runId) {
      return;
    }

    this.sessions.set(chatId, {
      ...session,
      ...patch,
      activeRunId: runId,
      updatedAt: new Date().toISOString()
    });
    this.onChange?.();
  }

  releaseRun(chatId: string, runId?: string): void {
    const session = this.sessions.get(chatId);
    if (!session || (runId && session.activeRunId !== runId)) {
      return;
    }

    this.sessions.set(chatId, {
      ...session,
      activeRunId: undefined,
      activeTurnId: undefined,
      updatedAt: new Date().toISOString()
    });
    this.onChange?.();
  }

  replaceAll(sessions: ChatSession[]): void {
    this.sessions.clear();
    for (const session of sessions) {
      const cleanSession = stripLegacyGoalFields(session);
      this.sessions.set(cleanSession.chatId, cleanSession);
    }
  }

  list(): ChatSession[] {
    return Array.from(this.sessions.values());
  }
}
