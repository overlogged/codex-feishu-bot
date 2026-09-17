import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

import type { ChatCli } from "../../domain/types.js";

export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
}

const BRIDGE_INSTRUCTIONS_MARKER = "Controller instructions for the Feishu bridge environment:";
const BRIDGE_USER_MESSAGE_MARKER = "User message:";
const CONTROL_ORIGINAL_MESSAGE_MARKER = "用户原始消息：";
const CONTROL_STRIPPED_MESSAGE_MARKER = "用户消息（已去掉 @提及）：";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonLines(raw: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) {
        entries.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return entries;
}

function extractTextParts(content: unknown, textTypes: Set<string>): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) =>
      isRecord(part) &&
      typeof part.type === "string" &&
      textTypes.has(part.type) &&
      typeof part.text === "string"
        ? part.text
        : ""
    )
    .filter(Boolean)
    .join("\n");
}

function parseCodexRollout(raw: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const entry of parseJsonLines(raw)) {
    if (entry.type !== "response_item" || !isRecord(entry.payload)) {
      continue;
    }

    const payload = entry.payload;
    if (payload.type !== "message" || (payload.role !== "user" && payload.role !== "assistant")) {
      continue;
    }

    const text = extractTextParts(payload.content, new Set(["input_text", "output_text"])).trim();
    if (!text || text.startsWith("<environment_context>")) {
      continue;
    }

    messages.push({ role: payload.role, text });
  }
  return messages;
}

function parsePiSession(raw: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const entry of parseJsonLines(raw)) {
    if (entry.type !== "message" || !isRecord(entry.message)) {
      continue;
    }

    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    const text = extractTextParts(message.content, new Set(["text"])).trim();
    if (!text) {
      continue;
    }

    messages.push({ role: message.role, text });
  }
  return messages;
}

function parseKimiAcpWire(raw: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  const push = (message: TranscriptMessage) => {
    if (!message.text) {
      return;
    }

    const previous = messages.at(-1);
    // The ACP wire log records the same user turn as both an
    // agent.message.appended and a context.append_message event.
    if (previous && previous.role === message.role && previous.text === message.text) {
      return;
    }

    messages.push(message);
  };

  for (const entry of parseJsonLines(raw)) {
    if (entry.type === "context.append_message" && isRecord(entry.message)) {
      const message = entry.message;
      if (message.role !== "user") {
        continue;
      }

      const origin = isRecord(message.origin) ? message.origin : undefined;
      if (origin && origin.kind !== "user") {
        // system-reminder injections are not part of the visible transcript.
        continue;
      }

      push({
        role: "user",
        text: extractTextParts(message.content, new Set(["text"])).trim()
      });
      continue;
    }

    if (entry.type === "agent.message.appended" && isRecord(entry.message)) {
      const inner = isRecord(entry.message.message) ? entry.message.message : undefined;
      if (!inner || (inner.role !== "user" && inner.role !== "assistant")) {
        continue;
      }

      push({
        role: inner.role,
        text: extractTextParts(inner.content, new Set(["text"])).trim()
      });
      continue;
    }

    if (entry.type === "context.append_loop_event" && isRecord(entry.event)) {
      const event = entry.event;
      if (event.type !== "content.part" || !isRecord(event.part)) {
        continue;
      }

      const part = event.part;
      // Only surface user-visible text; "think" parts stay out of handoffs.
      if (part.type !== "text" || typeof part.text !== "string") {
        continue;
      }

      push({ role: "assistant", text: part.text.trim() });
    }
  }

  return messages;
}

function parseClaudeSession(raw: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const entry of parseJsonLines(raw)) {
    if ((entry.type !== "user" && entry.type !== "assistant") || !isRecord(entry.message)) {
      continue;
    }

    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    const text = extractTextParts(message.content, new Set(["text"])).trim();
    if (!text || text.startsWith("<command-message>") || text.startsWith("<local-command")) {
      continue;
    }

    messages.push({ role: message.role, text });
  }
  return messages;
}

async function walkFiles(dir: string, maxDepth: number): Promise<string[]> {
  if (maxDepth < 0) {
    return [];
  }

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile()) {
      files.push(path);
    } else if (entry.isDirectory()) {
      files.push(...(await walkFiles(path, maxDepth - 1)));
    }
  }
  return files;
}

async function locateCodexRollout(threadId: string): Promise<string | undefined> {
  const home = process.env.HOME ?? "/home/overlogged";
  const codexHome = process.env.CODEX_HOME?.trim() || join(home, ".codex");
  const candidates = (await walkFiles(join(codexHome, "sessions"), 4)).filter(
    (path) => path.endsWith(".jsonl") && path.includes(threadId)
  );
  if (candidates.length === 0) {
    return undefined;
  }

  const ranked = await Promise.all(
    candidates.map(async (path) => ({
      path,
      mtimeMs: await stat(path).then((info) => info.mtimeMs).catch(() => 0)
    }))
  );
  ranked.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return ranked[0]?.path;
}

