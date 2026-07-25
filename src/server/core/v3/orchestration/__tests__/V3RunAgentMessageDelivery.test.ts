import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent as RuntimeAgent } from '../../../agent/Agent.js';
import { SSEEventType, type SSEEvent } from '../../../../../shared/types/events.js';
import type {
  Agent,
  CompanyProjection,
  CoordinationMessage,
  Session,
  WorkProjection,
} from '../../../../../shared/types/v3/index.js';
import { V3DomainError } from '../../domain/DomainError.js';
import type {
  V3RuntimeAgentRegistry,
  V3TurnRunner,
  V3TurnRunnerRequest,
} from '../../execution/V3AgentRuntimeBridge.js';
import { SessionTranscriptRepository } from '../../store/SessionTranscriptRepository.js';
import { WorkRepository } from '../../store/WorkRepository.js';
import { InterruptController } from '../../../agent/supervision/InterruptController.js';
import type { V3AgentTurnRequest } from '../V3RunExecutor.js';
import { V3RunAgentTurnExecutor } from '../V3RunAgentTurnExecutor.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => (
    fsp.rm(root, { recursive: true, force: true })
  )));
});

class CapturingRunner implements V3TurnRunner {
  readonly requests: V3TurnRunnerRequest[] = [];

  constructor(
    private readonly events: SSEEvent[] = [
      { type: SSEEventType.Text, content: 'Completed with evidence.', turnCount: 1 },
      { type: SSEEventType.Done, turnCount: 1 },
    ],
    private readonly failure?: Error,
  ) {}

  runTurn(request: V3TurnRunnerRequest): AsyncIterable<SSEEvent> {
    this.requests.push(request);
    return this.failure
      ? failingEventStream(this.failure)
      : eventStream(this.events);
  }
}

class FakeRegistry implements V3RuntimeAgentRegistry {
  private readonly agents = new Map<string, RuntimeAgent>();

  agent(agentId: string): RuntimeAgent | undefined {
    return this.agents.get(agentId);
  }

  registerAgent(agent: RuntimeAgent): void {
    this.agents.set(agent.id, agent);
  }

  unregisterAgent(agentId: string): boolean {
    return this.agents.delete(agentId);
  }
}

class LiveSteerRunner implements V3TurnRunner {
  readonly boundaryMessages: Array<readonly { id: string; content: string }[]> = [];
  afterEnqueue?: () => void;

  constructor(private readonly repository: WorkRepository) {}

  async *runTurn(request: V3TurnRunnerRequest): AsyncIterable<SSEEvent> {
    const provider = request.options.safeTurnBoundaryMessageProvider;
    if (!provider) throw new Error('safe-turn-boundary provider is required');
    this.boundaryMessages.push(await provider({
      agentId: request.runtimeAgentId,
      sessionId: request.sessionId,
      turn: 1,
    }));
    const projection = await this.repository.getProjection('work-1');
    await this.repository.enqueueCoordinationMessage(
      'work-1',
      {
        id: 'live-steer',
        teamId: 'team-1',
        taskId: 'task-1',
        senderAgentId: 'agent-main',
        recipientAgentId: 'agent-worker',
        recipientSessionId: 'session-run',
        kind: 'steer',
        content: 'Change direction while this Run is active.',
        idempotencyKey: 'live-steer:run-1',
      },
      command(projection.revision, 'live-steer-enqueued'),
    );
    this.afterEnqueue?.();
    this.boundaryMessages.push(await provider({
      agentId: request.runtimeAgentId,
      sessionId: request.sessionId,
      turn: 2,
    }));
    yield {
      type: SSEEventType.Text,
      content: 'Applied the live steer with evidence.',
      turnCount: 2,
    };
    yield { type: SSEEventType.Done, turnCount: 2 };
  }
}

class ConflictOnceWorkRepository {
  private conflicted = false;

  constructor(private readonly delegate: WorkRepository) {}

  getProjection(workId: string): Promise<WorkProjection> {
    return this.delegate.getProjection(workId);
  }

  updateSession: WorkRepository['updateSession'] = (
    workId,
    sessionId,
    update,
    options,
  ) => this.delegate.updateSession(workId, sessionId, update, options);

  transitionCoordinationMessage: WorkRepository['transitionCoordinationMessage'] = (
    workId,
    messageId,
    nextStatus,
    input,
    options,
  ) => {
    if (!this.conflicted) {
      this.conflicted = true;
      throw new V3DomainError('REVISION_CONFLICT', 'simulated concurrent append');
    }
    return this.delegate.transitionCoordinationMessage(
      workId,
      messageId,
      nextStatus,
      input,
      options,
    );
  };
}

