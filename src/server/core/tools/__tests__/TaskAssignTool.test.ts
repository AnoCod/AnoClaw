import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import {
  CompanyRepository,
  SessionTranscriptRepository,
  WorkRepository,
} from '../../v3/store/index.js';
import { V3ToolExecutionRegistry } from '../../v3/runtime/V3ToolExecutionRegistry.js';
import { TaskAssignTool } from '../builtin/TaskAssignTool.js';
import type { V3WorkToolDependencies } from '../v3/V3WorkToolSupport.js';

const ctx: ExecutionContext = {
  sessionId: 'session-primary',
  agentId: 'spoofed-v2-agent',
  workspace: process.cwd(),
  userConfirmed: true,
};

describe('TaskAssignTool persistent v3 Team contract', () => {
  let rootDir = '';
  let dependencies: V3WorkToolDependencies;

  beforeEach(async () => {
    rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-v3-task-assign-'));
    dependencies = {
      workRepository: new WorkRepository(rootDir),
      companyRepository: new CompanyRepository(rootDir),
      transcriptRepository: new SessionTranscriptRepository(rootDir),
    };
    await bootstrap(dependencies);
    V3ToolExecutionRegistry.resetInstance();
    V3ToolExecutionRegistry.getInstance().register(v3Context('main-agent', 'session-primary'));
  });

  afterEach(async () => {
    V3ToolExecutionRegistry.resetInstance();
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  it('assigns to an active Team member and enqueues a persistent assignment', async () => {
    const result = await new TaskAssignTool(dependencies).execute({
      taskId: 'task-1',
      targetAgentId: 'member-1',
      expectedVersion: 1,
    }, ctx);

    expect(result.success).toBe(true);
    const projection = await dependencies.workRepository.getProjection('work-1');
    expect(projection.tasks['task-1']).toMatchObject({
      assignedAgentId: 'member-1',
      status: 'ready',
      version: 2,
    });
    expect(Object.values(projection.coordinationMessages)).toEqual([
      expect.objectContaining({
        kind: 'task_assignment',
        recipientAgentId: 'member-1',
        taskId: 'task-1',
        status: 'queued',
        sequence: 1,
      }),
    ]);
  });

  it('rejects an Agent outside the persistent Team without hierarchy fallback', async () => {
    let revision = (await dependencies.companyRepository.getProjection()).revision;
    await dependencies.companyRepository.createAgent(
      { id: 'outsider', name: 'Outsider' },
      command(revision, 'outsider-created'),
    );

    const result = await new TaskAssignTool(dependencies).execute({
      taskId: 'task-1',
      targetAgentId: 'outsider',
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.structured).toMatchObject({
      error: { code: 'target_not_in_team' },
    });
    expect((await dependencies.workRepository.getProjection('work-1'))
      .tasks['task-1']?.assignedAgentId).toBeUndefined();
  });

  it('uses the server-owned registry identity instead of ExecutionContext.agentId', async () => {
    const result = await new TaskAssignTool(dependencies).execute({
      taskId: 'task-1',
      targetAgentId: 'member-1',
    }, ctx);
    expect(result.success).toBe(true);
    const messages = Object.values(
      (await dependencies.workRepository.getProjection('work-1')).coordinationMessages,
    );
    expect(messages[0]?.senderAgentId).toBe('main-agent');
    expect(messages[0]?.senderAgentId).not.toBe(ctx.agentId);
  });
});

async function bootstrap(dependencies: V3WorkToolDependencies): Promise<void> {
  const company = dependencies.companyRepository;
  await company.createCompany({
    id: 'company-1',
    name: 'AnoClaw',
    mainAgentId: 'main-agent',
    rootTeamId: 'team-1',
    defaultLocale: 'zh-CN',
  }, command(0, 'company'));
  await company.createTeam({ id: 'team-1', name: 'Core Team' }, command(1, 'team'));
  await company.createAgent({ id: 'main-agent', name: 'MainAgent' }, command(2, 'main'));
  await company.addMembership({
    id: 'membership-main',
    teamId: 'team-1',
    agentId: 'main-agent',
    role: 'leader',
    isPrimary: true,
  }, command(3, 'main-membership'));
  await company.createAgent({ id: 'member-1', name: 'Member One' }, command(4, 'member'));
  await company.addMembership({
    id: 'membership-member',
    teamId: 'team-1',
    agentId: 'member-1',
    role: 'member',
    isPrimary: true,
  }, command(5, 'member-membership'));

  const work = dependencies.workRepository;
  await work.createWork({
    id: 'work-1',
    companyId: 'company-1',
    primarySessionId: 'session-primary',
    title: 'Build v3',
    objective: 'Ship durable Teams',
    status: 'active',
  }, command(0, 'work'));
  await work.createSession('work-1', {
    id: 'session-primary',
    kind: 'primary',
    agentId: 'main-agent',
    actorSnapshot: actor('main-agent', 'MainAgent'),
  }, command(1, 'primary'));
  await work.createMission('work-1', {
    id: 'mission-1',
    title: 'Coordination',
    objective: 'Coordinate work',
    acceptanceCriteria: ['Done'],
    status: 'active',
    teamId: 'team-1',
  }, command(2, 'mission'));
  await work.createTask('work-1', {
    id: 'task-1',
    missionId: 'mission-1',
    title: 'Inspect',
    description: 'Inspect code',
    acceptanceCriteria: ['Evidence'],
    status: 'ready',
    teamId: 'team-1',
    readOnly: true,
  }, command(3, 'task'));
}

function v3Context(agentId: string, sessionId: string) {
  return {
    companyId: 'company-1',
    teamId: 'team-1',
    workId: 'work-1',
    missionId: 'mission-1',
    taskId: '',
    runId: `runtime-${sessionId}`,
    sessionId,
    agentId,
    readOnly: true,
    writeScope: [],
    fencingToken: 1,
    activeLeases: [],
    allowedTools: ['*'],
  };
}

function actor(agentId: string, name: string) {
  return {
    agentId,
    name,
    teamId: 'team-1',
    capabilities: [],
    enabledSkills: [],
    allowedTools: ['*'],
  };
}

function command(expectedRevision: number, eventId: string) {
  return { expectedRevision, eventId };
}
