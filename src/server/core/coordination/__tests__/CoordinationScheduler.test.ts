import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRole, AgentState } from '../../../../shared/types/agent.js';
import { Agent } from '../../agent/Agent.js';
import { defaultConfig } from '../../agent/AgentConfig.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { SessionManager } from '../../session/SessionManager.js';
import { SessionStore } from '../../session/SessionStore.js';
import { CoordinationScheduler } from '../CoordinationScheduler.js';
import { CoordinationService } from '../CoordinationService.js';
import { WorkspaceLeaseService } from '../WorkspaceLeaseService.js';

describe('CoordinationScheduler', () => {
  let dir = '';
  let rootSessionId = '';

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-scheduler-'));
    CoordinationScheduler.resetInstance();
    CoordinationService.resetInstance();
    WorkspaceLeaseService.resetInstance();
    SessionManager.resetInstance();
    SessionStore.resetInstance();
    AgentRegistry.resetInstance();

    const registry = AgentRegistry.getInstance();
    registry.registerAgent(makeAgent('ceo', AgentRole.MainAgent, null, 0));
    registry.registerAgent(makeAgent('manager-1', AgentRole.Manager, 'ceo', 1));
    for (let index = 1; index <= 7; index++) {
      registry.registerAgent(makeAgent(`worker-${index}`, AgentRole.Member, 'manager-1', 2));
    }
    const sessions = SessionManager.getInstance();
    await sessions.initialize(path.join(dir, 'sessions'));
    const root = await sessions.createMainSession('ceo', 'Scheduler load', dir);
    rootSessionId = root.id;
    await CoordinationService.getInstance().initialize(path.join(dir, 'coordination'));
  });

  afterEach(async () => {
    CoordinationScheduler.resetInstance();
    CoordinationService.resetInstance();
    WorkspaceLeaseService.resetInstance();
    SessionManager.resetInstance();
    SessionStore.resetInstance();
    AgentRegistry.resetInstance();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('completes 100 ready tasks without loss, duplicate execution, or exceeding root concurrency', async () => {
    const service = CoordinationService.getInstance();
    const team = await service.createTeam({
      rootSessionId,
      name: 'Eight agent team',
      purpose: 'Exercise bounded parallel scheduling',
      leaderAgentId: 'ceo',
      memberAgentIds: Array.from({ length: 7 }, (_, index) => `worker-${index + 1}`),
      createdByAgentId: 'ceo',
      autoDisband: false,
    });
    for (let index = 0; index < 100; index++) {
      await service.createTask({
        rootSessionId,
        teamId: team.id,
        mode: 'swarm',
        subject: `Task ${index + 1}`,
        description: `Read-only load task ${index + 1}`,
        acceptanceCriteria: ['Runner started'],
        creatorAgentId: 'ceo',
        readOnly: true,
      });
    }

    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    const scheduler = CoordinationScheduler.getInstance();
    scheduler.start(async (task) => {
      started.push(task.id);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const running = await service.updateTask(rootSessionId, task.id, {
        status: 'running',
      }, task.assigneeAgentId!, task.version);
      await new Promise((resolve) => setTimeout(resolve, 1));
      await service.updateTask(rootSessionId, task.id, {
        status: 'completed',
        progress: 100,
      }, task.assigneeAgentId!, running.version);
      active -= 1;
    });

    await vi.waitFor(
      () => expect(service.listTasks(rootSessionId).filter((task) => task.status === 'completed')).toHaveLength(100),
      { timeout: 10_000 },
    );
    expect(started).toHaveLength(100);
    expect(new Set(started).size).toBe(100);
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(service.listTasks(rootSessionId).filter(
      (task) => task.status === 'claimed' || task.status === 'running',
    )).toHaveLength(0);

    scheduler.stop();
  });

  it('never runs two preassigned tasks for the same member at once', async () => {
    const service = CoordinationService.getInstance();
    const team = await service.createTeam({
      rootSessionId,
      name: 'Single worker queue',
      purpose: 'Serialize a stable team session',
      leaderAgentId: 'ceo',
      memberAgentIds: ['worker-1'],
      createdByAgentId: 'ceo',
      autoDisband: false,
    });
    for (let index = 0; index < 3; index++) {
      await service.createTask({
        rootSessionId,
        teamId: team.id,
        mode: 'swarm',
        subject: `Assigned task ${index + 1}`,
        description: `Preassigned task ${index + 1}`,
        acceptanceCriteria: ['Completed once'],
        creatorAgentId: 'ceo',
        assigneeAgentId: 'worker-1',
        readOnly: true,
      });
    }

    let activeForWorker = 0;
    let maxActiveForWorker = 0;
    const scheduler = CoordinationScheduler.getInstance();
    scheduler.start(async (task) => {
      activeForWorker += 1;
      maxActiveForWorker = Math.max(maxActiveForWorker, activeForWorker);
      const running = await service.updateTask(rootSessionId, task.id, {
        status: 'running',
      }, task.assigneeAgentId!, task.version);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await service.updateTask(rootSessionId, task.id, {
        status: 'completed',
      }, task.assigneeAgentId!, running.version);
      activeForWorker -= 1;
    });

    await vi.waitFor(
      () => expect(service.listTasks(rootSessionId).filter((task) => task.status === 'completed')).toHaveLength(3),
      { timeout: 5_000 },
    );
    expect(maxActiveForWorker).toBe(1);
    scheduler.stop();
  });

});

function makeAgent(id: string, role: AgentRole, parentAgentId: string | null, level: number): Agent {
  return new Agent(defaultConfig({
    id,
    name: id,
    role,
    parentAgentId,
    level,
    teamName: role === AgentRole.MainAgent ? 'Executive' : 'Workers',
    provider: 'openai-compatible',
    apiUrl: 'https://example.test',
    apiKey: 'test',
    model: 'test',
    allowedTools: [],
    enabledSkills: [],
    mcpServers: [],
    state: AgentState.Active,
  }));
}