describe('V3RunAgentTurnExecutor coordination inbox', () => {
  it('consumes the recipient inbox in FIFO batches and retries revision conflicts', async () => {
    const { root, repository } = await preparedRepository();
    await enqueue(repository, 'message-1', 'First instruction', 'note');
    await enqueue(repository, 'message-2', 'Second instruction', 'steer');
    await enqueue(repository, 'message-3', 'Third instruction', 'note');
    const runner = new CapturingRunner();
    const executor = executorFor(
      new ConflictOnceWorkRepository(repository),
      root,
      runner,
      2,
    );

    await expect(executor.execute(await runRequest(repository)))
      .resolves.toMatchObject({ type: 'done' });

    const projection = await repository.getProjection('work-1', true);
    expect(projection.coordinationMessages['message-1']).toMatchObject({
      status: 'acknowledged',
      sequence: 1,
      deliveryAttempts: 1,
      consumingTurnId: 'v3-run-turn:run-1:attempt:1',
      recipientSessionId: 'session-run',
    });
    expect(projection.coordinationMessages['message-2']).toMatchObject({
      status: 'acknowledged',
      sequence: 2,
      deliveryAttempts: 1,
    });
    expect(projection.coordinationMessages['message-3']).toMatchObject({
      status: 'queued',
      sequence: 3,
    });

    const coordinationInput = runner.requests[0]!.history
      .filter((message) => message.content.includes('<coordination-event'))
      .map((message) => message.content);
    expect(coordinationInput).toHaveLength(2);
    expect(coordinationInput[0]).toContain('"id": "message-1"');
    expect(coordinationInput[0]).toContain('"senderAgentId": "agent-main"');
    expect(coordinationInput[0]).toContain('"recipientAgentId": "agent-worker"');
    expect(coordinationInput[0]).toContain('"recipientSessionId": "session-run"');
    expect(coordinationInput[1]).toContain('"id": "message-2"');
  });

  it('redelivers on a failed turn and reuses one durable transcript entry on retry', async () => {
    const { root, repository } = await preparedRepository();
    await enqueue(repository, 'message-1', 'Do not lose this note', 'note');
    const failedRunner = new CapturingRunner([], new Error('provider unavailable'));
    const failedExecutor = executorFor(repository, root, failedRunner);

    await expect(failedExecutor.execute(await runRequest(repository)))
      .resolves.toMatchObject({ type: 'error', message: 'provider unavailable' });

    let projection = await repository.getProjection('work-1', true);
    expect(projection.coordinationMessages['message-1']).toMatchObject({
      status: 'delivered',
      deliveryAttempts: 2,
      lastError: 'turn_error',
      recipientSessionId: 'session-run',
    });
    let transcript = await new SessionTranscriptRepository(root).read('session-run');
    expect(transcript.filter((record) => (
      record.entryId === 'run-run-1-coordination-message-1'
    ))).toHaveLength(1);

    const retryRunner = new CapturingRunner();
    const retryExecutor = executorFor(repository, root, retryRunner);
    await expect(retryExecutor.execute(await runRequest(repository, true)))
      .resolves.toMatchObject({ type: 'done' });

    projection = await repository.getProjection('work-1', true);
    expect(projection.coordinationMessages['message-1']).toMatchObject({
      status: 'acknowledged',
      deliveryAttempts: 2,
      consumingTurnId: 'v3-run-turn:run-1:attempt:1',
    });
    transcript = await new SessionTranscriptRepository(root).read('session-run');
    expect(transcript.filter((record) => (
      record.entryId === 'run-run-1-coordination-message-1'
    ))).toHaveLength(1);
    expect(retryRunner.requests[0]!.history.filter((message) => (
      message.content.includes('"id": "message-1"')
    ))).toHaveLength(1);
  });

  it('recovers a crash-consumed Session message before replaying it', async () => {
    const { root, repository } = await preparedRepository();
    await enqueue(repository, 'message-1', 'Recover this steer', 'steer');
    let revision = (await repository.getProjection('work-1')).revision;
    await repository.transitionCoordinationMessage(
      'work-1',
      'message-1',
      'delivered',
      { recipientSessionId: 'session-run' },
      command(revision, 'crash-message-delivered'),
    );
    revision += 1;
    await repository.transitionCoordinationMessage(
      'work-1',
      'message-1',
      'consumed',
      {
        consumingTurnId: 'crashed-process-turn',
        recipientSessionId: 'session-run',
      },
      command(revision, 'crash-message-consumed'),
    );
    const runner = new CapturingRunner();
    const executor = executorFor(repository, root, runner);

    await expect(executor.execute(await runRequest(repository, true)))
      .resolves.toMatchObject({ type: 'done' });

    const projection = await repository.getProjection('work-1', true);
    expect(projection.coordinationMessages['message-1']).toMatchObject({
      status: 'acknowledged',
      consumingTurnId: 'v3-run-turn:run-1:attempt:1',
      deliveryAttempts: 2,
      lastError: 'run_turn_recovered',
    });
    expect(runner.requests[0]!.history.filter((message) => (
      message.content.includes('"id": "message-1"')
    ))).toHaveLength(1);
  });

  it('does not acknowledge a message owned by another consuming turn', async () => {
    const { root, repository } = await preparedRepository();
    await enqueue(repository, 'message-1', 'Owned by another turn', 'steer');
    let revision = (await repository.getProjection('work-1')).revision;
    await repository.transitionCoordinationMessage(
      'work-1',
      'message-1',
      'delivered',
      { recipientSessionId: 'session-run' },
      command(revision, 'message-delivered'),
    );
    revision += 1;
    await repository.transitionCoordinationMessage(
      'work-1',
      'message-1',
      'consumed',
      {
        consumingTurnId: 'different-live-turn',
        recipientSessionId: 'session-run',
      },
      command(revision, 'message-consumed-elsewhere'),
    );
    const runner = new CapturingRunner();
    const executor = executorFor(repository, root, runner);

    await expect(executor.execute(await runRequest(repository, false)))
      .resolves.toMatchObject({ type: 'done' });

    const projection = await repository.getProjection('work-1', true);
    expect(projection.coordinationMessages['message-1']).toMatchObject({
      status: 'consumed',
      consumingTurnId: 'different-live-turn',
    });
    expect(runner.requests[0]!.history.some((message) => (
      message.content.includes('"id": "message-1"')
    ))).toBe(false);
    await expect(repository.transitionCoordinationMessage(
      'work-1',
      'message-1',
      'acknowledged',
      { consumingTurnId: 'v3-run-turn:run-1:attempt:1' },
      command(projection.revision, 'wrong-turn-ack'),
    )).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('injects a steer enqueued after Run start at the next safe turn and acknowledges it', async () => {
    const { root, repository } = await preparedRepository();
    const runner = new LiveSteerRunner(repository);
    const executor = executorFor(repository, root, runner);
    const wakeSpy = vi.spyOn(
      InterruptController.getInstance(),
      'wakeOnly',
    );
    runner.afterEnqueue = () => executor.wakeSafeTurnBoundary('session-run');

    try {
      await expect(executor.execute(await runRequest(repository)))
        .resolves.toMatchObject({ type: 'done', turnsConsumed: 2 });
      expect(wakeSpy).toHaveBeenCalledWith('session-run');
    } finally {
      wakeSpy.mockRestore();
    }

    expect(runner.boundaryMessages[0]).toEqual([]);
    expect(runner.boundaryMessages[1]).toHaveLength(1);
    expect(runner.boundaryMessages[1]![0]).toMatchObject({
      id: 'live-steer',
      content: expect.stringContaining('Change direction while this Run is active.'),
    });
    const projection = await repository.getProjection('work-1', true);
    expect(projection.coordinationMessages['live-steer']).toMatchObject({
      status: 'acknowledged',
      recipientSessionId: 'session-run',
      consumingTurnId: 'v3-run-turn:run-1:attempt:1',
      deliveryAttempts: 1,
    });
    const transcript = await new SessionTranscriptRepository(root).read('session-run');
    expect(transcript.filter((record) => (
      record.entryId === 'run-run-1-coordination-live-steer'
    ))).toHaveLength(1);
  });
});

function executorFor(
  workRepository: WorkRepository | ConflictOnceWorkRepository,
  root: string,
  runner: V3TurnRunner,
  messageBatchSize = 20,
): V3RunAgentTurnExecutor {
  return new V3RunAgentTurnExecutor({
    workRepository,
    companyRepository: { getProjection: async () => company() },
    transcriptRepository: new SessionTranscriptRepository(root),
    runner,
    registry: new FakeRegistry(),
    settings: { get: <T>(_key: string, fallback?: T) => fallback as T },
    credentials: { load: async () => null },
    messageBatchSize,
    clock: () => '2026-07-25T00:01:00.000Z',
  });
}

async function preparedRepository(): Promise<{
  root: string;
  repository: WorkRepository;
}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-v3-inbox-'));
  temporaryRoots.push(root);
  const repository = new WorkRepository(root);
  await repository.createWork(
    {
      id: 'work-1',
      companyId: 'company-1',
      primarySessionId: 'session-primary',
      title: 'Message delivery',
      objective: 'Deliver every Team message',
      status: 'active',
    },
    command(0, 'work-created'),
  );
  await repository.createSession(
    'work-1',
    {
      id: 'session-primary',
      kind: 'primary',
      agentId: 'agent-main',
      actorSnapshot: actorSnapshot('agent-main', 'MainAgent'),
    },
    command(1, 'primary-session-created'),
  );
  await repository.createMission(
    'work-1',
    {
      id: 'mission-1',
      title: 'Durable delivery',
      objective: 'Consume the mailbox',
      status: 'active',
      teamId: 'team-1',
    },
    command(2, 'mission-created'),
  );
  await repository.createTask(
    'work-1',
    {
      id: 'task-1',
      missionId: 'mission-1',
      title: 'Read the inbox',
      status: 'running',
      teamId: 'team-1',
      assignedAgentId: 'agent-worker',
      writeScope: ['src/server/core/v3'],
    },
    command(3, 'task-created'),
  );
  await repository.createRun(
    'work-1',
    {
      id: 'run-1',
      missionId: 'mission-1',
      taskId: 'task-1',
      agentId: 'agent-worker',
      sessionId: 'session-run',
      attempt: 1,
      maxTurns: 8,
      status: 'running',
    },
    command(4, 'run-created'),
  );
  await repository.createSession(
    'work-1',
    {
      id: 'session-run',
      kind: 'run',
      missionId: 'mission-1',
      taskId: 'task-1',
      runId: 'run-1',
      parentSessionId: 'session-primary',
      agentId: 'agent-worker',
      actorSnapshot: actorSnapshot('agent-worker', 'Worker'),
    },
    command(5, 'run-session-created'),
  );
  return { root, repository };
}

async function enqueue(
  repository: WorkRepository,
  id: string,
  content: string,
  kind: CoordinationMessage['kind'],
): Promise<void> {
  const projection = await repository.getProjection('work-1');
  await repository.enqueueCoordinationMessage(
    'work-1',
    {
      id,
      teamId: 'team-1',
      taskId: 'task-1',
      senderAgentId: 'agent-main',
      recipientAgentId: 'agent-worker',
      kind,
      content,
      idempotencyKey: `inbox:${id}`,
    },
    command(projection.revision, `${id}-enqueued`),
  );
}

async function runRequest(
  repository: WorkRepository,
  recovering = false,
): Promise<V3AgentTurnRequest> {
  const projection = await repository.getProjection('work-1');
  return {
    work: projection.work!,
    mission: projection.missions['mission-1']!,
    task: projection.tasks['task-1']!,
    run: projection.runs['run-1']!,
    session: projection.sessions['session-run']!,
    agent: workerAgent(),
    signal: new AbortController().signal,
    recovering,
    onHeartbeat: () => {},
  };
}

function company(): CompanyProjection {
  const worker = workerAgent();
  return {
    company: {
      id: 'company-1',
      name: 'AnoClaw',
      mainAgentId: 'agent-main',
      rootTeamId: 'team-1',
      defaultLocale: 'en-US',
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
    },
    workspaces: {},
    teams: {
      'team-1': {
        id: 'team-1',
        companyId: 'company-1',
        name: 'Engineering',
        createdAt: '2026-07-25T00:00:00.000Z',
        updatedAt: '2026-07-25T00:00:00.000Z',
      },
    },
    memberships: {
      'membership-worker': {
        id: 'membership-worker',
        companyId: 'company-1',
        teamId: 'team-1',
        agentId: 'agent-worker',
        role: 'member',
        isPrimary: true,
        createdAt: '2026-07-25T00:00:00.000Z',
        updatedAt: '2026-07-25T00:00:00.000Z',
      },
    },
    agents: { 'agent-worker': worker },
    revision: 1,
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

function workerAgent(): Agent {
  return {
    id: 'agent-worker',
    companyId: 'company-1',
    name: 'Worker',
    instructions: 'Read every Team message before acting.',
    status: 'active',
    provider: 'provider',
    model: 'model',
    capabilities: ['implementation'],
    enabledSkills: [],
    allowedTools: ['Read'],
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

function actorSnapshot(agentId: string, name: string): Session['actorSnapshot'] {
  return {
    agentId,
    name,
    teamId: 'team-1',
    capabilities: [],
    enabledSkills: [],
    allowedTools: ['Read'],
  };
}

function command(expectedRevision: number, eventId: string) {
  return {
    expectedRevision,
    eventId,
    occurredAt: '2026-07-25T00:00:00.000Z',
  };
}

async function* eventStream(events: readonly SSEEvent[]): AsyncIterable<SSEEvent> {
  for (const event of events) yield event;
}

async function* failingEventStream(error: Error): AsyncIterable<SSEEvent> {
  throw error;
}
