import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionTranscriptRepository } from '../SessionTranscriptRepository.js';
import { WorkRepository } from '../WorkRepository.js';

describe('WorkRepository and SessionTranscriptRepository', () => {
  let tempRoot = '';
  let workRepository: WorkRepository;
  let transcriptRepository: SessionTranscriptRepository;

  beforeEach(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-v3-work-'));
    workRepository = new WorkRepository(tempRoot);
    transcriptRepository = new SessionTranscriptRepository(tempRoot);
  });

  afterEach(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it('projects the Work to Mission to Task to Run to Session lineage', async () => {
    await workRepository.createWork(
      {
        id: 'work-1',
        companyId: 'company-1',
        primarySessionId: 'session-primary',
        title: 'Ship 3.0',
        objective: 'Complete the breaking refactor',
        status: 'active',
      },
      command(0, 'work-created'),
    );
    await workRepository.createSession(
      'work-1',
      {
        id: 'session-primary',
        kind: 'primary',
        agentId: 'agent-1',
        actorSnapshot: actorSnapshot(),
      },
      command(1, 'primary-session-created'),
    );
    await workRepository.createMission(
      'work-1',
      {
        id: 'mission-1',
        title: 'Runtime',
        objective: 'Implement runtime',
        acceptanceCriteria: ['Runtime tests pass'],
        priority: 'high',
        status: 'active',
      },
      command(2, 'mission-created'),
    );
    await workRepository.createTask(
      'work-1',
      {
        id: 'task-1',
        missionId: 'mission-1',
        title: 'Implement loop',
        status: 'ready',
        priority: 'high',
        teamId: 'team-runtime',
        readOnly: false,
        writeScope: ['src/server/core/v3'],
      },
      command(3, 'task-created'),
    );
    await workRepository.createRun(
      'work-1',
      {
        id: 'run-1',
        missionId: 'mission-1',
        taskId: 'task-1',
        agentId: 'agent-1',
        sessionId: 'session-1',
        attempt: 1,
        maxTurns: 24,
        status: 'running',
      },
      command(4, 'run-created'),
    );
    await workRepository.createSession(
      'work-1',
      {
        id: 'session-1',
        kind: 'run',
        missionId: 'mission-1',
        taskId: 'task-1',
        runId: 'run-1',
        parentSessionId: 'session-primary',
        agentId: 'agent-1',
        actorSnapshot: actorSnapshot(),
      },
      command(5, 'session-created'),
    );
    await workRepository.reportTask(
      'work-1',
      {
        id: 'report-1',
        taskId: 'task-1',
        runId: 'run-1',
        agentId: 'agent-1',
        outcome: 'submitted',
        summary: 'Ready for verification',
        artifacts: ['commit:abc123'],
      },
      command(6, 'task-reported'),
    );

    const projection = await workRepository.getProjection('work-1');
    expect(projection.missions['mission-1']?.workId).toBe('work-1');
    expect(projection.tasks['task-1']?.missionId).toBe('mission-1');
    expect(projection.runs['run-1']).toMatchObject({
      taskId: 'task-1',
      sessionId: 'session-1',
      maxTurns: 24,
      fencingToken: 1,
      toolCount: 0,
      workspaceExecution: { mode: 'none' },
    });
    expect(projection.sessions['session-primary']).toMatchObject({
      kind: 'primary',
      status: 'active',
    });
    expect(projection.sessions['session-primary']?.missionId).toBeUndefined();
    expect(projection.sessions['session-1']?.runId).toBe('run-1');
    expect(projection.taskReports['report-1']?.outcome).toBe('submitted');
    expect(projection.revision).toBe(7);
  });

  it('keeps Session persistence transcript-only and excludes sensitive metadata', async () => {
    const first = await transcriptRepository.append(
      'session-1',
      { kind: 'message', id: 'message-1', role: 'user', content: 'Hello' },
      { expectedSequence: 0, entryId: 'entry-1', occurredAt: '2026-01-01T00:00:00.000Z' },
    );
    const retry = await transcriptRepository.append(
      'session-1',
      { kind: 'message', id: 'different', role: 'user', content: 'Not appended' },
      { expectedSequence: 0, entryId: 'entry-1', occurredAt: '2026-01-01T00:00:01.000Z' },
    );

    expect(first.sequence).toBe(1);
    expect(retry).toEqual(first);
    expect(await transcriptRepository.read('session-1')).toHaveLength(1);
    expect(await fsp.readdir(path.join(tempRoot, 'session', 'session-1')))
      .toEqual(['transcript.jsonl']);

    await expect(transcriptRepository.append(
      'session-1',
      {
        kind: 'message',
        id: 'message-2',
        role: 'assistant',
        content: 'Unsafe',
        metadata: { api_key: 'must-never-persist' },
      },
      { expectedSequence: 1 },
    )).rejects.toMatchObject({ code: 'SENSITIVE_FIELD' });
  });

  it('recovers a truncated transcript tail but rejects a middle record gap', async () => {
    await transcriptRepository.append(
      'session-tail',
      { kind: 'message', id: 'message-1', role: 'user', content: 'Committed' },
      { expectedSequence: 0, occurredAt: '2026-01-01T00:00:00.000Z' },
    );
    const transcriptPath = path.join(
      tempRoot,
      'session',
      'session-tail',
      'transcript.jsonl',
    );
    await fsp.appendFile(transcriptPath, '{"schemaVersion":3,"sequence":2', 'utf-8');
    expect(await transcriptRepository.read('session-tail')).toHaveLength(1);
    await transcriptRepository.append(
      'session-tail',
      { kind: 'message', id: 'message-2', role: 'assistant', content: 'After recovery' },
      { expectedSequence: 1, occurredAt: '2026-01-01T00:00:01.000Z' },
    );
    expect(await transcriptRepository.read('session-tail')).toHaveLength(2);

    const records = await transcriptRepository.read('session-tail');
    const gap = { ...records[1], entryId: 'entry-gap', sequence: 4 };
    await fsp.appendFile(transcriptPath, `${JSON.stringify(gap)}\n`, 'utf-8');
    await expect(transcriptRepository.read('session-tail')).rejects.toMatchObject({
      code: 'CORRUPT_EVENT_STREAM',
      details: expect.objectContaining({ line: 3 }),
    });
  });
});

function command(expectedRevision: number, eventId: string) {
  return {
    expectedRevision,
    eventId,
    occurredAt: `2026-01-01T00:00:${String(expectedRevision).padStart(2, '0')}.000Z`,
  };
}

function actorSnapshot() {
  return {
    agentId: 'agent-1',
    name: 'Builder',
    capabilities: [],
    enabledSkills: [],
    allowedTools: [],
  };
}
