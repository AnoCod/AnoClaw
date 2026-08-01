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
import { TaskTool } from '../../tools/builtin/TaskTool.js';
import { TaskAssignTool } from '../../tools/operations/TaskAssignTool.js';
import { TaskCreateTool } from '../../tools/operations/TaskCreateTool.js';
import { CoordinationScheduler } from '../CoordinationScheduler.js';
import {
  CHILD_TASKS_READY_BLOCKER,
  CoordinationService,
  WAITING_FOR_CHILD_TASKS_BLOCKER,
} from '../CoordinationService.js';
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
  }, 20_000);

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

  it('reserves a waiting parent assignee and runs its ready continuation before ordinary work', async () => {
    const service = CoordinationService.getInstance();
    const sessions = SessionManager.getInstance();
    const parent = await service.createTask({
      rootSessionId,
      mode: 'hierarchy',
      subject: 'Waiting manager parent',
      description: 'Wait for the direct child and then synthesize its result.',
      acceptanceCriteria: ['Child result is integrated'],
      creatorAgentId: 'ceo',
      assigneeAgentId: 'manager-1',
      readOnly: true,
    });
    const claimedParent = await service.claimTask(
      rootSessionId,
      parent.id,
      'manager-1',
      parent.version,
    );
    const managerSession = await sessions.createSubSession(
      rootSessionId,
      'manager-1',
      'Waiting manager parent',
      { metadata: { coordinationTaskId: parent.id } },
    );
    const runningParent = await service.updateTask(rootSessionId, parent.id, {
      status: 'running',
      sessionId: managerSession.id,
    }, 'manager-1', claimedParent.version);
    const child = await service.createTask({
      rootSessionId,
      sourceSessionId: managerSession.id,
      mode: 'subagent',
      subject: 'Direct child',
      description: 'Produce the result required by the waiting parent.',
      acceptanceCriteria: ['Result is returned'],
      creatorAgentId: 'manager-1',
      assigneeAgentId: 'worker-1',
      readOnly: true,
    });
    await service.updateTask(rootSessionId, parent.id, {
      status: 'blocked',
      blocker: WAITING_FOR_CHILD_TASKS_BLOCKER,
    }, 'manager-1', runningParent.version);
    const ordinary = await service.createTask({
      rootSessionId,
      mode: 'hierarchy',
      subject: 'Ordinary manager work',
      description: 'Must not overtake the waiting parent continuation.',
      acceptanceCriteria: ['Runs after the continuation'],
      creatorAgentId: 'ceo',
      assigneeAgentId: 'manager-1',
      priority: 'urgent',
      readOnly: true,
    });

    const started: Array<{ id: string; blocker?: string }> = [];
    const scheduler = CoordinationScheduler.getInstance();
    scheduler.start(async (task) => {
      started.push({ id: task.id, blocker: task.blocker });
      const running = await service.updateTask(rootSessionId, task.id, {
        status: 'running',
      }, task.assigneeAgentId!, task.version);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await service.updateTask(rootSessionId, task.id, {
        status: 'completed',
        progress: 100,
        resultSummary: task.id === parent.id ? 'Integrated child result' : 'Ordinary result',
      }, task.assigneeAgentId!, running.version);
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(started).toEqual([]);
    expect(service.getTask(rootSessionId, ordinary.id)?.status).toBe('pending');

    const currentChild = service.getTask(rootSessionId, child.id)!;
    const claimedChild = await service.claimTask(
      rootSessionId,
      child.id,
      'worker-1',
      currentChild.version,
    );
    const runningChild = await service.updateTask(rootSessionId, child.id, {
      status: 'running',
      sessionId: 'direct-child-session',
    }, 'worker-1', claimedChild.version);
    const completedChild = await service.updateTask(rootSessionId, child.id, {
      status: 'completed',
      progress: 100,
      resultSummary: 'Direct child result',
    }, 'worker-1', runningChild.version);
    const resultMessage = await service.queueMessage({
      rootSessionId,
      taskId: child.id,
      fromAgentId: 'worker-1',
      toAgentId: 'manager-1',
      kind: 'task_result',
      summary: `${child.subject}: completed`,
      content: completedChild.resultSummary!,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual([]);
    expect(service.getTask(rootSessionId, parent.id)).toMatchObject({
      status: 'blocked',
      blocker: WAITING_FOR_CHILD_TASKS_BLOCKER,
    });

    await service.updateMessageStatus(rootSessionId, resultMessage.id, 'delivered', 'manager-1');
    await vi.waitFor(
      () => expect(service.getTask(rootSessionId, ordinary.id)?.status).toBe('completed'),
      { timeout: 5_000 },
    );

    expect(started.map((entry) => entry.id)).toEqual([parent.id, ordinary.id]);
    expect(started[0].blocker).toBe(CHILD_TASKS_READY_BLOCKER);
    scheduler.stop();
  });

  it('runs six default read-only manager conversations without workspace conflicts', async () => {
    const registry = AgentRegistry.getInstance();
    for (let index = 2; index <= 6; index++) {
      registry.registerAgent(makeAgent(`manager-${index}`, AgentRole.Manager, 'ceo', 1));
    }

    const service = CoordinationService.getInstance();
    const context = {
      sessionId: rootSessionId,
      agentId: 'ceo',
      workspace: dir,
      userConfirmed: true,
      callerRole: AgentRole.MainAgent,
    };
    const taskTool = new TaskTool();
    for (let index = 1; index <= 6; index++) {
      const result = await taskTool.execute({
        action: 'create',
        subject: `Manager ${index} status conversation`,
        description: 'Reply with current work, progress, blockers, and support needed.',
        acceptanceCriteria: ['A concise status response is returned'],
        targetAgentId: `manager-${index}`,
      }, context);
      expect(result.success).toBe(true);
    }

    let active = 0;
    let maxActive = 0;
    const scheduler = CoordinationScheduler.getInstance();
    scheduler.start(async (task) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        const running = await service.updateTask(rootSessionId, task.id, {
          status: 'running',
        }, task.assigneeAgentId!, task.version);
        await new Promise((resolve) => setTimeout(resolve, 10));
        await service.updateTask(rootSessionId, task.id, {
          status: 'completed',
          progress: 100,
          resultSummary: `Status returned by ${task.assigneeAgentId}`,
        }, task.assigneeAgentId!, running.version);
      } finally {
        active -= 1;
      }
    });

    await vi.waitFor(
      () => expect(service.listTasks(rootSessionId).filter((task) => task.status === 'completed')).toHaveLength(6),
      { timeout: 5_000 },
    );

    const tasks = service.listTasks(rootSessionId);
    expect(tasks).toHaveLength(6);
    expect(tasks.every((task) => task.readOnly && task.writeScope.length === 0)).toBe(true);
    expect(tasks.some((task) => task.blocker === 'workspace_conflict')).toBe(false);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(4);
    scheduler.stop();
  });

  it('executes a durable MainAgent -> Manager -> Member chain and returns results upward', async () => {
    const service = CoordinationService.getInstance();
    const sessions = SessionManager.getInstance();
    const ceoContext = {
      sessionId: rootSessionId,
      agentId: 'ceo',
      workspace: dir,
      userConfirmed: true,
      callerRole: AgentRole.MainAgent,
    };
    const rootCreated = await new TaskCreateTool().execute({
      subject: 'Coordinate implementation',
      description: 'Delegate one focused implementation task through the manager.',
      acceptanceCriteria: ['Member result is returned through the manager'],
      readOnly: true,
    }, ceoContext);
    expect(rootCreated.success).toBe(true);
    const rootTaskId = (rootCreated.structured as { task: { id: string } }).task.id;
    const rootAssigned = await new TaskAssignTool().execute({
      taskId: rootTaskId,
      targetAgentId: 'manager-1',
    }, ceoContext);
    expect(rootAssigned.success).toBe(true);

    let childTaskId = '';
    let managerSessionId = '';
    let resolveMemberDone!: () => void;
    const memberDone = new Promise<void>((resolve) => { resolveMemberDone = resolve; });
    const scheduler = CoordinationScheduler.getInstance();
    scheduler.start(async (task) => {
      const running = await service.updateTask(rootSessionId, task.id, {
        status: 'running',
      }, task.assigneeAgentId!, task.version);

      if (task.assigneeAgentId === 'manager-1') {
        const managerSession = await sessions.createSubSession(
          rootSessionId,
          'manager-1',
          'Coordinate implementation',
        );
        managerSessionId = managerSession.id;
        const managerContext = {
          sessionId: managerSession.id,
          agentId: 'manager-1',
          workspace: dir,
          userConfirmed: true,
          callerRole: AgentRole.Manager,
        };
        const childCreated = await new TaskCreateTool().execute({
          subject: 'Implement focused change',
          description: 'Produce the member-level implementation evidence.',
          acceptanceCriteria: ['Focused implementation evidence is available'],
          readOnly: true,
        }, managerContext);
        if (!childCreated.success) throw new Error(childCreated.errorMessage);
        childTaskId = (childCreated.structured as { task: { id: string } }).task.id;
        const childAssigned = await new TaskAssignTool().execute({
          taskId: childTaskId,
          targetAgentId: 'worker-1',
        }, managerContext);
        if (!childAssigned.success) throw new Error(childAssigned.errorMessage);

        await memberDone;
        const child = service.getTask(rootSessionId, childTaskId);
        if (child?.status !== 'completed') throw new Error('Member task did not complete');
        const latestManager = service.getTask(rootSessionId, task.id)!;
        await service.updateTask(rootSessionId, task.id, {
          status: 'completed',
          progress: 100,
          resultSummary: `Manager verified member result from ${child.id}`,
        }, 'manager-1', latestManager.version);
        await service.queueMessage({
          rootSessionId,
          taskId: task.id,
          fromAgentId: 'manager-1',
          toAgentId: 'ceo',
          kind: 'task_result',
          content: 'Manager verified and returned the member result.',
        });
        return;
      }

      await service.updateTask(rootSessionId, task.id, {
        status: 'completed',
        progress: 100,
        resultSummary: 'Member implementation evidence',
      }, task.assigneeAgentId!, running.version);
      await service.queueMessage({
        rootSessionId,
        taskId: task.id,
        fromAgentId: task.assigneeAgentId!,
        toAgentId: 'manager-1',
        kind: 'task_result',
        content: 'Member implementation evidence',
      });
      resolveMemberDone();
    });

    await vi.waitFor(
      () => expect(service.getTask(rootSessionId, rootTaskId)?.status).toBe('completed'),
      { timeout: 5_000 },
    );

    const child = service.getTask(rootSessionId, childTaskId);
    expect(child).toMatchObject({
      sourceSessionId: managerSessionId,
      creatorAgentId: 'manager-1',
      assigneeAgentId: 'worker-1',
      status: 'completed',
    });
    expect(service.listMessages(rootSessionId).filter((message) => message.kind === 'task_result'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ fromAgentId: 'worker-1', toAgentId: 'manager-1', taskId: childTaskId }),
        expect.objectContaining({ fromAgentId: 'manager-1', toAgentId: 'ceo', taskId: rootTaskId }),
      ]));
    expect(sessions.session(managerSessionId)?.parentSessionId).toBe(rootSessionId);
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
