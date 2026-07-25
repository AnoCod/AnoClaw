import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Agent, CompanyProjection } from '../../../../../shared/types/v3/index.js';
import { CompanyRepository } from '../../store/CompanyRepository.js';
import { WorkRepository } from '../../store/WorkRepository.js';
import { CoordinationScheduler } from '../CoordinationScheduler.js';
import type { V3RunExecutor } from '../V3RunExecutor.js';

describe('CoordinationScheduler', () => {
  let tempRoot = '';
  let companyRepository: CompanyRepository;
  let workRepository: WorkRepository;
  let company: CompanyProjection;
  let runExecutor: Pick<V3RunExecutor, 'execute' | 'recover' | 'stop' | 'isExecuting'>;

  beforeEach(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-v3-scheduler-'));
    companyRepository = new CompanyRepository(tempRoot);
    workRepository = new WorkRepository(tempRoot);
    await companyRepository.bootstrapCompany(
      {
        id: 'company-1',
        rootTeamId: 'team-1',
        mainAgentId: 'leader-1',
        membershipId: 'leader-membership',
        name: 'AnoClaw',
        defaultLocale: 'en-US',
      },
      command(0),
    );
    const worker = await companyRepository.createAgent(
      {
        id: 'worker-1',
        name: 'Worker',
        capabilities: ['implementation'],
        allowedTools: ['Read'],
      },
      command(1),
    );
    await companyRepository.addMembership(
      {
        id: 'worker-membership',
        teamId: 'team-1',
        agentId: worker.id,
        role: 'member',
        isPrimary: true,
      },
      command(2),
    );
    company = await companyRepository.getProjection();
    runExecutor = {
      execute: vi.fn(() => new Promise<void>(() => {})),
      recover: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      isExecuting: vi.fn(() => false),
    };
  });

  afterEach(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it('wakes from dependency changes and claims Task+Run+Session in one revision', async () => {
    await createWork(workRepository);
    await workRepository.createTask(
      'work-1',
      {
        id: 'dependency',
        missionId: 'mission-1',
        title: 'Dependency',
        status: 'blocked',
        teamId: 'team-1',
        readOnly: true,
      },
      command(3),
    );
    await workRepository.createTask(
      'work-1',
      {
        id: 'dependent',
        missionId: 'mission-1',
        title: 'Dependent',
        status: 'ready',
        teamId: 'team-1',
        dependsOnTaskIds: ['dependency'],
        readOnly: true,
      },
      command(4),
    );
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const scheduler = makeScheduler();
    await scheduler.start();
    expect((await workRepository.getProjection('work-1')).tasks.dependent?.status)
      .toBe('ready');

    const before = await workRepository.getProjection('work-1');
    await workRepository.updateTask(
      'work-1',
      'dependency',
      { status: 'completed', completedAt: '2026-01-01T00:01:00.000Z' },
      command(before.revision),
    );
    await scheduler.wake();

    const after = await workRepository.getProjection('work-1');
    expect(after.revision).toBe(before.revision + 2);
    expect(after.tasks.dependent).toMatchObject({
      status: 'claimed',
      assignedAgentId: 'worker-1',
    });
    const dependentRun = Object.values(after.runs).find((run) => run.taskId === 'dependent');
    expect(dependentRun?.status).toBe('queued');
    expect(after.sessions[dependentRun!.sessionId]).toMatchObject({
      taskId: 'dependent',
      runId: dependentRun!.id,
    });
    const claimEvents = (await workRepository.listEvents('work-1', before.revision + 1))
      .filter((event) => event.event.type === 'execution.claimed');
    expect(claimEvents).toHaveLength(1);
    expect(claimEvents[0]?.revision).toBe(before.revision + 2);
    expect(runExecutor.execute).toHaveBeenCalledWith('work-1', dependentRun!.id);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
    await scheduler.stop();
  });

  it('enforces two read loops per agent and leaves the leader coordinating', async () => {
    await createWork(workRepository);
    for (let index = 1; index <= 3; index += 1) {
      const projection = await workRepository.getProjection('work-1');
      await workRepository.createTask(
        'work-1',
        {
          id: `read-${index}`,
          missionId: 'mission-1',
          title: `Read ${index}`,
          status: 'ready',
          teamId: 'team-1',
          assignedAgentId: 'worker-1',
          readOnly: true,
        },
        command(projection.revision),
      );
    }
    const scheduler = makeScheduler();
    await scheduler.start();

    const projection = await workRepository.getProjection('work-1');
    const claimed = Object.values(projection.tasks)
      .filter((task) => task.status === 'claimed');
    const ready = Object.values(projection.tasks)
      .filter((task) => task.status === 'ready');
    expect(claimed).toHaveLength(2);
    expect(ready).toHaveLength(1);
    expect(claimed.every((task) => task.assignedAgentId === 'worker-1')).toBe(true);
    expect(claimed.some((task) => task.assignedAgentId === company.company?.mainAgentId))
      .toBe(false);
    await scheduler.stop();
  });

  it('recovers queued/running/recovery_required Runs through the executor recovery gate', async () => {
    await createWork(workRepository);
    await workRepository.createTask(
      'work-1',
      {
        id: 'task-1',
        missionId: 'mission-1',
        title: 'Task',
        status: 'ready',
        teamId: 'team-1',
        readOnly: true,
      },
      command(3),
    );
    const claim = await workRepository.claimTaskExecution(
      'work-1',
      {
        taskId: 'task-1',
        agentId: 'worker-1',
        sessionId: 'session-run',
        runId: 'run-queued',
        actorSnapshot: actorSnapshot(company.agents['worker-1']!),
        maxTurns: 8,
      },
      command(4),
    );
    const scheduler = makeScheduler();

    await scheduler.start();

    expect(runExecutor.recover).toHaveBeenCalledWith('work-1', claim.run.id);
    await scheduler.stop();
  });

  function makeScheduler(): CoordinationScheduler {
    return new CoordinationScheduler({
      companyRepository,
      workRepository,
      runExecutor: runExecutor as V3RunExecutor,
      requirementsForTask: () => ({ responsibilities: ['implementation'] }),
      idFactory: (() => {
        let value = 0;
        return () => `scheduler-${++value}`;
      })(),
      clock: () => '2026-01-01T00:10:00.000Z',
    });
  }
});

