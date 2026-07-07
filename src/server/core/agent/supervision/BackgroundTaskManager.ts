/**
 * BackgroundTaskManager — unified registry for all background tasks.
 *
 * Tracks sub-agent delegations, bash background commands, and async operations
 * in one place. Emits TypedEventBus events on every state change so the
 * frontend panel, desktop notifications, and agent <task-notification>
 * injection all share one source of truth.
 *
 * @module BackgroundTaskManager
 */

import { EventEmitter } from 'events';
import { EventSubscriptionManager } from '../../events/index.js';
import { TypedEventBus } from '../../events/index.js';
import { createLogger } from '../../logger.js';

const log = createLogger('anochat.system');

export type BackgroundTaskType = 'subagent' | 'bash' | 'command';
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'killed';

const RECENT_TASK_RESULT_TTL_MS = 10 * 60 * 1000;
const MAX_RECENT_TASK_RESULTS = 200;

export interface BackgroundTaskEntry {
  id: string;
  type: BackgroundTaskType;
  parentSessionId: string;
  parentAgentId: string;
  summary: string;
  startedAt: number;
  status: BackgroundTaskStatus;
  turnCount?: number;
  currentTool?: string;
  fullContent?: string;
  error?: string;
  durationMs?: number;
  pid?: number;
  command?: string;
}

export interface BackgroundTaskResultSnapshot {
  id: string;
  type: BackgroundTaskType;
  parentSessionId: string;
  parentAgentId: string;
  summary: string;
  startedAt: number;
  finishedAt: number;
  status: Exclude<BackgroundTaskStatus, 'running'>;
  content?: string;
  error?: string;
  durationMs?: number;
  turnCount?: number;
  pid?: number;
  command?: string;
}

export interface TaskCompletedInSessionPayload {
  parentSessionId: string;
  taskId: string;
  status: 'completed' | 'failed';
}

export class BackgroundTaskManager extends EventEmitter {
  private static _instance: BackgroundTaskManager | null = null;

  static getInstance(): BackgroundTaskManager {
    if (!BackgroundTaskManager._instance) {
      BackgroundTaskManager._instance = new BackgroundTaskManager();
    }
    return BackgroundTaskManager._instance;
  }

  static resetInstance(): void {
    BackgroundTaskManager._instance = null;
  }

  private _tasks: Map<string, BackgroundTaskEntry> = new Map();
  private _recentResults: Map<string, BackgroundTaskResultSnapshot> = new Map();

  private constructor() {
    super();
  }

