import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Company, Team } from '../../../../shared/types/v3/index.js';
import {
  AppendOnlyEventStore,
  CompanyRepository,
  SessionTranscriptRepository,
  WorkRepository,
} from '../../../core/v3/store/index.js';
import type { V3ApiServices } from '../Contracts.js';
import { createRepositoryV3Services } from '../RepositoryServices.js';

describe('repository-backed v3 API services', () => {
  let tempRoot = '';
  let services: V3ApiServices;
  let nextId = 0;

  beforeEach(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-v3-services-'));
    nextId = 0;
    services = createRepositoryV3Services(tempRoot, {
      idFactory: () => `generated-${++nextId}`,
      clock: () => '2026-07-25T00:00:00.000Z',
    });
  });

  afterEach(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it('atomically bootstraps one Company, root Team, MainAgent, and primary membership', async () => {
    expect(await services.company.getCompany()).toEqual({ data: null, revision: 0 });

    const created = await services.company.createCompany(
      { name: 'Local Studio', defaultLocale: 'en-US' },
      0,
    );
    const projection = await new CompanyRepository(tempRoot).getProjection();

    expect(created).toMatchObject({
      revision: 1,
      data: {
        name: 'Local Studio',
        defaultLocale: 'en-US',
      },
    });
    expect(projection.revision).toBe(1);
    expect(projection.teams[created.data.rootTeamId]).toMatchObject({
      companyId: created.data.id,
      name: 'Company',
    });
    expect(projection.agents[created.data.mainAgentId]).toMatchObject({
      companyId: created.data.id,
      name: 'MainAgent',
      status: 'active',
      provider: 'openai-compatible',
      model: 'deepseek-chat',
      credentialRef: 'local-llm',
    });
    expect(Object.values(projection.memberships)).toEqual([
      expect.objectContaining({
        teamId: created.data.rootTeamId,
        agentId: created.data.mainAgentId,
        role: 'leader',
        isPrimary: true,
      }),
    ]);
    expect(await new CompanyRepository(tempRoot).listEvents()).toHaveLength(1);

    await expect(services.company.createCompany({ name: 'Second' }, 1))
      .rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });

  it('enforces expectedRevision, ownership filtering, and one primary Team membership', async () => {
    const company = (await bootstrap()).data;
    const rootProjection = await new CompanyRepository(tempRoot).getProjection();
    const mainAgent = rootProjection.agents[company.mainAgentId]!;

    const team = await services.company.createTeam(
      { name: 'Runtime' },
      rootProjection.revision,
    );
    await expect(services.company.addTeamMember(
      team.data.id,
      {
        agentId: mainAgent.id,
        role: 'member',
        isPrimary: true,
      },
      team.revision,
    )).rejects.toMatchObject({ code: 'CONFLICT' });

    await expect(services.company.updateCompany({ name: 'stale' }, 0))
      .rejects.toMatchObject({
        code: 'REVISION_CONFLICT',
        details: expect.objectContaining({ currentRevision: team.revision }),
      });

    const store = new AppendOnlyEventStore(tempRoot);
    const foreignTeam = teamRecord({
      id: 'foreign-team',
      companyId: 'other-company',
    });
    await store.appendCompanyEvent(
      'install-company',
      {
        eventId: 'foreign-team-injected',
        occurredAt: '2026-07-25T00:00:01.000Z',
        event: { type: 'team.created', team: foreignTeam },
      },
      team.revision,
    );

    expect(await services.company.getTeam(foreignTeam.id)).toBeNull();
    expect((await services.company.listTeams()).data.map(({ id }) => id))
      .not.toContain(foreignTeam.id);

    const foreignRepository = new WorkRepository(tempRoot);
    const foreignWork = await foreignRepository.createWork(
      {
        id: 'foreign-work',
        companyId: 'other-company',
        primarySessionId: 'foreign-primary',
        title: 'Hidden',
        objective: 'Must not cross the company boundary',
      },
      { expectedRevision: 0 },
    );
    const foreignMission = await foreignRepository.createMission(
      foreignWork.id,
      {
        id: 'foreign-mission',
        title: 'Hidden mission',
        objective: 'Remain scoped to another company',
      },
      { expectedRevision: 1 },
    );
    const foreignTask = await foreignRepository.createTask(
      foreignWork.id,
      {
        id: 'foreign-task',
        missionId: foreignMission.id,
        title: 'Hidden task',
      },
      { expectedRevision: 2 },
    );
    expect(foreignWork.companyId).toBe('other-company');
    expect(await services.work.getWork(foreignWork.id)).toBeNull();
    expect(await services.work.getMission(foreignMission.id)).toBeNull();
    expect(await services.work.getTask(foreignTask.id)).toBeNull();
    expect((await services.work.listWorks()).data).toEqual([]);
  });

  it('updates memberships and archives Teams through the persistent organization API', async () => {
    await bootstrap();
    const team = await services.company.createTeam({ name: 'Quality' }, 1);
    const agent = await services.company.createAgent(
      { name: 'Reviewer', capabilities: ['review'] },
      team.revision,
    );
    const membership = await services.company.addTeamMember(
      team.data.id,
      {
        agentId: agent.data.id,
        role: 'member',
        isPrimary: true,
      },
      agent.revision,
    );
    const updated = await services.company.updateTeamMember(
      team.data.id,
      {
        membershipId: membership!.data.id,
        role: 'leader',
      },
      membership!.revision,
    );
    expect(updated).toMatchObject({
      data: {
        role: 'leader',
        isPrimary: true,
      },
      revision: membership!.revision + 1,
    });

    const removed = await services.company.removeTeamMember(
      team.data.id,
      { membershipId: membership!.data.id },
      updated!.revision,
    );
    const archived = await services.company.archiveTeam(
      team.data.id,
      { reason: 'No longer needed' },
      removed!.revision,
    );
    expect(archived).toMatchObject({
      data: {
        id: team.data.id,
        archivedAt: '2026-07-25T00:00:00.000Z',
      },
      revision: removed!.revision + 1,
    });
  });

  it('blocks removing a busy Team member unless force cancels the owned Task first', async () => {
    await bootstrap();
    const team = await services.company.createTeam({ name: 'Delivery' }, 1);
    const agent = await services.company.createAgent(
      { name: 'Delivery Agent' },
      team.revision,
    );
    const membership = await services.company.addTeamMember(
      team.data.id,
      {
        agentId: agent.data.id,
        role: 'member',
        isPrimary: false,
      },
      agent.revision,
    );
    const work = await services.work.createWork(
      {
        title: 'Busy membership',
        objective: 'Protect active responsibility',
        primarySessionId: 'busy-primary',
      },
      0,
    );
    const mission = await services.work.createMission(
      work.data.id,
      {
        title: 'Delivery',
        objective: 'Complete assigned work',
        teamId: team.data.id,
      },
      work.revision,
    );
    const task = await services.work.createTask(
      mission!.data.id,
      {
        title: 'Owned task',
        status: 'ready',
        teamId: team.data.id,
        assignedAgentId: agent.data.id,
      },
      mission!.revision,
    );

    await expect(services.company.removeTeamMember(
      team.data.id,
      { membershipId: membership!.data.id },
      membership!.revision,
    )).rejects.toMatchObject({ code: 'CONFLICT' });

    const removed = await services.company.removeTeamMember(
      team.data.id,
      { membershipId: membership!.data.id, force: true },
      membership!.revision,
    );
    expect(removed?.data.removedAt).toBeDefined();
    expect((await new WorkRepository(tempRoot).getProjection(work.data.id))
      .tasks[task!.data.id]?.status).toBe('cancelled');
  });

  it('rejects force-archiving a parent Team before cancelling its active work', async () => {
    await bootstrap();
    const parent = await services.company.createTeam({ name: 'Parent' }, 1);
    const child = await services.company.createTeam(
      { name: 'Child', parentTeamId: parent.data.id },
      parent.revision,
    );
    const work = await services.work.createWork(
      {
        title: 'Parent-owned work',
        objective: 'Do not mutate when the Team hierarchy is invalid',
        primarySessionId: 'parent-primary',
      },
      0,
    );
    const mission = await services.work.createMission(
      work.data.id,
      {
        title: 'Parent responsibility',
        objective: 'Remain active',
        teamId: parent.data.id,
      },
      work.revision,
    );
    const task = await services.work.createTask(
      mission!.data.id,
      {
        title: 'Still active',
        status: 'ready',
        teamId: parent.data.id,
      },
      mission!.revision,
    );

    await expect(services.company.archiveTeam(
      parent.data.id,
      { force: true },
      child.revision,
    )).rejects.toMatchObject({ code: 'CONFLICT' });

    expect((await new WorkRepository(tempRoot).getProjection(work.data.id))
      .tasks[task!.data.id]?.status).toBe('ready');
  });

  it('operates Work, Mission, Task, Run, Session, and public transcript messages', async () => {
    const company = (await bootstrap()).data;
    const companyProjection = await new CompanyRepository(tempRoot).getProjection();
    const mainAgent = companyProjection.agents[company.mainAgentId]!;

    const workResult = await services.work.createWork(
      {
        title: 'Ship AnoClaw 3',
        objective: 'Exercise the clean runtime',
        primarySessionId: 'primary-session',
      },
      0,
    );
    expect(workResult.revision).toBe(2);
    expect(workResult.data.primarySessionId).toBe('primary-session');

    const missionResult = await services.work.createMission(
      workResult.data.id,
      {
        title: 'Runtime',
        objective: 'Implement the runtime boundary',
        acceptanceCriteria: ['Focused tests pass'],
        priority: 'high',
        teamId: company.rootTeamId,
        ownerAgentId: mainAgent.id,
        verificationPolicy: {
          mode: 'automatic',
          requireDifferentAgent: false,
          maxRevisionAttempts: 2,
          requiredEvidence: ['test output'],
        },
      },
      2,
    );
    expect(missionResult?.data).toMatchObject({
      acceptanceCriteria: ['Focused tests pass'],
      priority: 'high',
      verificationPolicy: {
        mode: 'automatic',
        maxRevisionAttempts: 2,
      },
    });

    const taskResult = await services.work.createTask(
      missionResult!.data.id,
      {
        title: 'Wire services',
        acceptanceCriteria: ['Routes use v3 stores'],
        priority: 'critical',
        teamId: company.rootTeamId,
        readOnly: false,
        writeScope: ['src/server/api/v3'],
      },
      3,
    );
    expect(taskResult?.data).toMatchObject({
      status: 'pending',
      version: 1,
      writeScope: ['src/server/api/v3'],
    });

    const assigned = await services.work.assignTask(
      taskResult!.data.id,
      { agentId: mainAgent.id },
      4,
    );
    expect(assigned?.data).toMatchObject({
      status: 'ready',
      assignedAgentId: mainAgent.id,
      version: 2,
    });

    const claimed = await services.work.claimTask(
      taskResult!.data.id,
      {
        agentId: mainAgent.id,
        sessionId: 'run-session-1',
        maxTurns: 12,
      },
      5,
    );
    expect(claimed).toMatchObject({
      revision: 6,
      data: {
        task: { status: 'claimed', version: 3 },
        run: {
          status: 'queued',
          attempt: 1,
          fencingToken: 1,
          toolCount: 0,
          tokenUsage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
          },
          cost: { currency: 'USD', amount: 0, estimated: true },
          workspaceExecution: { mode: 'none' },
        },
      },
    });

    const projectionAfterClaim = await new WorkRepository(tempRoot)
      .getProjection(workResult.data.id);
    expect(projectionAfterClaim.sessions['primary-session']).toMatchObject({
      kind: 'primary',
      status: 'active',
      agentId: mainAgent.id,
    });
    expect(projectionAfterClaim.sessions['primary-session']?.taskId).toBeUndefined();
    expect(projectionAfterClaim.sessions['run-session-1']).toMatchObject({
      kind: 'run',
      parentSessionId: 'primary-session',
      runId: claimed!.data.run.id,
      actorSnapshot: { agentId: mainAgent.id, name: 'MainAgent' },
    });

    const transcriptRepository = new SessionTranscriptRepository(tempRoot);
    await transcriptRepository.append(
      'run-session-1',
      {
        kind: 'event',
        id: 'runtime-event',
        eventType: 'tool.started',
        data: { toolName: 'test' },
      },
      { expectedSequence: 0 },
    );
    expect(await services.work.listTranscript('run-session-1', 0)).toEqual({
      data: [],
      revision: 1,
    });

    await expect(services.work.appendMessage(
      'run-session-1',
      { role: 'user', content: 'This must not enter an execution transcript' },
      1,
    )).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(services.work.appendMessage(
      'primary-session',
      { role: 'assistant', content: 'This public endpoint is user-only' },
      0,
    )).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    const appended = await services.work.appendMessage(
      'primary-session',
      { role: 'user', content: 'Ready for execution' },
      0,
    );
    expect(appended).toMatchObject({
      data: {
        kind: 'message',
        role: 'user',
        content: 'Ready for execution',
      },
      revision: 1,
    });
    expect((await services.work.listTranscript('primary-session', 0))?.data)
      .toEqual([appended!.data]);

    const revisionAfterTranscript = (
      await new WorkRepository(tempRoot).getProjection(workResult.data.id)
    ).revision;
    const stopped = await services.work.stopTask(
      taskResult!.data.id,
      { runId: claimed!.data.run.id, reason: 'User stopped the task' },
      revisionAfterTranscript,
    );
    expect(stopped).toMatchObject({
      revision: revisionAfterTranscript + 1,
      data: {
        task: { status: 'cancelled' },
        run: {
          status: 'cancelled',
          terminationReason: 'cancelled',
        },
      },
    });
  });

  it('cascades pausing a Work into every non-terminal Task runner', async () => {
    const company = (await bootstrap()).data;
    const stopCalls: Array<{ workId: string; taskId: string; reason?: string }> = [];
    services = createRepositoryV3Services(tempRoot, {
      idFactory: () => `generated-${++nextId}`,
      clock: () => '2026-07-25T00:00:00.000Z',
      runExecutor: {
        stop: async (workId, taskId, reason) => {
          stopCalls.push({ workId, taskId, reason });
        },
      },
    });
    const work = await services.work.createWork(
      {
        title: 'Pause cascade',
        objective: 'Stop active company work safely',
        primarySessionId: 'pause-primary',
      },
      0,
    );
    const mission = await services.work.createMission(
      work.data.id,
      {
        title: 'Execution',
        objective: 'Exercise pause semantics',
        teamId: company.rootTeamId,
      },
      work.revision,
    );
    const task = await services.work.createTask(
      mission!.data.id,
      {
        title: 'Long running task',
        status: 'ready',
        teamId: company.rootTeamId,
      },
      mission!.revision,
    );

    const paused = await services.work.updateWork(
      work.data.id,
      { status: 'paused' },
      task!.revision,
    );

    expect(paused?.data.status).toBe('paused');
    expect(stopCalls).toEqual([{
      workId: work.data.id,
      taskId: task!.data.id,
      reason: 'Work paused by user',
    }]);
  });

  it('lets the user approve a pending user-mode verification atomically', async () => {
    const company = (await bootstrap()).data;
    const companyProjection = await new CompanyRepository(tempRoot).getProjection();
    const mainAgent = companyProjection.agents[company.mainAgentId]!;
    const work = await services.work.createWork(
      {
        title: 'User verification',
        objective: 'Keep human acceptance explicit',
        primarySessionId: 'verification-primary',
      },
      0,
    );
    const mission = await services.work.createMission(
      work.data.id,
      {
        title: 'Approval gate',
        objective: 'Wait for the user',
        acceptanceCriteria: ['The deliverable is acceptable'],
        teamId: company.rootTeamId,
        verificationPolicy: {
          mode: 'user',
          requireDifferentAgent: false,
          maxRevisionAttempts: 2,
          requiredEvidence: [],
        },
      },
      work.revision,
    );
    const task = await services.work.createTask(
      mission!.data.id,
      {
        title: 'Prepare deliverable',
        status: 'ready',
        teamId: company.rootTeamId,
      },
      mission!.revision,
    );
    const claimed = await services.work.claimTask(
      task!.data.id,
      {
        agentId: mainAgent.id,
        sessionId: 'verification-run-session',
        maxTurns: 5,
      },
      task!.revision,
    );
    const repository = new WorkRepository(tempRoot, {
      clock: () => '2026-07-25T00:00:00.000Z',
      idFactory: () => `repository-${++nextId}`,
    });
    const started = await repository.startTaskExecution(
      work.data.id,
      {
        runId: claimed!.data.run.id,
        workspaceExecution: { mode: 'none' },
      },
      { expectedRevision: claimed!.revision },
    );
    const submitted = await repository.finishTaskExecution(
      work.data.id,
      {
        runId: claimed!.data.run.id,
        taskStatus: 'submitted',
        runStatus: 'succeeded',
        terminationReason: 'completed',
        resultSummary: 'Deliverable ready',
        report: {
          outcome: 'submitted',
          summary: 'Deliverable ready',
          artifacts: [],
        },
      },
      { expectedRevision: started.revision },
    );
    const gated = await repository.gateTaskVerification(
      work.data.id,
      {
        runId: claimed!.data.run.id,
        taskStatus: 'verifying',
        verification: {
          mode: 'user',
          outcome: 'pending',
          summary: 'Waiting for user verification.',
          criteria: [{
            criterion: 'The deliverable is acceptable',
            passed: false,
            evidence: [],
          }],
          revisionAttempt: 0,
        },
      },
      { expectedRevision: submitted.revision },
    );

    const approved = await services.work.verifyTask(
      task!.data.id,
      {
        outcome: 'approved',
        summary: 'Accepted by the user.',
        criteria: [{
          criterion: 'The deliverable is acceptable',
          passed: true,
          evidence: ['Reviewed in the Work interface'],
        }],
      },
      gated.revision,
    );

    expect(approved).toMatchObject({
      revision: gated.revision + 1,
      data: {
        task: { status: 'completed' },
        verification: {
          mode: 'user',
          outcome: 'approved',
          completedAt: '2026-07-25T00:00:00.000Z',
        },
      },
    });
  });

  it('retries a revision-required Task with a fenced next Run', async () => {
    const company = (await bootstrap()).data;
    const companyProjection = await new CompanyRepository(tempRoot).getProjection();
    const mainAgent = companyProjection.agents[company.mainAgentId]!;
    const work = await services.work.createWork(
      {
        title: 'Retry flow',
        objective: 'Prove revision attempts',
        primarySessionId: 'retry-primary',
      },
      0,
    );
    const mission = await services.work.createMission(
      work.data.id,
      {
        title: 'Retry mission',
        objective: 'Retry safely',
        teamId: company.rootTeamId,
      },
      2,
    );
    const task = await services.work.createTask(
      mission!.data.id,
      {
        title: 'Retry task',
        status: 'ready',
        teamId: company.rootTeamId,
      },
      3,
    );
    const claimed = await services.work.claimTask(
      task!.data.id,
      {
        agentId: mainAgent.id,
        sessionId: 'attempt-1',
        maxTurns: 5,
      },
      4,
    );
    const repository = new WorkRepository(tempRoot);
    await repository.updateRun(
      work.data.id,
      claimed!.data.run.id,
      { status: 'succeeded', terminationReason: 'completed' },
      { expectedRevision: 5 },
    );
    await repository.updateTask(
      work.data.id,
      task!.data.id,
      { status: 'revision_required' },
      { expectedRevision: 6 },
    );

    const retried = await services.work.retryTask(
      task!.data.id,
      {
        agentId: mainAgent.id,
        sessionId: 'attempt-2',
        maxTurns: 8,
      },
      7,
    );
    expect(retried).toMatchObject({
      revision: 8,
      data: {
        task: { status: 'claimed' },
        run: {
          status: 'queued',
          attempt: 2,
          maxTurns: 8,
          fencingToken: 2,
        },
      },
    });
    const retryEvents = await repository.listEvents(work.data.id, 7);
    expect(retryEvents).toHaveLength(1);
    expect(retryEvents[0]?.event).toMatchObject({
      type: 'execution.claimed',
      operation: 'retry',
      task: { status: 'claimed' },
      run: { attempt: 2 },
      session: { id: 'attempt-2' },
    });
  });

  async function bootstrap(): Promise<{ data: Company; revision: number }> {
    return services.company.createCompany(
      { name: 'AnoClaw', defaultLocale: 'zh-CN' },
      0,
    );
  }
});

function teamRecord(overrides: Partial<Team>): Team {
  return {
    id: 'team',
    companyId: 'company',
    name: 'Team',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    ...overrides,
  };
}
