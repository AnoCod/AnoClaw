/**
 * SupervisionManager — heartbeat tracking and timeout detection for sub-agents.
 *
 * Moved from infra/supervision/ to core/agent/supervision/ — this is
 * agent lifecycle logic, not infrastructure.
 *
 * @module SupervisionManager
 */

import { EventEmitter } from 'events';
import {
  HEARTBEAT_INTERVAL_SEC,
  TASK_TIMEOUT_SEC,
  UNRESPONSIVE_THRESHOLD_SEC,
} from '../../../../shared/constants.js';

export enum TaskStatus {
  Running = 'running',
  Blocked = 'blocked',
  Failed = 'failed',
  Completed = 'completed',
}

export interface TaskProgress {
  taskId: string;
  agentId: string;
  status: TaskStatus;
  attemptCount: number;
  summary: string;
  errorDetail: string;
  logSnippet: string;
  needsAttention: boolean;
  lastUpdate: Date;
}

export interface SupervisionConfig {
  heartbeatIntervalSec: number;
  taskTimeoutSec: number;
  unresponsiveThresholdSec: number;
  maxRetries: number;
}

const DEFAULT_CONFIG: SupervisionConfig = {
  heartbeatIntervalSec: HEARTBEAT_INTERVAL_SEC,
  taskTimeoutSec: TASK_TIMEOUT_SEC,
  unresponsiveThresholdSec: UNRESPONSIVE_THRESHOLD_SEC,
  maxRetries: 3,
};

export class SupervisionManager extends EventEmitter {
  private static _instance: SupervisionManager | null = null;

  static getInstance(): SupervisionManager {
    if (!SupervisionManager._instance) {
      SupervisionManager._instance = new SupervisionManager();
    }
    return SupervisionManager._instance;
  }

  private _progress: Map<string, TaskProgress> = new Map();
  private _heartbeats: Map<string, Date> = new Map();
  private _currentTools: Map<string, string> = new Map();
  private _config: SupervisionConfig = { ...DEFAULT_CONFIG };
  private _lastReportedStatus: Map<string, TaskStatus> = new Map();
  private _lastReportedNeedsAttention: Map<string, boolean> = new Map();

  private constructor() {
    super();
  }

  taskProgress(sessionId: string): TaskProgress | undefined {
    return this._progress.get(sessionId);
  }

  updateProgress(sessionId: string, p: TaskProgress): void {
    const prev = this._progress.get(sessionId);
    this._progress.set(sessionId, { ...p, lastUpdate: new Date(p.lastUpdate) });
    const prevStatus = this._lastReportedStatus.get(sessionId);
    const prevAttention = this._lastReportedNeedsAttention.get(sessionId);
    const statusChanged = prevStatus !== p.status;
    const attentionChanged = prevAttention !== p.needsAttention;
    const isOverdue = this._isHeartbeatOverdue(sessionId);
    if (statusChanged || attentionChanged || isOverdue) {
      this._lastReportedStatus.set(sessionId, p.status);
      this._lastReportedNeedsAttention.set(sessionId, p.needsAttention);
    }
  }

  heartbeat(sessionId: string): void {
    this._heartbeats.set(sessionId, new Date());
  }

  lastHeartbeat(sessionId: string): Date | null {
    return this._heartbeats.get(sessionId) || null;
  }

  isUnresponsive(sessionId: string): boolean {
    return this._isHeartbeatOverdue(sessionId);
  }

  isTimedOut(sessionId: string): boolean {
    const progress = this._progress.get(sessionId);
    if (!progress) return false;
    const now = Date.now();
    const elapsed = now - progress.lastUpdate.getTime();
    return elapsed > this._config.taskTimeoutSec * 1000;
  }

  secondsSinceLastHeartbeat(sessionId: string): number {
    const hb = this._heartbeats.get(sessionId);
    if (!hb) return Infinity;
    return (Date.now() - hb.getTime()) / 1000;
  }

  setConfig(config: Partial<SupervisionConfig>): void {
    this._config = { ...this._config, ...config };
  }

  getConfig(): SupervisionConfig {
    return { ...this._config };
  }

  setCurrentTool(sessionId: string, tool: string | undefined): void {
    if (tool) this._currentTools.set(sessionId, tool);
    else this._currentTools.delete(sessionId);
  }

  getCurrentTool(sessionId: string): string | undefined {
    return this._currentTools.get(sessionId);
  }

  checkAllSessions(): void {
    const now = Date.now();
    const unresponsiveThresholdMs = this._config.unresponsiveThresholdSec * 1000;
    for (const [sessionId, hb] of this._heartbeats.entries()) {
      const elapsed = now - hb.getTime();
      if (elapsed > this._config.heartbeatIntervalSec * 1000 * 1.5) {
        this.emit('heartbeatMissed', sessionId);
      }
      if (elapsed > unresponsiveThresholdMs) {
        this.emit('sessionUnresponsive', sessionId);
      }
      if (this.isTimedOut(sessionId)) {
        this.emit('sessionTimedOut', sessionId);
      }
    }
  }

  removeSession(sessionId: string): void {
    this._progress.delete(sessionId);
    this._heartbeats.delete(sessionId);
    this._lastReportedStatus.delete(sessionId);
    this._lastReportedNeedsAttention.delete(sessionId);
  }

  get trackedSessionCount(): number {
    return this._heartbeats.size;
  }

  private _isHeartbeatOverdue(sessionId: string): boolean {
    const hb = this._heartbeats.get(sessionId);
    if (!hb) return false;
    const elapsed = (Date.now() - hb.getTime()) / 1000;
    return elapsed > this._config.unresponsiveThresholdSec;
  }
}
