import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkRepository } from '../WorkRepository.js';

describe('WorkRepository coordination ledger', () => {
  let tempRoot = '';
  let repository: WorkRepository;

  beforeEach(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-v3-ledger-'));
    repository = new WorkRepository(tempRoot);
    await createRunLineage(repository);
  });

  afterEach(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it('persists FIFO messages without overwriting and suppresses idempotent retries', async () => {
    const first = await repository.enqueueCoordinationMessage(
      'work-1',
      {
        id: 'message-1',
        teamId: 'team-1',
        taskId: 'task-1',
        senderAgentId: 'agent-main',
        recipientAgentId: 'agent-worker',
        recipientSessionId: 'session-run',
        kind: 'task_assignment',
        content: 'Start the implementation.',
        idempotencyKey: 'assignment:task-1:attempt-1',
      },
      command(6, 'message-1-enqueued'),
    );
    const second = await repository.enqueueCoordinationMessage(
      'work-1',
      {
        id: 'message-2',
        senderAgentId: 'agent-main',
        recipientAgentId: 'agent-worker',
        kind: 'note',
        content: 'Preserve the public contract.',
        idempotencyKey: 'note:task-1:1',
      },
      command(7, 'message-2-enqueued'),
    );
    const retry = await repository.enqueueCoordinationMessage(
      'work-1',
      {
        id: 'different-id',
        senderAgentId: 'agent-main',
        recipientAgentId: 'agent-worker',
        kind: 'note',
        content: 'This retry must not replace the original.',
        idempotencyKey: 'note:task-1:1',
      },
      command(0, 'different-event-id'),
    );

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(retry).toEqual(second);

    const restarted = new WorkRepository(tempRoot);
    const projection = await restarted.getProjection('work-1', true);
    expect(projection.coordinationMessageOrder).toEqual(['message-1', 'message-2']);
    expect(projection.coordinationMessages['message-1']?.content)
      .toBe('Start the implementation.');
    expect(projection.coordinationMessages['message-2']?.content)
      .toBe('Preserve the public contract.');
    expect(projection.revision).toBe(8);
  });

  it('redelivers a consumed message after a crash without appending another inbox item', async () => {
    await repository.enqueueCoordinationMessage(
      'work-1',
      {
        id: 'message-1',
        senderAgentId: 'agent-main',
        recipientAgentId: 'agent-worker',
        recipientSessionId: 'session-run',
        kind: 'steer',
        content: 'Include restart evidence.',
        idempotencyKey: 'steer:restart-evidence',
      },
      command(6, 'message-enqueued'),
    );
    await repository.transitionCoordinationMessage(
      'work-1',
      'message-1',
      'delivered',
      {},
      command(7, 'message-delivered'),
    );
    await repository.transitionCoordinationMessage(
      'work-1',
      'message-1',
      'consumed',
      { consumingTurnId: 'turn-crashed' },
      command(8, 'message-consumed'),
    );

    const restarted = new WorkRepository(tempRoot);
    const beforeRecovery = await restarted.getProjection('work-1', true);
    expect(beforeRecovery.coordinationMessages['message-1']).toMatchObject({
      status: 'consumed',
      consumingTurnId: 'turn-crashed',
      deliveryAttempts: 1,
    });

    await restarted.transitionCoordinationMessage(
      'work-1',
      'message-1',
      'delivered',
      { error: 'worker_process_restarted' },
      command(9, 'message-redelivered'),
    );
    const recovered = await new WorkRepository(tempRoot).getProjection('work-1', true);
    expect(recovered.coordinationMessageOrder).toEqual(['message-1']);
    expect(recovered.coordinationMessages['message-1']).toMatchObject({
      status: 'delivered',
      deliveryAttempts: 2,
      lastError: 'worker_process_restarted',
    });
    expect(recovered.coordinationMessages['message-1']?.consumingTurnId).toBeUndefined();
  });

  it('projects an interrupted write tool as recovery_required across restart', async () => {
    await repository.prepareToolCall(
      'work-1',
      {
        id: 'journal-1',
        missionId: 'mission-1',
        taskId: 'task-1',
        runId: 'run-1',
        sessionId: 'session-run',
        agentId: 'agent-worker',
        toolCallId: 'tool-call-1',
        toolName: 'Edit',
        readOnly: false,
        writeScope: ['src\\server\\core\\v3\\'],
        idempotencyKey: 'tool:run-1:tool-call-1',
      },
      command(6, 'tool-prepared'),
    );
    await repository.transitionToolCall(
      'work-1',
      'journal-1',
      'started',
      {},
      command(7, 'tool-started'),
    );

    const projection = await new WorkRepository(tempRoot).getProjection('work-1', true);
    expect(projection.toolCallJournal['journal-1']).toMatchObject({
      status: 'started',
      recoveryStatus: 'recovery_required',
      writeScope: ['src/server/core/v3'],
    });
    expect(projection.revision).toBe(8);
  });

  it('persists leases, orchestration decisions, and verification evidence', async () => {
    await repository.acquireWorkspaceLease(
      'work-1',
      {
        id: 'lease-1',
        workspaceId: 'workspace-1',
        writeScope: ['src\\server\\', './src/server/core/'],
        ownerRunId: 'run-1',
        ownerTaskId: 'task-1',
        ownerAgentId: 'agent-worker',
        fencingToken: 1,
        expiresAt: '2026-01-01T00:00:30.000Z',
      },
      command(6, 'lease-acquired'),
    );
    await repository.recordOrchestrationDecision(
      'work-1',
      {
        id: 'decision-1',
        missionId: 'mission-1',
        taskId: 'task-1',
        runId: 'run-1',
        kind: 'assignment',
        decision: 'Assign the runtime specialist.',
        reason: 'Required tools and capability match.',
        candidateAgentIds: ['agent-worker'],
        selectedAgentId: 'agent-worker',
        inputs: { capacity: 1 },
      },
      command(7, 'decision-recorded'),
    );
    await repository.recordVerification(
      'work-1',
      {
        id: 'verification-1',
        missionId: 'mission-1',
        taskId: 'task-1',
        runId: 'run-1',
        mode: 'independent_agent',
        workerAgentId: 'agent-worker',
        reviewerAgentId: 'agent-reviewer',
        outcome: 'approved',
        summary: 'All acceptance criteria passed.',
        criteria: [{
          criterion: 'Restart recovery is durable',
          passed: true,
          evidence: ['test:WorkCoordinationLedger'],
        }],
        revisionAttempt: 0,
        completedAt: '2026-01-01T00:00:08.000Z',
      },
      command(8, 'verification-recorded'),
    );

    const projection = await new WorkRepository(tempRoot).getProjection('work-1', true);
    expect(projection.workspaceLeases['lease-1']?.writeScope)
      .toEqual(['src/server', 'src/server/core']);
    expect(projection.orchestrationDecisions['decision-1']?.selectedAgentId)
      .toBe('agent-worker');
    expect(projection.verificationRecords['verification-1']?.criteria[0]?.passed)
      .toBe(true);
  });

  it('keeps revision checks atomic for competing appends', async () => {
    const results = await Promise.allSettled([
      repository.enqueueCoordinationMessage(
        'work-1',
        {
          id: 'message-a',
          senderAgentId: 'agent-main',
          recipientAgentId: 'agent-worker',
          kind: 'note',
          content: 'A',
          idempotencyKey: 'message-a',
        },
        command(6, 'message-a-event'),
      ),
      repository.enqueueCoordinationMessage(
        'work-1',
        {
          id: 'message-b',
          senderAgentId: 'agent-main',
          recipientAgentId: 'agent-worker',
          kind: 'note',
          content: 'B',
          idempotencyKey: 'message-b',
        },
        command(6, 'message-b-event'),
      ),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason)
      .toMatchObject({ code: 'REVISION_CONFLICT' });
  });
});

async function createRunLineage(repository: WorkRepository): Promise<void> {
  await repository.createWork(
    {
      id: 'work-1',
      companyId: 'company-1',
      primarySessionId: 'session-primary',
      title: 'Durable coordination',
      objective: 'Recover all coordination state',
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
      title: 'Coordination ledger',
      objective: 'Persist every coordination fact',
      status: 'active',
    },
    command(2, 'mission-created'),
  );
  await repository.createTask(
    'work-1',
    {
      id: 'task-1',
      missionId: 'mission-1',
      title: 'Implement durable ledger',
      status: 'running',
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
      maxTurns: 24,
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
}

function command(expectedRevision: number, eventId: string) {
  return {
    expectedRevision,
    eventId,
    occurredAt: `2026-01-01T00:00:${String(expectedRevision).padStart(2, '0')}.000Z`,
  };
}

function actorSnapshot(agentId: string, name: string) {
  return {
    agentId,
    name,
    capabilities: [],
    enabledSkills: [],
    allowedTools: [],
  };
}
