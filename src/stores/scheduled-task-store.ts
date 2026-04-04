import type { ScheduledTaskRecord } from "../domain/types.js";

export class ScheduledTaskStore {
  private readonly tasks = new Map<string, ScheduledTaskRecord>();

  constructor(private readonly onChange?: () => void) {}

  get(chatId: string, taskId: string): ScheduledTaskRecord | undefined {
    return this.tasks.get(this.makeKey(chatId, taskId));
  }

  save(task: ScheduledTaskRecord): ScheduledTaskRecord {
    this.tasks.set(this.makeKey(task.chatId, task.taskId), task);
    this.onChange?.();
    return task;
  }

  delete(chatId: string, taskId: string): boolean {
    const deleted = this.tasks.delete(this.makeKey(chatId, taskId));
    if (deleted) {
      this.onChange?.();
    }
    return deleted;
  }

  replaceAll(tasks: ScheduledTaskRecord[]): void {
    this.tasks.clear();
    for (const task of tasks) {
      this.tasks.set(this.makeKey(task.chatId, task.taskId), task);
    }
  }

  list(): ScheduledTaskRecord[] {
    return this.sortTasks(Array.from(this.tasks.values()));
  }

  listByChat(chatId: string): ScheduledTaskRecord[] {
    return this.sortTasks(Array.from(this.tasks.values()).filter((task) => task.chatId === chatId));
  }

  private makeKey(chatId: string, taskId: string): string {
    return `${chatId}:${taskId}`;
  }

  private sortTasks(tasks: ScheduledTaskRecord[]): ScheduledTaskRecord[] {
    return [...tasks].sort((left, right) => {
      const leftId = Number.parseInt(left.taskId, 10);
      const rightId = Number.parseInt(right.taskId, 10);
      if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) {
        return leftId - rightId;
      }

      return left.createdAt.localeCompare(right.createdAt) || left.taskId.localeCompare(right.taskId);
    });
  }
}
