import type { CoordinationTask } from '../../../shared/types/coordination.js';
import { AgentRegistry } from '../agent/AgentRegistry.js';
import { TypedEventBus } from '../events/TypedEventBus.js';
import { SessionManager } from '../session/SessionManager.js';
import { SettingsManager } from '../../infra/storage/SettingsManager.js';
import { createLogger } from '../logger.js';
import { CoordinationService } from './CoordinationService.js';
import { WorkspaceLeaseService } from './WorkspaceLeaseService.js';

type TaskRunner = (task: CoordinationTask) => Promise<void>;

const PRIORITY_WEIGHT: Record<CoordinationTask['priority'], number> = {
  urgent: 400,
  high: 300,
  normal: 200,
  low: 100,
};

export class CoordinationScheduler {
  private static instance: CoordinationScheduler | null = null;

  static getInstance(): CoordinationScheduler {
    if (!this.instance) this.instance = new CoordinationScheduler();
    return this.instance;
  }

  static resetInstance(): void {
    this.instance?.stop();
    this.instance = null;
  }

  private runner: TaskRunner | null = null;
  private readonly running = new Map<string, Promise<void>>();
  private readonly scheduledRoots = new Set<string>();
  private readonly dirtyRoots = new Set<string>();
  private readonly autoDisbandTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribers: Array<() => void> = [];
  private started = false;

  private constructor() {}

  start(runner: TaskRunner): void {
    this.runner = runner;
    if (this.started) return;
    this.started = true;
    this.unsubscribers.push(
      TypedEventBus.on('coordination:task_changed', ({ rootSessionId, task }) => {
        this.kick(rootSessionId);
        if (task.status === 'blocked') void this.notifyBlockedTask(task);
      }),
      TypedEventBus.on('coordination:team_changed', ({ rootSessionId }) => this.kick(rootSessionId)),
      TypedEventBus.on('coordination:message', ({ rootSessionId }) => this.kick(rootSessionId)),
      TypedEventBus.on('agent:changed', () => this.kickAllRoots()),
      TypedEventBus.on('agent:registered', () => this.kickAllRoots()),
      TypedEventBus.on('agent:unregistered', () => this.kickAllRoots()),
    );
    void this.recover();
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    for (const timer of this.autoDisbandTimers.values()) clearTimeout(timer);
    this.autoDisbandTimers.clear();
    this.scheduledRoots.clear();
    this.dirtyRoots.clear();
    this.runner = null;
    this.started = false;
  }

  kick(rootSessionId: string): void {
    if (!this.runner) return;
    if (this.scheduledRoots.has(rootSessionId)) {
      this.dirtyRoots.add(rootSessionId);
      return;
    }
    this.scheduledRoots.add(rootSessionId);
    queueMicrotask(() => {
      void this.drainRoot(rootSessionId);
    });
  }