  /** Register a new background task. Returns the assigned task ID. */
  register(entry: Omit<BackgroundTaskEntry, 'id' | 'status' | 'startedAt'>): string {
    const id = `bt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const task: BackgroundTaskEntry = {
      ...entry,
      id,
      status: 'running',
      startedAt: Date.now(),
    };
    this._tasks.set(id, task);
    this._emitUpdate(task);
    log.info('Background task registered', { taskId: id, type: task.type, summary: task.summary });
    return id;
  }

  /** Update in-progress metadata. Throttled at call site (AgentRuntime). */
  updateProgress(taskId: string, data: Partial<Pick<BackgroundTaskEntry, 'turnCount' | 'currentTool'>>): void {
    const task = this._tasks.get(taskId);
    if (!task || task.status !== 'running') return;
    if (data.turnCount !== undefined) task.turnCount = data.turnCount;
    if (data.currentTool !== undefined) task.currentTool = data.currentTool;
    this._emitUpdate(task);
  }

  /** Mark a task as completed. Emits TypedEventBus + EventSubscriptionManager events. */
  async complete(taskId: string, result: { content: string; turnCount?: number; durationMs: number }): Promise<BackgroundTaskEntry> {
    const task = this._tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    task.status = 'completed';
    task.fullContent = result.content.slice(0, 2000);
    if (result.turnCount !== undefined) task.turnCount = result.turnCount;
    task.durationMs = result.durationMs;
    this._emitUpdate(task);
    this._rememberResult(task, 'completed');

    // Legacy path: EventSubscriptionManager for agent-to-agent pub/sub
    EventSubscriptionManager.getInstance().publish(`task:completed:${taskId}`, {
      subSessionId: taskId,
      parentSessionId: task.parentSessionId,
      subAgentId: task.parentAgentId,
      taskSummary: task.summary,
      turnCount: task.turnCount ?? 0,
      durationMs: task.durationMs,
      content: task.fullContent ?? '',
    }).catch(err => log.warn('Failed to publish task:completed event', { taskId, error: (err as Error).message }));

    // New path: TypedEventBus for WS forwarding + agent notification injection
    TypedEventBus.emit('task:completed', {
      taskId,
      parentSessionId: task.parentSessionId,
      parentAgentId: task.parentAgentId,
      type: task.type,
      summary: task.summary,
      turnCount: task.turnCount ?? 0,
      durationMs: task.durationMs,
      content: task.fullContent ?? '',
    });

    // Event-driven wakeup for AgentLoop wait loop
    this.emit('taskCompletedInSession', {
      parentSessionId: task.parentSessionId,
      taskId,
      status: 'completed',
    } satisfies TaskCompletedInSessionPayload);

    this._tasks.delete(taskId);
    return task;
  }

  /** Mark a task as failed. Emits TypedEventBus + EventSubscriptionManager events. */
  async fail(taskId: string, error: string, durationMs: number): Promise<BackgroundTaskEntry> {
    const task = this._tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    task.status = 'failed';
    task.error = error.slice(0, 500);
    task.durationMs = durationMs;
    this._emitUpdate(task);
    this._rememberResult(task, 'failed');

    EventSubscriptionManager.getInstance().publish(`task:failed:${taskId}`, {
      subSessionId: taskId,
      parentSessionId: task.parentSessionId,
      subAgentId: task.parentAgentId,
      taskSummary: task.summary,
      durationMs: task.durationMs,
      error: task.error,
    }).catch(err => log.warn('Failed to publish task:failed event', { taskId, error: (err as Error).message }));

    TypedEventBus.emit('task:failed', {
      taskId,
      parentSessionId: task.parentSessionId,
      parentAgentId: task.parentAgentId,
      type: task.type,
      summary: task.summary,
      durationMs: task.durationMs,
      error: task.error,
    });

    // Event-driven wakeup for AgentLoop wait loop
    this.emit('taskCompletedInSession', {
      parentSessionId: task.parentSessionId,
      taskId,
      status: 'failed',
    } satisfies TaskCompletedInSessionPayload);

    this._tasks.delete(taskId);
    return task;
  }

  /** Kill a running task (e.g. user stop). */
  kill(taskId: string): boolean {
    const task = this._tasks.get(taskId);
    if (!task || task.status !== 'running') return false;
    task.status = 'killed';
    task.durationMs = Date.now() - task.startedAt;
    task.error = 'Task killed';
    this._emitUpdate(task);
    this._rememberResult(task, 'killed');

    EventSubscriptionManager.getInstance().publish(`task:failed:${taskId}`, {
      subSessionId: taskId,
      parentSessionId: task.parentSessionId,
      subAgentId: task.parentAgentId,
      taskSummary: task.summary,
      durationMs: task.durationMs,
      error: task.error,
    }).catch(err => log.warn('Failed to publish task:killed event', { taskId, error: (err as Error).message }));

    TypedEventBus.emit('task:failed', {
      taskId,
      parentSessionId: task.parentSessionId,
      parentAgentId: task.parentAgentId,
      type: task.type,
      summary: task.summary,
      durationMs: task.durationMs,
      error: task.error,
    });

    this.emit('taskCompletedInSession', {
      parentSessionId: task.parentSessionId,
      taskId,
      status: 'failed',
    } satisfies TaskCompletedInSessionPayload);

    this._tasks.delete(taskId);
    return true;
  }

  // ── queries ──

  getTask(taskId: string): BackgroundTaskEntry | undefined {
    return this._tasks.get(taskId);
  }

  getActive(): BackgroundTaskEntry[] {
    return [...this._tasks.values()];
  }

  getTasksForParent(parentSessionId: string): BackgroundTaskEntry[] {
    const result: BackgroundTaskEntry[] = [];
    for (const entry of this._tasks.values()) {
      if (entry.parentSessionId === parentSessionId) result.push(entry);
    }
    return result;
  }

  hasTask(taskId: string): boolean {
    return this._tasks.has(taskId);
  }

  getRecentTaskResult(taskId: string): BackgroundTaskResultSnapshot | undefined {
    this._pruneRecentResults();
    return this._recentResults.get(taskId);
  }

  getRecentTaskResultsForParent(parentSessionId: string): BackgroundTaskResultSnapshot[] {
    this._pruneRecentResults();
    return [...this._recentResults.values()]
      .filter(task => task.parentSessionId === parentSessionId)
      .sort((a, b) => b.finishedAt - a.finishedAt);
  }

  get activeCount(): number {
    return this._tasks.size;
  }

  // ── internal ──

  private _emitUpdate(task: BackgroundTaskEntry): void {
    TypedEventBus.emit('task:registry_update', { task });
  }

  private _rememberResult(
    task: BackgroundTaskEntry,
    status: Exclude<BackgroundTaskStatus, 'running'>,
  ): void {
    this._recentResults.set(task.id, {
      id: task.id,
      type: task.type,
      parentSessionId: task.parentSessionId,
      parentAgentId: task.parentAgentId,
      summary: task.summary,
      startedAt: task.startedAt,
      finishedAt: Date.now(),
      status,
      content: task.fullContent,
      error: task.error,
      durationMs: task.durationMs,
      turnCount: task.turnCount,
      pid: task.pid,
      command: task.command,
    });
    this._pruneRecentResults();
  }

  private _pruneRecentResults(): void {
    const now = Date.now();
    for (const [id, snapshot] of this._recentResults) {
      if (now - snapshot.finishedAt > RECENT_TASK_RESULT_TTL_MS) {
        this._recentResults.delete(id);
      }
    }
    while (this._recentResults.size > MAX_RECENT_TASK_RESULTS) {
      const oldest = this._recentResults.keys().next().value as string | undefined;
      if (!oldest) break;
      this._recentResults.delete(oldest);
    }
  }
}
