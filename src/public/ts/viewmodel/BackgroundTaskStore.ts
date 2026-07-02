import { EventEmitter } from '../EventEmitter.js';

export interface TaskEntry {
  id: string;
  taskType: string;
  parentSessionId: string;
  parentAgentId: string;
  summary: string;
  status: string;
  startedAt: number;
  turnCount?: number;
  currentTool?: string;
  durationMs?: number;
  error?: string;
  pid?: number;
  command?: string;
}

export class BackgroundTaskStore extends EventEmitter {
  private static _instance: BackgroundTaskStore | null = null;

  static getInstance(): BackgroundTaskStore {
    if (!BackgroundTaskStore._instance) {
      BackgroundTaskStore._instance = new BackgroundTaskStore();
    }
    return BackgroundTaskStore._instance;
  }

  static resetInstance(): void {
    BackgroundTaskStore._instance = null;
  }

  private _tasks: Map<string, TaskEntry> = new Map();

  private constructor() {
    super();
  }

  upsert(raw: Record<string, unknown>): void {
    const entry = raw as unknown as TaskEntry;
    this._tasks.set(entry.id, entry);
    this.emit('changed');
  }

  getAll(): TaskEntry[] {
    return [...this._tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  getRunning(): TaskEntry[] {
    return this.getAll().filter(t => t.status === 'running');
  }

  getByParent(parentSessionId: string): TaskEntry[] {
    return this.getAll().filter(t => t.parentSessionId === parentSessionId);
  }

  getByStatus(status: string): TaskEntry[] {
    return this.getAll().filter(t => t.status === status);
  }
}