  private async drainRoot(rootSessionId: string): Promise<void> {
    try {
      do {
        this.dirtyRoots.delete(rootSessionId);
        if (!this.runner) break;
        await this.schedule(rootSessionId);
      } while (this.dirtyRoots.has(rootSessionId));
    } catch (error) {
      createLogger('anochat.agent').warn('Coordination scheduling failed', {
        rootSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.scheduledRoots.delete(rootSessionId);
      if (this.runner && this.dirtyRoots.delete(rootSessionId)) this.kick(rootSessionId);
    }
  }

  private async recover(): Promise<void> {
    const service = CoordinationService.getInstance();
    for (const root of SessionManager.getInstance().mainSessions()) {
      const tasks = service.listTasks(root.id);
      for (const task of tasks) {
        if (task.status === 'claimed') {
          await service.releaseTaskLeases(root.id, task.id, task.assigneeAgentId || task.creatorAgentId);
          await service.updateTask(root.id, task.id, {
            status: 'pending',
            blocker: undefined,
          }, task.assigneeAgentId || task.creatorAgentId);
        } else if (task.status === 'running') {
          await service.releaseTaskLeases(root.id, task.id, task.assigneeAgentId || task.creatorAgentId);
          await service.updateTask(root.id, task.id, {
            status: 'blocked',
            blocker: 'recovery_required: previous process ended during execution',
            error: 'Execution state requires review before retry.',
          }, task.assigneeAgentId || task.creatorAgentId);
        } else if (['completed', 'failed', 'cancelled'].includes(task.status)) {
          await service.releaseTaskLeases(root.id, task.id, task.assigneeAgentId || task.creatorAgentId)
            .catch(() => {});
        }
      }
      this.kick(root.id);
    }
  }

  private async schedule(rootSessionId: string): Promise<void> {
    if (!this.runner) return;
    const service = CoordinationService.getInstance();
    await this.ensureLeaderAvailable(rootSessionId);
    await this.unblockWorkspaceTasks(rootSessionId);

    const maxConcurrent = SettingsManager.getInstance().get<number>(
      'coordination.maxConcurrentTasksPerRoot',
      4,
    );
    const activeForRoot = service.listTasks(rootSessionId).filter(
      (task) => task.status === 'claimed' || task.status === 'running',
    ).length;
    let capacity = Math.max(0, maxConcurrent - activeForRoot);
    if (capacity === 0) return;

    const tasks = service.listTasks(rootSessionId)
      .filter((task) => task.mode !== 'subagent' && service.isTaskReady(rootSessionId, task.id))
      .sort(compareTasks);
    const busyAgents = new Set(
      service.listTasks(rootSessionId)
        .filter((task) => task.status === 'claimed' || task.status === 'running')
        .map((task) => task.assigneeAgentId)
        .filter((value): value is string => !!value),
    );

    for (const original of tasks) {
      if (capacity <= 0) break;
      let task = original;
      if (task.assigneeAgentId && busyAgents.has(task.assigneeAgentId)) continue;
      const assignee = task.assigneeAgentId || this.selectAssignee(task, busyAgents);
      if (!assignee) continue;

      if (!task.assigneeAgentId) {
        task = await service.assignTask(rootSessionId, task.id, assignee, task.creatorAgentId, task.version);
      }

      const root = SessionManager.getInstance().session(rootSessionId);
      if (!root) continue;
      if (!task.readOnly) {
        const lease = await service.acquireTaskLease(
          rootSessionId,
          task.id,
          root.workspace,
          SettingsManager.getInstance().get<number>('coordination.workspaceLeaseTtlMs', 30_000),
        );
        if (!lease) {
          await service.updateTask(rootSessionId, task.id, {
            status: 'blocked',
            blocker: 'workspace_conflict',
          }, assignee, task.version);
          continue;
        }
      }

      try {
        task = await service.claimTask(rootSessionId, task.id, assignee, task.version);
      } catch (error) {
        await service.releaseTaskLeases(rootSessionId, task.id, assignee).catch(() => {});
        continue;
      }

      capacity -= 1;
      busyAgents.add(assignee);
      const run = this.runner(task)
        .catch(async (error) => {
          const current = service.getTask(rootSessionId, task.id);
          if (current?.status === 'claimed') {
            await service.updateTask(rootSessionId, task.id, {
              status: 'blocked',
              blocker: 'runner_initialization_failed',
              error: error instanceof Error ? error.message : String(error),
            }, assignee).catch(() => {});
          } else if (current?.status === 'running') {
            await service.updateTask(rootSessionId, task.id, {
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            }, assignee).catch(() => {});
          }
        })
        .finally(() => {
          this.running.delete(task.id);
          this.kick(rootSessionId);
          this.scheduleAutoDisband(rootSessionId);
        });
      this.running.set(task.id, run);
    }

    this.scheduleAutoDisband(rootSessionId);
  }

  private async ensureLeaderAvailable(rootSessionId: string): Promise<void> {
    const service = CoordinationService.getInstance();
    const team = service.getActiveTeam(rootSessionId);
    if (!team) return;
    const registry = AgentRegistry.getInstance();
    if (registry.findAgent(team.leaderAgentId)?.isActive) return;
    const root = SessionManager.getInstance().session(rootSessionId);
    if (!root || !registry.findAgent(root.agentId)?.isActive) return;
    await service.updateTeam(
      rootSessionId,
      team.id,
      {
        leaderAgentId: root.agentId,
        removeMemberAgentIds: [team.leaderAgentId],
      },
      root.agentId,
    );
  }

  private kickAllRoots(): void {
    for (const root of SessionManager.getInstance().mainSessions()) this.kick(root.id);
  }

  private async notifyBlockedTask(task: CoordinationTask): Promise<void> {
    const service = CoordinationService.getInstance();
    const team = task.teamId ? service.getTeam(task.rootSessionId, task.teamId) : undefined;
    const recipient = team?.leaderAgentId || task.creatorAgentId;
    await service.queueMessage({
      rootSessionId: task.rootSessionId,
      teamId: task.teamId,
      taskId: task.id,
      fromAgentId: task.assigneeAgentId || task.creatorAgentId,
      toAgentId: recipient,
      kind: 'task_update',
      summary: `${task.subject}: blocked`,
      content: [
        `Task ${task.id} is blocked.`,
        `Blocker: ${task.blocker || 'unspecified'}`,
        task.error ? `Error: ${task.error}` : '',
        task.sessionId ? `Session: ${task.sessionId}` : '',
      ].filter(Boolean).join('\n'),
      idempotencyKey: `task-blocked:${task.id}:${task.version}`,
    }).catch(() => {});
  }

  private selectAssignee(task: CoordinationTask, busyAgents: Set<string>): string | undefined {
    const registry = AgentRegistry.getInstance();
    if (task.mode === 'hierarchy') return task.assigneeAgentId;
    if (!task.teamId) return task.assigneeAgentId;
    const team = CoordinationService.getInstance().getTeam(task.rootSessionId, task.teamId);
    if (!team || team.state !== 'active') return undefined;
    const candidates = team.memberAgentIds
      .filter((agentId) => agentId !== team.leaderAgentId)
      .filter((agentId) => !busyAgents.has(agentId))
      .filter((agentId) => registry.findAgent(agentId)?.isActive);
    if (candidates.length > 0) return candidates[0];
    if (!busyAgents.has(team.leaderAgentId) && registry.findAgent(team.leaderAgentId)?.isActive) {
      return team.leaderAgentId;
    }
    return undefined;
  }

  private async unblockWorkspaceTasks(rootSessionId: string): Promise<void> {
    const service = CoordinationService.getInstance();
    const root = SessionManager.getInstance().session(rootSessionId);
    if (!root) return;
    for (const task of service.listTasks(rootSessionId)) {
      if (task.status !== 'blocked' || task.blocker !== 'workspace_conflict' || !task.assigneeAgentId) continue;
      const conflict = WorkspaceLeaseService.getInstance().findConflict(
        rootSessionId,
        task.id,
        root.workspace,
        task.writeScope,
      );
      if (!conflict) {
        await service.updateTask(rootSessionId, task.id, {
          status: 'pending',
          blocker: undefined,
        }, task.assigneeAgentId, task.version);
      }
    }
  }

  private scheduleAutoDisband(rootSessionId: string): void {
    const service = CoordinationService.getInstance();
    const team = service.getActiveTeam(rootSessionId);
    if (!team?.autoDisband) return;
    const hasWork = service.listTasks(rootSessionId).some(
      (task) => task.teamId === team.id && !['completed', 'failed', 'cancelled'].includes(task.status),
    );
    const hasMessages = service.listMessages(rootSessionId).some(
      (message) => message.teamId === team.id
        && message.status !== 'acknowledged'
        && message.status !== 'dead_letter',
    );
    if (hasWork || hasMessages) {
      const existing = this.autoDisbandTimers.get(rootSessionId);
      if (existing) clearTimeout(existing);
      this.autoDisbandTimers.delete(rootSessionId);
      return;
    }
    if (this.autoDisbandTimers.has(rootSessionId)) return;
    const graceMs = SettingsManager.getInstance().get<number>(
      'coordination.autoDisbandGraceMs',
      30_000,
    );
    const timer = setTimeout(() => {
      this.autoDisbandTimers.delete(rootSessionId);
      const current = service.getActiveTeam(rootSessionId);
      if (!current || current.id !== team.id) return;
      const stillHasWork = service.listTasks(rootSessionId).some(
        (task) => task.teamId === current.id
          && !['completed', 'failed', 'cancelled'].includes(task.status),
      );
      const stillHasMessages = service.listMessages(rootSessionId).some(
        (message) => message.teamId === current.id
          && message.status !== 'acknowledged'
          && message.status !== 'dead_letter',
      );
      if (stillHasWork || stillHasMessages) {
        this.scheduleAutoDisband(rootSessionId);
        return;
      }
      void service.disbandTeam(rootSessionId, team.id, team.leaderAgentId).catch(() => {});
    }, graceMs);
    this.autoDisbandTimers.set(rootSessionId, timer);
  }
}

function compareTasks(a: CoordinationTask, b: CoordinationTask): number {
  const hour = 60 * 60_000;
  const ageA = Math.floor((Date.now() - Date.parse(a.createdAt)) / hour);
  const ageB = Math.floor((Date.now() - Date.parse(b.createdAt)) / hour);
  const scoreA = PRIORITY_WEIGHT[a.priority] + Math.min(99, ageA);
  const scoreB = PRIORITY_WEIGHT[b.priority] + Math.min(99, ageB);
  return scoreB - scoreA || Date.parse(a.createdAt) - Date.parse(b.createdAt);
}
