import type { ScheduledTaskRecord } from "../domain/types.js";
import { ScheduledTaskStore } from "../stores/scheduled-task-store.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

type CronFieldName = "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek";

interface CronFieldDefinition {
  name: CronFieldName;
  min: number;
  max: number;
}

interface ParsedCronField {
  wildcard: boolean;
  values: Set<number>;
}

interface ParsedCronExpression {
  normalized: string;
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
}

export type ScheduledTaskTriggerResult =
  | {
      outcome: "triggered";
    }
  | {
      outcome: "busy";
    }
  | {
      outcome: "pause";
      reason: string;
    };

interface CreateScheduledTaskInput {
  chatId: string;
  cron: string;
  prompt: string;
  createdById?: string;
  createdByName?: string;
}

type UpdateScheduledTaskResult =
  | {
      ok: true;
      task: ScheduledTaskRecord;
    }
  | {
      ok: false;
      detail: string;
    };

const CRON_FIELDS: CronFieldDefinition[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dayOfWeek", min: 0, max: 7 }
];

const MAX_CRON_SEARCH_MINUTES = 60 * 24 * 366 * 5;

function normalizeDayOfWeek(value: number): number {
  return value === 7 ? 0 : value;
}

function parseCronValue(raw: string, definition: CronFieldDefinition): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`cron 的 ${definition.name} 字段必须是数字`);
  }

  const value = Number.parseInt(raw, 10);
  const normalized = definition.name === "dayOfWeek" ? normalizeDayOfWeek(value) : value;
  if (normalized < definition.min || normalized > definition.max) {
    throw new Error(
      `cron 的 ${definition.name} 字段必须位于 ${definition.min}-${definition.max}${
        definition.name === "dayOfWeek" ? "（周日可写 0 或 7）" : ""
      }`
    );
  }

  return normalized;
}

function expandCronToken(token: string, definition: CronFieldDefinition): number[] {
  const [base, stepRaw, extraStep] = token.split("/");
  if (!base || extraStep !== undefined) {
    throw new Error(`cron 的 ${definition.name} 字段格式不正确`);
  }

  let step = 1;
  if (stepRaw !== undefined) {
    if (!/^\d+$/.test(stepRaw)) {
      throw new Error(`cron 的 ${definition.name} 字段步长必须是数字`);
    }
    step = Number.parseInt(stepRaw, 10);
    if (step <= 0) {
      throw new Error(`cron 的 ${definition.name} 字段步长必须大于 0`);
    }
  }

  let start: number;
  let end: number;
  if (base === "*") {
    start = definition.min;
    end = definition.max;
  } else if (base.includes("-")) {
    const [leftRaw, rightRaw, extraRange] = base.split("-");
    if (!leftRaw || !rightRaw || extraRange !== undefined) {
      throw new Error(`cron 的 ${definition.name} 字段区间格式不正确`);
    }
    start = parseCronValue(leftRaw, definition);
    end = parseCronValue(rightRaw, definition);
    if (start > end) {
      throw new Error(`cron 的 ${definition.name} 字段区间必须从小到大`);
    }
  } else {
    start = parseCronValue(base, definition);
    end = start;
  }

  const values: number[] = [];
  for (let value = start; value <= end; value += step) {
    values.push(definition.name === "dayOfWeek" ? normalizeDayOfWeek(value) : value);
  }
  return values;
}

function parseCronField(raw: string, definition: CronFieldDefinition): ParsedCronField {
  const value = raw.trim();
  if (!value) {
    throw new Error(`cron 的 ${definition.name} 字段不能为空`);
  }

  const segments = value.split(",");
  const values = new Set<number>();
  for (const segment of segments) {
    for (const expanded of expandCronToken(segment.trim(), definition)) {
      values.add(expanded);
    }
  }

  return {
    wildcard: value === "*",
    values
  };
}

export function parseCronExpression(expression: string): ParsedCronExpression {
  const normalized = expression.trim().replace(/\s+/g, " ");
  const parts = normalized.split(" ");
  if (parts.length !== 5) {
    throw new Error("cron 表达式必须是 5 段：分 时 日 月 周");
  }

  const parsedFields = parts.map((part, index) => parseCronField(part, CRON_FIELDS[index]!));
  return {
    normalized,
    minute: parsedFields[0]!,
    hour: parsedFields[1]!,
    dayOfMonth: parsedFields[2]!,
    month: parsedFields[3]!,
    dayOfWeek: parsedFields[4]!
  };
}