function resolvePiSessionPath(threadId: string, workspaceId: string): string {
  return isAbsolute(threadId) ? threadId : resolve(workspaceId, threadId);
}

function resolveKimiWorkspaceKey(baseDir: string, workspaceId: string): string {
  const name = basename(workspaceId).toLowerCase().replace(/[^a-z0-9-]/g, "_");
  const hash = createHash("sha256").update(workspaceId).digest("hex").slice(0, 12);
  return `wd_${name}_${hash}`;
}

export async function resolveKimiAcpWirePath(
  threadId: string,
  workspaceId: string
): Promise<string> {
  const home = process.env.HOME ?? "/home/overlogged";
  const sessionsDir = join(home, ".kimi-code", "sessions");
  let workspaceKey = resolveKimiWorkspaceKey(sessionsDir, workspaceId);

  try {
    const raw = await readFile(join(home, ".kimi-code", "workspaces.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const workspaces = isRecord(parsed) && isRecord(parsed.workspaces) ? parsed.workspaces : undefined;
    for (const [key, value] of Object.entries(workspaces ?? {})) {
      if (isRecord(value) && value.root === workspaceId) {
        workspaceKey = key;
        break;
      }
    }
  } catch {
    // Fall back to the deterministic workspace directory name.
  }

  return join(sessionsDir, workspaceKey, threadId, "agents", "main", "wire.jsonl");
}

function resolveClaudeSessionPath(threadId: string, workspaceId: string): string {
  const home = process.env.HOME ?? "/home/overlogged";
  const projectSlug = workspaceId.replace(/[/.]/g, "-");
  return join(home, ".claude", "projects", projectSlug, `${threadId}.jsonl`);
}

async function readTranscriptFile(
  path: string,
  parse: (raw: string) => TranscriptMessage[]
): Promise<TranscriptMessage[] | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }

  const messages = parse(raw);
  return messages.length > 0 ? messages : undefined;
}

export async function readThreadTranscript(input: {
  cli: ChatCli;
  threadId: string;
  workspaceId: string;
}): Promise<TranscriptMessage[] | undefined> {
  if (!input.threadId || input.threadId.startsWith("pending:")) {
    return undefined;
  }

  switch (input.cli) {
    case "codex": {
      const rolloutPath = await locateCodexRollout(input.threadId);
      return rolloutPath ? readTranscriptFile(rolloutPath, parseCodexRollout) : undefined;
    }
    case "pi":
      return readTranscriptFile(
        resolvePiSessionPath(input.threadId, input.workspaceId),
        parsePiSession
      );
    case "kimi":
      return readTranscriptFile(await resolveKimiAcpWirePath(input.threadId, input.workspaceId), parseKimiAcpWire);
    case "claude":
      return readTranscriptFile(
        resolveClaudeSessionPath(input.threadId, input.workspaceId),
        parseClaudeSession
      );
    default:
      return undefined;
  }
}

export function unwrapUserVisibleText(text: string): string {
  let result = text.trim();

  if (result.startsWith(BRIDGE_INSTRUCTIONS_MARKER)) {
    const markerIndex = result.indexOf(BRIDGE_USER_MESSAGE_MARKER);
    if (markerIndex >= 0) {
      result = result.slice(markerIndex + BRIDGE_USER_MESSAGE_MARKER.length).trim();
    }
  }

  const controlMarkerIndex = result.indexOf(CONTROL_ORIGINAL_MESSAGE_MARKER);
  if (controlMarkerIndex >= 0) {
    result = result.slice(controlMarkerIndex + CONTROL_ORIGINAL_MESSAGE_MARKER.length);
    const strippedIndex = result.indexOf(CONTROL_STRIPPED_MESSAGE_MARKER);
    if (strippedIndex >= 0) {
      result = result.slice(0, strippedIndex);
    }
    result = result.trim();
  }

  return result;
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

export function renderTranscriptExcerpt(
  messages: TranscriptMessage[],
  options: {
    maxMessages?: number;
    perMessageMaxLength?: number;
    totalMaxLength?: number;
  } = {}
): string {
  const maxMessages = options.maxMessages ?? 12;
  const perMessageMaxLength = options.perMessageMaxLength ?? 500;
  const totalMaxLength = options.totalMaxLength ?? 5000;

  const lines: string[] = [];
  let total = 0;
  for (const message of messages.slice(-maxMessages)) {
    const label = message.role === "user" ? "用户" : "助手";
    const text =
      message.role === "user"
        ? truncateText(unwrapUserVisibleText(message.text), perMessageMaxLength)
        : truncateText(message.text, perMessageMaxLength);
    if (!text) {
      continue;
    }

    const line = `[${label}] ${text}`;
    if (total + line.length > totalMaxLength) {
      break;
    }

    total += line.length;
    lines.push(line);
  }

  return lines.join("\n");
}