async function createWork(repository: WorkRepository): Promise<void> {
  await repository.createWork(
    {
      id: 'work-1',
      companyId: 'company-1',
      primarySessionId: 'primary-session',
      title: 'Work',
      objective: 'Ship',
      status: 'active',
    },
    command(0),
  );
  await repository.createSession(
    'work-1',
    {
      id: 'primary-session',
      kind: 'primary',
      agentId: 'leader-1',
      actorSnapshot: {
        agentId: 'leader-1',
        name: 'MainAgent',
        teamId: 'team-1',
        capabilities: [],
        enabledSkills: [],
        allowedTools: [],
      },
    },
    command(1),
  );
  await repository.createMission(
    'work-1',
    {
      id: 'mission-1',
      title: 'Mission',
      objective: 'Deliver',
      status: 'active',
      teamId: 'team-1',
      verificationPolicy: {
        mode: 'automatic',
        requireDifferentAgent: false,
        maxRevisionAttempts: 2,
        requiredEvidence: [],
      },
    },
    command(2),
  );
}

function actorSnapshot(agent: Agent) {
  return {
    agentId: agent.id,
    name: agent.name,
    teamId: 'team-1',
    capabilities: [...agent.capabilities],
    enabledSkills: [...agent.enabledSkills],
    allowedTools: [...agent.allowedTools],
  };
}

function command(expectedRevision: number) {
  return {
    expectedRevision,
    occurredAt: `2026-01-01T00:00:${String(expectedRevision).padStart(2, '0')}.000Z`,
  };
}