function matchesCronDate(cron: ParsedCronExpression, date: Date): boolean {
  if (!cron.minute.values.has(date.getMinutes())) {
    return false;
  }
  if (!cron.hour.values.has(date.getHours())) {
    return false;
  }
  if (!cron.month.values.has(date.getMonth() + 1)) {
    return false;
  }

  const dayOfMonthMatch = cron.dayOfMonth.values.has(date.getDate());
  const dayOfWeekMatch = cron.dayOfWeek.values.has(date.getDay());
  if (cron.dayOfMonth.wildcard && cron.dayOfWeek.wildcard) {
    return true;
  }
  if (cron.dayOfMonth.wildcard) {
    return dayOfWeekMatch;
  }
  if (cron.dayOfWeek.wildcard) {
    return dayOfMonthMatch;
  }
  return dayOfMonthMatch || dayOfWeekMatch;
}

export function getNextCronOccurrence(
  expression: string | ParsedCronExpression,
  from: Date
): Date | undefined {
  const parsed = typeof expression === "string" ? parseCronExpression(expression) : expression;
  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let i = 0; i < MAX_CRON_SEARCH_MINUTES; i += 1) {
    if (matchesCronDate(parsed, candidate)) {
      return new Date(candidate);
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return undefined;
}

export function formatScheduleTime(value?: string): string {
  if (!value) {
    return "未计划";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

export class ChatScheduleService {
  private timer?: NodeJS.Timeout;
  private scanInFlight = false;
  private triggerHandler?: (task: ScheduledTaskRecord) => Promise<ScheduledTaskTriggerResult>;

  constructor(
    private readonly store: ScheduledTaskStore,
    private readonly logger?: LoggerLike,
    private readonly options: {
      now?: () => Date;
      tickMs?: number;
    } = {}
  ) {}

  start(handler: (task: ScheduledTaskRecord) => Promise<ScheduledTaskTriggerResult>): void {
    this.triggerHandler = handler;
    this.ensureEnabledTasksHaveNextRunAt();

    const tickMs = this.options.tickMs ?? 30_000;
    if (this.timer) {
      clearInterval(this.timer);
    }

    this.timer = setInterval(() => {
      void this.scanDueTasks();
    }, tickMs);

    void this.scanDueTasks();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  list(): ScheduledTaskRecord[] {
    return this.store.list();
  }

  listByChat(chatId: string): ScheduledTaskRecord[] {
    return this.store.listByChat(chatId);
  }

  createTask(input: CreateScheduledTaskInput): UpdateScheduledTaskResult {
    const prompt = input.prompt.trim();
    if (!prompt) {
      return {
        ok: false,
        detail: "定时任务内容不能为空。"
      };
    }

    let parsed: ParsedCronExpression;
    try {
      parsed = parseCronExpression(input.cron);
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error)
      };
    }

    const nextRunAt = getNextCronOccurrence(parsed, this.now());
    if (!nextRunAt) {
      return {
        ok: false,
        detail: "这个 cron 表达式在未来几年内都不会触发，请检查日期范围。"
      };
    }

    const nowIso = this.now().toISOString();
    const taskId = this.allocateTaskId(input.chatId);
    const task: ScheduledTaskRecord = {
      chatId: input.chatId,
      taskId,
      cron: parsed.normalized,
      prompt,
      status: "enabled",
      createdAt: nowIso,
      updatedAt: nowIso,
      createdById: input.createdById,
      createdByName: input.createdByName,
      nextRunAt: nextRunAt.toISOString()
    };
    this.store.save(task);
    return {
      ok: true,
      task
    };
  }

  pauseTask(chatId: string, taskId: string, reason?: string): UpdateScheduledTaskResult {
    const task = this.store.get(chatId, taskId);
    if (!task) {
      return {
        ok: false,
        detail: `这个群里没有编号 ${taskId} 的定时任务。`
      };
    }

    const nextTask: ScheduledTaskRecord = {
      ...task,
      status: "paused",
      updatedAt: this.now().toISOString(),
      nextRunAt: undefined,
      lastError: reason ?? task.lastError
    };
    this.store.save(nextTask);
    return {
      ok: true,
      task: nextTask
    };
  }

  resumeTask(chatId: string, taskId: string): UpdateScheduledTaskResult {
    const task = this.store.get(chatId, taskId);
    if (!task) {
      return {
        ok: false,
        detail: `这个群里没有编号 ${taskId} 的定时任务。`
      };
    }

    const nextRunAt = getNextCronOccurrence(task.cron, this.now());
    if (!nextRunAt) {
      return {
        ok: false,
        detail: "这个 cron 表达式在未来几年内都不会触发，请检查日期范围。"
      };
    }

    const nextTask: ScheduledTaskRecord = {
      ...task,
      status: "enabled",
      updatedAt: this.now().toISOString(),
      nextRunAt: nextRunAt.toISOString(),
      lastError: undefined
    };
    this.store.save(nextTask);
    return {
      ok: true,
      task: nextTask
    };
  }

  deleteTask(chatId: string, taskId: string): UpdateScheduledTaskResult {
    const task = this.store.get(chatId, taskId);
    if (!task) {
      return {
        ok: false,
        detail: `这个群里没有编号 ${taskId} 的定时任务。`
      };
    }

    this.store.delete(chatId, taskId);
    return {
      ok: true,
      task
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private allocateTaskId(chatId: string): string {
    const maxTaskId = this.store
      .listByChat(chatId)
      .map((task) => Number.parseInt(task.taskId, 10))
      .filter((value) => Number.isFinite(value))
      .reduce((max, value) => Math.max(max, value), 0);
    return String(maxTaskId + 1);
  }

  private ensureEnabledTasksHaveNextRunAt(): void {
    for (const task of this.store.list()) {
      if (task.status !== "enabled" || task.nextRunAt) {
        continue;
      }

      const nextRunAt = getNextCronOccurrence(task.cron, this.now());
      if (!nextRunAt) {
        this.logger?.warn(
          {
            chatId: task.chatId,
            taskId: task.taskId,
            cron: task.cron
          },
          "定时任务没有可计算的下一次触发时间，已保持暂停"
        );
        this.store.save({
          ...task,
          status: "paused",
          updatedAt: this.now().toISOString(),
          lastError: "cron 表达式无法计算出下一次触发时间"
        });
        continue;
      }

      this.store.save({
        ...task,
        nextRunAt: nextRunAt.toISOString(),
        updatedAt: this.now().toISOString()
      });
    }
  }

  private async scanDueTasks(): Promise<void> {
    if (!this.triggerHandler || this.scanInFlight) {
      return;
    }

    this.scanInFlight = true;
    try {
      const now = this.now();
      const dueTasks = this.store
        .list()
        .filter((task) => task.status === "enabled" && task.nextRunAt)
        .filter((task) => new Date(task.nextRunAt!).getTime() <= now.getTime());

      for (const task of dueTasks) {
        await this.processDueTask(task);
      }
    } finally {
      this.scanInFlight = false;
    }
  }

  private async processDueTask(task: ScheduledTaskRecord): Promise<void> {
    const currentTask = this.store.get(task.chatId, task.taskId);
    if (!currentTask || currentTask.status !== "enabled" || !currentTask.nextRunAt) {
      return;
    }

    try {
      const result = await this.triggerHandler!(currentTask);
      if (result.outcome === "busy") {
        return;
      }

      if (result.outcome === "pause") {
        this.pauseTask(currentTask.chatId, currentTask.taskId, result.reason);
        return;
      }

      const nextRunAt = getNextCronOccurrence(currentTask.cron, this.now());
      this.store.save({
        ...currentTask,
        updatedAt: this.now().toISOString(),
        lastTriggeredAt: this.now().toISOString(),
        nextRunAt: nextRunAt?.toISOString(),
        lastError: undefined
      });
    } catch (error) {
      this.logger?.error(
        {
          chatId: currentTask.chatId,
          taskId: currentTask.taskId,
          error: error instanceof Error ? error.message : String(error)
        },
        "触发定时任务失败，将在下一个轮询周期重试"
      );
    }
  }
}
