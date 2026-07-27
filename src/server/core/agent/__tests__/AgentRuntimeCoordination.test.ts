import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRole, AgentState } from '../../../../shared/types/agent.js';
import { SSEEventType } from '../../../../shared/types/events.js';
import { MessageRole } from '../../../../shared/types/session.js';
import { Agent } from '../Agent.js';
import { defaultConfig } from '../AgentConfig.js';
import { AgentRegistry } from '../AgentRegistry.js';
import { AgentRuntime } from '../AgentRuntime.js';
import { InterruptController } from '../supervision/InterruptController.js';
import {
  CoordinationService,
  WAITING_FOR_CHILD_TASKS_BLOCKER,
} from '../../coordination/CoordinationService.js';
import { CoordinationScheduler } from '../../coordination/CoordinationScheduler.js';
import { WorkspaceLeaseService } from '../../coordination/WorkspaceLeaseService.js';
import { SessionManager } from '../../session/SessionManager.js';
import { SessionStore } from '../../session/SessionStore.js';
import { WsServer } from '../../../infra/network/WsServer.js';

describe('AgentRuntime coordination continuation', () => {
  let dir = '';
  let rootSessionId = '';
  let runtime: AgentRuntime;
  let service: CoordinationService;
  let sessions: SessionManager;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-runtime-coordination-'));
    CoordinationScheduler.resetInstance();
    AgentRuntime.resetInstance();
    CoordinationService.resetInstance();
    WorkspaceLeaseService.resetInstance();
    SessionManager.resetInstance();
    SessionStore.resetInstance();
    AgentRegistry.resetInstance();
    (InterruptController as any)._instance = null;

    const registry = AgentRegistry.getInstance();
    registry.registerAgent(makeAgent('ceo', AgentRole.MainAgent, null, 0));
    registry.registerAgent(makeAgent('manager', AgentRole.Manager, 'ceo', 1));
    registry.registerAgent(makeAgent('worker', AgentRole.Member, 'manager', 2));

    sessions = SessionManager.getInstance();
    await sessions.initialize(path.join(dir, 'sessions'));
    const root = await sessions.createMainSession('ceo', 'Coordination runtime', dir);
    rootSessionId = root.id;
    service = CoordinationService.getInstance();
    await service.initialize(path.join(dir, 'coordination'));
    runtime = AgentRuntime.getInstance();
    vi.spyOn(WsServer.getInstance(), 'send').mockImplementation(() => true);
    vi.spyOn(runtime as any, 'enqueueIdleSessionWake').mockImplementation(() => {});
  });

  afterEach(async () => {
    CoordinationScheduler.resetInstance();
    AgentRuntime.resetInstance();
    CoordinationService.resetInstance();
    WorkspaceLeaseService.resetInstance();
    SessionManager.resetInstance();
    SessionStore.resetInstance();
    AgentRegistry.resetInstance();
    vi.restoreAllMocks();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('continues the same parent task once even when fast child results are durable before the first reply ends', async () => {
    const sessionIds: string[] = [];
    let childTaskId = '';
    vi.spyOn(runtime, 'processMessage').mockImplementation((async function* (
      sessionId: string,
      agentId: string,
    ) {
      sessionIds.push(sessionId);
      if (sessionIds.length === 1) {
        const child = await service.createTask({
          rootSessionId,
          sourceSessionId: sessionId,
          mode: 'subagent',
          subject: 'Fast child',
          description: 'Finish before the manager returns its provisional reply.',
          acceptanceCriteria: ['Fast result is durable'],
          creatorAgentId: agentId,
          assigneeAgentId: 'worker',
          readOnly: true,
        });
        childTaskId = child.id;
        const claimed = await service.claimTask(rootSessionId, child.id, 'worker', child.version);
        const running = await service.updateTask(rootSessionId, child.id, {
          status: 'running',
          sessionId: 'fast-child-session',
        }, 'worker', claimed.version);
        const completed = await service.updateTask(rootSessionId, child.id, {
          status: 'completed',
          progress: 100,
          resultSummary: 'Fast child result',
          outputRef: 'session:fast-child-session',
        }, 'worker', running.version);
        const resultMessage = await service.queueMessage({
          rootSessionId,
          taskId: completed.id,
          fromAgentId: 'worker',
          toAgentId: 'manager',
          kind: 'task_result',
          summary: `${completed.subject}: completed`,
          content: completed.resultSummary!,
          idempotencyKey: `task-result:${completed.id}:${completed.attempt}:completed`,
        });
        const resultXml = [
          `<coordination-event root-session-id="${rootSessionId}" task-id="${completed.id}" status="completed">`,
          `Result: ${completed.resultSummary}`,
          '</coordination-event>',
        ].join('\n');
        await sessions.appendMessage(sessionId, {
          id: resultMessage.id,
          sessionId,
          role: MessageRole.User,
          content: resultXml,
          tokenCount: 10,
          compressed: false,
          timestamp: new Date().toISOString(),
          agentId: 'worker',
        });
        await service.updateMessageStatus(
          rootSessionId,
          resultMessage.id,
          'delivered',
          'manager',
        );
        yield { type: SSEEventType.Text, content: 'dispatched' };
      } else {
        yield { type: SSEEventType.Text, content: 'integrated final result' };
      }
      yield { type: SSEEventType.Done, tokenUsage: { total: 12 } };
    }) as any);

    const created = await service.createTask({
      rootSessionId,
      sourceSessionId: rootSessionId,
      mode: 'hierarchy',
      subject: 'Manager parent',
      description: 'Delegate and then integrate the child result.',
      acceptanceCriteria: ['Return an integrated result'],
      creatorAgentId: 'ceo',
      assigneeAgentId: 'manager',
      readOnly: true,
    });
    const claimed = await service.claimTask(rootSessionId, created.id, 'manager', created.version);

    await runtime.runCoordinationTask(claimed);

    const waiting = service.getTask(rootSessionId, created.id)!;
    expect(waiting).toMatchObject({
      status: 'blocked',
      blocker: WAITING_FOR_CHILD_TASKS_BLOCKER,
      resultSummary: 'dispatched',
      attempt: 1,
    });
    expect(service.getTask(rootSessionId, childTaskId)?.status).toBe('completed');
    expect(service.hasConsumableTaskResult(service.getTask(rootSessionId, childTaskId)!)).toBe(true);

    const scheduler = CoordinationScheduler.getInstance();
    scheduler.start((task) => runtime.runCoordinationTask(task));
    await vi.waitFor(
      () => expect(service.getTask(rootSessionId, created.id)?.status).toBe('completed'),
      { timeout: 5_000 },
    );
    await vi.waitFor(() => {
      expect(service.listMessages(rootSessionId)).toContainEqual(expect.objectContaining({
        taskId: created.id,
        kind: 'task_result',
        status: 'delivered',
      }));
    });

    const completed = service.getTask(rootSessionId, created.id)!;
    expect(completed).toMatchObject({
      status: 'completed',
      resultSummary: 'integrated final result',
      attempt: 2,
      sessionId: waiting.sessionId,
    });
    expect(sessionIds).toEqual([waiting.sessionId, waiting.sessionId]);
    expect(sessions.session(waiting.sessionId!)?.metadata.coordinationTaskId).toBe(created.id);
  });

  it.each(['pending', 'blocked'] as const)(
    'idempotently delivers a cancelled %s task upstream without an active runner',
    async (state) => {
      const created = await service.createTask({
        rootSessionId,
        sourceSessionId: rootSessionId,
        mode: 'hierarchy',
        subject: `Cancel ${state} parent`,
        description: 'Cancellation must reach the creator without a runner.',
        acceptanceCriteria: ['Cancellation is durable'],
        creatorAgentId: 'ceo',
        assigneeAgentId: 'manager',
        readOnly: true,
      });
      let target = created;
      if (state === 'blocked') {
        const session = await sessions.createSubSession(
          rootSessionId,
          'manager',
          'Blocked coordination task',
          { metadata: { coordinationTaskId: created.id } },
        );
        const claimed = await service.claimTask(rootSessionId, created.id, 'manager', created.version);
        const running = await service.updateTask(rootSessionId, created.id, {
          status: 'running',
          sessionId: session.id,
        }, 'manager', claimed.version);
        target = await service.updateTask(rootSessionId, created.id, {
          status: 'blocked',
          blocker: WAITING_FOR_CHILD_TASKS_BLOCKER,
        }, 'manager', running.version);
      }

      const cancelled = await service.requestTaskCancellation(
        rootSessionId,
        target.id,
        'ceo',
        `Cancel while ${state}`,
      );
      expect(cancelled.status).toBe('cancelled');
      await vi.waitFor(() => {
        const result = service.listMessages(rootSessionId).find(
          (message) => message.taskId === target.id && message.kind === 'task_result',
        );
        expect(result).toMatchObject({
          status: 'delivered',
          summary: `${target.subject}: cancelled`,
        });
      });

      await service.requestTaskCancellation(rootSessionId, target.id, 'ceo', 'duplicate');
      const results = service.listMessages(rootSessionId).filter(
        (message) => message.taskId === target.id && message.kind === 'task_result',
      );
      expect(results).toHaveLength(1);
      const history = await sessions.getHistory(rootSessionId);
      expect(history.filter((message) => message.id === results[0].id)).toHaveLength(1);
      expect(history.find((message) => message.id === results[0].id)?.content)
        .toContain('status="cancelled"');
    },
  );

  it('lets a raced cancellation win over post-loop completion and still notifies upstream', async () => {
    vi.spyOn(runtime, 'processMessage').mockImplementation((async function* () {
      yield { type: SSEEventType.Text, content: 'provisional final' };
      yield { type: SSEEventType.Done, tokenUsage: { total: 4 } };
    }) as any);
    const created = await service.createTask({
      rootSessionId,
      sourceSessionId: rootSessionId,
      mode: 'hierarchy',
      subject: 'Cancellation race',
      description: 'Cancel after the loop exits but before completion commits.',
      acceptanceCriteria: ['Cancellation remains authoritative'],
      creatorAgentId: 'ceo',
      assigneeAgentId: 'manager',
      readOnly: true,
    });
    const claimed = await service.claimTask(rootSessionId, created.id, 'manager', created.version);
    const realUpdateTask = service.updateTask.bind(service);
    let injectedCancellation = false;
    vi.spyOn(service, 'updateTask').mockImplementation((async (
      root: string,
      taskId: string,
      patch: Parameters<CoordinationService['updateTask']>[2],
      actor: string,
      expectedVersion?: number,
    ) => {
      if (
        taskId === created.id
        && patch.status === 'completed'
        && !injectedCancellation
      ) {
        injectedCancellation = true;
        await service.requestTaskCancellation(
          rootSessionId,
          created.id,
          'ceo',
          'Cancellation raced final commit',
        );
      }
      return realUpdateTask(root, taskId, patch, actor, expectedVersion);
    }) as CoordinationService['updateTask']);

    await runtime.runCoordinationTask(claimed);

    expect(service.getTask(rootSessionId, created.id)).toMatchObject({
      status: 'cancelled',
      resultSummary: 'provisional final',
    });
    await vi.waitFor(() => {
      expect(service.listMessages(rootSessionId)).toContainEqual(expect.objectContaining({
        taskId: created.id,
        kind: 'task_result',
        summary: `${created.subject}: cancelled`,
        status: 'delivered',
      }));
    });
  });
});

function makeAgent(
  id: string,
  role: AgentRole,
  parentAgentId: string | null,
  level: number,
): Agent {
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
