import type { Task, TaskPriority } from '../../../../shared/types/v3/index.js';

export const DEFAULT_AGING_INTERVAL_MS = 15 * 60_000;

const PRIORITY_LEVEL: Record<TaskPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

/**
 * Orders a dispatchable snapshot by base priority plus unbounded aging. Every
 * aging interval raises a task by one priority level, so old low-priority work
 * cannot starve behind a continuous stream of new critical work.
 */
export class FairTaskQueue {
  constructor(private readonly agingIntervalMs = DEFAULT_AGING_INTERVAL_MS) {
    if (!Number.isFinite(agingIntervalMs) || agingIntervalMs <= 0) {
      throw new Error('agingIntervalMs must be a positive finite number.');
    }
  }

  order(tasks: readonly Task[], now: Date | number = Date.now()): Task[] {
    const nowTimestamp = now instanceof Date ? now.getTime() : now;
    return [...tasks].sort((left, right) => {
      const scoreDifference = this.score(right, nowTimestamp) - this.score(left, nowTimestamp);
      if (scoreDifference !== 0) return scoreDifference;
      const createdDifference = timestamp(left.createdAt, nowTimestamp)
        - timestamp(right.createdAt, nowTimestamp);
      return createdDifference || left.id.localeCompare(right.id);
    });
  }

  score(task: Task, now: Date | number = Date.now()): number {
    const nowTimestamp = now instanceof Date ? now.getTime() : now;
    const ageMs = Math.max(0, nowTimestamp - timestamp(task.createdAt, nowTimestamp));
    const agingBoost = Math.floor(ageMs / this.agingIntervalMs);
    return PRIORITY_LEVEL[task.priority] + agingBoost;
  }
}

function timestamp(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
