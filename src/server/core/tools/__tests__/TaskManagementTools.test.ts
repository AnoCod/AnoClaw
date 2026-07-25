import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';
import {
  CompanyRepository,
  SessionTranscriptRepository,
  WorkRepository,
} from '../../v3/store/index.js';
import { V3ToolExecutionRegistry } from '../../v3/runtime/V3ToolExecutionRegistry.js';
import { JobListTool } from '../builtin/JobListTool.js';
import { MissionCreateTool } from '../builtin/MissionCreateTool.js';
import { TaskAssignTool } from '../builtin/TaskAssignTool.js';
import { TaskClaimTool } from '../builtin/TaskClaimTool.js';
import { TaskCreateTool } from '../builtin/TaskCreateTool.js';
import { TaskListTool } from '../builtin/TaskListTool.js';
import { TaskOutputTool } from '../builtin/TaskOutputTool.js';
import { TaskStopTool } from '../builtin/TaskStopTool.js';
import { TaskUpdateTool } from '../builtin/TaskUpdateTool.js';
import { TaskVerifyTool } from '../builtin/TaskVerifyTool.js';
import type { V3WorkToolDependencies } from '../v3/V3WorkToolSupport.js';

const ctx: ExecutionContext = {
  sessionId: 'session-primary',
  agentId: 'untrusted-execution-context-id',
  workspace: process.cwd(),
  userConfirmed: true,
};

describe('persistent v3 Mission and Task tools', () => {
  let rootDir = '';
  let dependencies: V3WorkToolDependencies;

  beforeEach(async () => {
    rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-v3-task-tools-'));
    dependencies = {
      workRepository: new WorkRepository(rootDir),
      companyRepository: new CompanyRepository(rootDir),
      transcriptRepository: new SessionTranscriptRepository(rootDir),
    };
    await bootstrap(dependencies);
    V3ToolExecutionRegistry.resetInstance();
    V3ToolExecutionRegistry.getInstance().register(v3Context(
      'main-agent',
      'session-primary',
      '',
    ));
    BackgroundTaskManager.resetInstance();
  });

  afterEach(async () => {
    V3ToolExecutionRegistry.resetInstance();
    BackgroundTaskManager.resetInstance();
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  it('requires or derives a Mission and creates Tasks only in the executing Team', async () => {
    const missingMission = await new TaskCreateTool(dependencies).execute({
      subject: 'Implement',
      description: 'Implement durable task tools',
      acceptanceCriteria: ['Tests pass'],
      readOnly: true,
    }, ctx);
    expect(missingMission.success).toBe(false);
    expect(missingMission.structured).toMatchObject({
      error: { code: 'mission_required' },
    });

    const missionResult = await new MissionCreateTool(dependencies).execute({
      title: 'Task tools',
      objective: 'Replace legacy coordination',
      acceptanceCriteria: ['No legacy imports'],
      priority: 'critical',
    }, ctx);
    expect(missionResult.success).toBe(true);
    const mission = (missionResult.structured as { mission: { id: string } }).mission;

    const taskResult = await new TaskCreateTool(dependencies).execute({
      missionId: mission.id,
      subject: 'Implement',
      description: 'Implement durable task tools',
      acceptanceCriteria: ['Tests pass'],
      priority: 'high',
    }, ctx);
    expect(taskResult.success).toBe(true);
    expect((taskResult.structured as { task: unknown }).task).toMatchObject({
      missionId: mission.id,
      teamId: 'team-1',
      status: 'pending',
      readOnly: false,
      writeScope: ['.'],
    });
  });

  it('atomically reserves a ready task for the registry Agent and keeps it scheduler-dispatchable', async () => {
    await createMissionAndTask(dependencies, 'task-1', 'ready');
    V3ToolExecutionRegistry.getInstance().unregister('session-primary');
    V3ToolExecutionRegistry.getInstance().register(v3Context(
      'member-1',
      'session-member',
      'mission-1',
    ));
    const memberCtx = { ...ctx, sessionId: 'session-member' };

    const result = await new TaskClaimTool(dependencies).execute({
      taskId: 'task-1',
      expectedVersion: 1,
    }, memberCtx);
    expect(result.success).toBe(true);
    expect((await dependencies.workRepository.getProjection('work-1')).tasks['task-1'])
      .toMatchObject({
        assignedAgentId: 'member-1',
        status: 'ready',
        version: 2,
      });
  });

  it('TaskOutput reads reports and transcript evidence after restart-safe persistence', async () => {
    await createMissionAndTask(dependencies, 'task-1', 'ready');
    let projection = await dependencies.workRepository.getProjection('work-1');
    await dependencies.workRepository.createRun('work-1', {
      id: 'run-1',
      missionId: 'mission-1',
      taskId: 'task-1',
      agentId: 'member-1',
      sessionId: 'session-run-1',
      attempt: 1,
      maxTurns: 24,
      status: 'succeeded',
    }, command(projection.revision, 'run'));
    projection = await dependencies.workRepository.getProjection('work-1');
    await dependencies.workRepository.createSession('work-1', {
      id: 'session-run-1',
      kind: 'run',
      missionId: 'mission-1',
      taskId: 'task-1',
      runId: 'run-1',
      parentSessionId: 'session-primary',
      agentId: 'member-1',
      actorSnapshot: actor('member-1'),
      status: 'closed',
    }, command(projection.revision, 'run-session'));
    projection = await dependencies.workRepository.getProjection('work-1');
    await dependencies.workRepository.reportTask('work-1', {
      id: 'report-1',
      taskId: 'task-1',
      runId: 'run-1',
      agentId: 'member-1',
      outcome: 'submitted',
      summary: 'Verified durable result',
      artifacts: ['artifact://result'],
    }, command(projection.revision, 'report'));
    await dependencies.transcriptRepository.append('session-run-1', {
      kind: 'message',
      id: 'assistant-result',
      role: 'assistant',
      content: 'Transcript-backed evidence',
      agentId: 'member-1',
    }, { expectedSequence: 0 });

    const result = await new TaskOutputTool(dependencies).execute({ taskId: 'task-1' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('Verified durable result');
    expect(result.content).toContain('Transcript-backed evidence');
    expect(result.structured).toMatchObject({
      transcriptRefs: [{ sessionId: 'session-run-1', sequence: 1 }],
    });
  });

  it('enforces v3 Task versions and legal non-running status transitions', async () => {
    await createMissionAndTask(dependencies, 'task-1', 'ready');
    const updated = await new TaskUpdateTool(dependencies).execute({
      taskId: 'task-1',
      expectedVersion: 1,
      status: 'blocked',
    }, ctx);
    expect(updated.success).toBe(true);
    expect((updated.structured as { task: unknown }).task).toMatchObject({
      status: 'blocked',
      version: 2,
    });

    const stale = await new TaskUpdateTool(dependencies).execute({
      taskId: 'task-1',
      expectedVersion: 1,
      status: 'ready',
    }, ctx);
    expect(stale.success).toBe(false);
    expect(stale.structured).toMatchObject({
      error: { code: 'version_conflict' },
    });
  });

  it('TaskStop uses the repository terminal composite to close Session and release task state', async () => {
    await createMissionAndTask(dependencies, 'task-1', 'running');
    let projection = await dependencies.workRepository.getProjection('work-1');
    await dependencies.workRepository.createRun('work-1', {
      id: 'run-1',
      missionId: 'mission-1',
      taskId: 'task-1',
      agentId: 'member-1',
      sessionId: 'session-run-1',
      attempt: 1,
      maxTurns: 24,
      status: 'running',
    }, command(projection.revision, 'run'));
    projection = await dependencies.workRepository.getProjection('work-1');
    await dependencies.workRepository.createSession('work-1', {
      id: 'session-run-1',
      kind: 'run',
      missionId: 'mission-1',
      taskId: 'task-1',
      runId: 'run-1',
      parentSessionId: 'session-primary',
      agentId: 'member-1',
      actorSnapshot: actor('member-1'),
      status: 'active',
    }, command(projection.revision, 'run-session'));

    const result = await new TaskStopTool(dependencies).execute({
      taskId: 'task-1',
      reason: 'No longer needed',
    }, ctx);
    expect(result.success).toBe(true);
    projection = await dependencies.workRepository.getProjection('work-1');
    expect(projection.tasks['task-1']?.status).toBe('cancelled');
    expect(projection.runs['run-1']).toMatchObject({
      status: 'cancelled',
      terminationReason: 'cancelled',
      error: 'No longer needed',
    });
    expect(projection.sessions['session-run-1']?.status).toBe('closed');
  });

  it('lets only the designated independent reviewer atomically decide verification', async () => {
    let projection = await dependencies.workRepository.getProjection('work-1');
    await dependencies.workRepository.createMission('work-1', {
      id: 'mission-review',
      title: 'Independent review',
      objective: 'Verify the result',
      acceptanceCriteria: ['Evidence is valid'],
      verificationPolicy: {
        mode: 'independent_agent',
        reviewerAgentId: 'reviewer-1',
        requireDifferentAgent: true,
        maxRevisionAttempts: 2,
        requiredEvidence: ['test'],
      },
      status: 'active',
      teamId: 'team-1',
    }, command(projection.revision, 'mission-review'));
    projection = await dependencies.workRepository.getProjection('work-1');
    await dependencies.workRepository.createTask('work-1', {
      id: 'task-review',
      missionId: 'mission-review',
      title: 'Review me',
      acceptanceCriteria: ['Evidence is valid'],
      status: 'submitted',
      teamId: 'team-1',
      assignedAgentId: 'member-1',
      readOnly: true,
    }, command(projection.revision, 'task-review'));
    projection = await dependencies.workRepository.getProjection('work-1');
    await dependencies.workRepository.createRun('work-1', {
      id: 'run-review',
      missionId: 'mission-review',
      taskId: 'task-review',
      agentId: 'member-1',
      sessionId: 'session-review-worker',
      attempt: 1,
      maxTurns: 24,
      status: 'succeeded',
    }, command(projection.revision, 'run-review'));
    projection = await dependencies.workRepository.getProjection('work-1');
    await dependencies.workRepository.createSession('work-1', {
      id: 'session-review-worker',
      kind: 'run',
      missionId: 'mission-review',
      taskId: 'task-review',
      runId: 'run-review',
      parentSessionId: 'session-primary',
      agentId: 'member-1',
      actorSnapshot: actor('member-1'),
      status: 'closed',
    }, command(projection.revision, 'session-review-worker'));
    projection = await dependencies.workRepository.getProjection('work-1');
    await dependencies.workRepository.gateTaskVerification('work-1', {
      runId: 'run-review',
      taskStatus: 'verifying',
      verification: {
        id: 'verification-review',
        mode: 'independent_agent',
        reviewerAgentId: 'reviewer-1',
        outcome: 'pending',
        summary: 'Waiting for reviewer',
        criteria: [{
          criterion: 'Evidence is valid',
          passed: false,
          evidence: [],
        }],
        revisionAttempt: 0,
      },
    }, command(projection.revision, 'verification-pending'));

    V3ToolExecutionRegistry.getInstance().unregister('session-primary');
    V3ToolExecutionRegistry.getInstance().register(v3Context(
      'reviewer-1',
      'session-reviewer',
      'mission-review',
    ));
    const result = await new TaskVerifyTool(dependencies).execute({
      taskId: 'task-review',
      expectedVersion: 2,
      outcome: 'approved',
      summary: 'Independent evidence review passed.',
      criteria: [{
        criterion: 'Evidence is valid',
        passed: true,
        evidence: ['test:passed'],
      }],
    }, { ...ctx, sessionId: 'session-reviewer' });

    expect(result.success).toBe(true);
    projection = await dependencies.workRepository.getProjection('work-1');
    expect(projection.tasks['task-review']).toMatchObject({
      status: 'completed',
      version: 3,
    });
    expect(projection.verificationRecords['verification-review']).toMatchObject({
      outcome: 'approved',
      reviewerAgentId: 'reviewer-1',
      workerAgentId: 'member-1',
    });
    expect(Object.values(projection.coordinationMessages)).toEqual([
      expect.objectContaining({
        kind: 'task_result',
        recipientAgentId: 'member-1',
        taskId: 'task-review',
      }),
    ]);
  });

  it('keeps user-mode verification out of Agent authority', async () => {
    await createPendingUserVerification(dependencies);
    const result = await new TaskVerifyTool(dependencies).execute({
      taskId: 'task-user-review',
      expectedVersion: 2,
      outcome: 'approved',
      summary: 'An Agent must not approve this.',
      criteria: [{
        criterion: 'User accepts the result',
        passed: true,
        evidence: ['agent-assertion'],
      }],
    }, ctx);
    expect(result.success).toBe(false);
    expect(result.structured).toMatchObject({
      error: { code: 'user_verification_required' },
    });
    expect((await dependencies.workRepository.getProjection('work-1'))
      .tasks['task-user-review']?.status).toBe('verifying');
  });

  it('lets MainAgent coordinate a Mission and assignment owned by another Team', async () => {
    let company = await dependencies.companyRepository.getProjection();
    await dependencies.companyRepository.createTeam({
      id: 'team-specialist',
      name: 'Specialists',
      parentTeamId: 'team-1',
    }, command(company.revision, 'team-specialist'));
    company = await dependencies.companyRepository.getProjection();
    await dependencies.companyRepository.createAgent({
      id: 'specialist-1',
      name: 'Specialist One',
    }, command(company.revision, 'specialist-agent'));
    company = await dependencies.companyRepository.getProjection();
    await dependencies.companyRepository.addMembership({
      id: 'membership-specialist',
      teamId: 'team-specialist',
      agentId: 'specialist-1',
      role: 'member',
      isPrimary: true,
    }, command(company.revision, 'specialist-membership'));

    const missionResult = await new MissionCreateTool(dependencies).execute({
      title: 'Specialist Mission',
      objective: 'Coordinate across the Company',
      acceptanceCriteria: ['Specialist completes the task'],
      teamId: 'team-specialist',
    }, ctx);
    expect(missionResult.success).toBe(true);
    const mission = (missionResult.structured as {
      mission: { id: string; teamId: string };
    }).mission;
    expect(mission.teamId).toBe('team-specialist');

    const taskResult = await new TaskCreateTool(dependencies).execute({
      missionId: mission.id,
      subject: 'Specialist task',
      description: 'Use the responsible Team',
      acceptanceCriteria: ['Done'],
      readOnly: true,
    }, ctx);
    expect(taskResult.success).toBe(true);
    const task = (taskResult.structured as {
      task: { id: string; teamId: string; version: number };
    }).task;
    expect(task.teamId).toBe('team-specialist');

    const assignment = await new TaskAssignTool(dependencies).execute({
      taskId: task.id,
      targetAgentId: 'specialist-1',
      expectedVersion: task.version,
    }, ctx);
    expect(assignment.success).toBe(true);
    expect(assignment.structured).toMatchObject({
      task: {
        teamId: 'team-specialist',
        assignedAgentId: 'specialist-1',
      },
      message: {
        teamId: 'team-specialist',
        recipientAgentId: 'specialist-1',
      },
    });
  });

  it('TaskList never mixes process Jobs and every tool rejects missing v3 identity', async () => {
    await createMissionAndTask(dependencies, 'task-1', 'ready');
    const jobId = BackgroundTaskManager.getInstance().register({
      type: 'bash',
      parentSessionId: ctx.sessionId,
      parentAgentId: 'main-agent',
      summary: 'Process job',
      command: 'npm test',
    });

    const tasks = await new TaskListTool(dependencies).execute({}, ctx);
    expect(tasks.success).toBe(true);
    expect(tasks.content).toContain('task-1');
    expect(tasks.content).not.toContain(jobId);
    const jobs = await new JobListTool().execute({}, ctx);
    expect(jobs.content).toContain(jobId);
    expect(jobs.content).not.toContain('task-1');

    V3ToolExecutionRegistry.resetInstance();
    const missingContext = await new TaskListTool(dependencies).execute({}, ctx);
    expect(missingContext.success).toBe(false);
    expect(missingContext.structured).toMatchObject({
      error: { code: 'v3_context_required' },
    });
  });

  it('contains no legacy CoordinationService dependency in public v3 task/message tools', async () => {
    const builtinDir = path.resolve('src/server/core/tools/builtin');
    const files = [
      'TaskCreateTool.ts',
      'TaskAssignTool.ts',
      'TaskClaimTool.ts',
      'TaskUpdateTool.ts',
      'TaskGetTool.ts',
      'TaskListTool.ts',
      'TaskOutputTool.ts',
      'TaskStopTool.ts',
      'TaskVerifyTool.ts',
      'AgentMessageTool.ts',
      'MissionCreateTool.ts',
    ];
    const sources = await Promise.all(files.map((file) =>
      fsp.readFile(path.join(builtinDir, file), 'utf-8'),
    ));
    expect(sources.join('\n')).not.toContain('CoordinationService');
    expect(sources.join('\n')).not.toContain('CoordinationToolHelpers');
    expect(sources.join('\n')).not.toContain('AgentRegistry');
    expect(sources.join('\n')).not.toContain('SessionManager');
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
  await company.createAgent(
    { id: 'reviewer-1', name: 'Reviewer' },
    command(6, 'reviewer'),
  );
  await company.addMembership({
    id: 'membership-reviewer',
    teamId: 'team-1',
    agentId: 'reviewer-1',
    role: 'member',
    isPrimary: true,
  }, command(7, 'reviewer-membership'));

  const work = dependencies.workRepository;
  await work.createWork({
    id: 'work-1',
    companyId: 'company-1',
    primarySessionId: 'session-primary',
    title: 'Build v3',
    objective: 'Persistent tasks',
    status: 'active',
  }, command(0, 'work'));
  await work.createSession('work-1', {
    id: 'session-primary',
    kind: 'primary',
    agentId: 'main-agent',
    actorSnapshot: actor('main-agent'),
  }, command(1, 'session'));
}

async function createMissionAndTask(
  dependencies: V3WorkToolDependencies,
  taskId: string,
  status: 'ready' | 'running',
): Promise<void> {
  let projection = await dependencies.workRepository.getProjection('work-1');
  if (!projection.missions['mission-1']) {
    await dependencies.workRepository.createMission('work-1', {
      id: 'mission-1',
      title: 'Mission',
      objective: 'Objective',
      acceptanceCriteria: ['Done'],
      status: 'active',
      teamId: 'team-1',
    }, command(projection.revision, 'mission'));
    projection = await dependencies.workRepository.getProjection('work-1');
  }
  await dependencies.workRepository.createTask('work-1', {
    id: taskId,
    missionId: 'mission-1',
    title: 'Task',
    acceptanceCriteria: ['Done'],
    status,
    teamId: 'team-1',
    assignedAgentId: status === 'running' ? 'member-1' : undefined,
    readOnly: true,
  }, command(projection.revision, `task-${taskId}`));
}

async function createPendingUserVerification(
  dependencies: V3WorkToolDependencies,
): Promise<void> {
  let projection = await dependencies.workRepository.getProjection('work-1');
  await dependencies.workRepository.createMission('work-1', {
    id: 'mission-user-review',
    title: 'User review',
    objective: 'Wait for the user',
    acceptanceCriteria: ['User accepts the result'],
    verificationPolicy: {
      mode: 'user',
      requireDifferentAgent: false,
      maxRevisionAttempts: 2,
      requiredEvidence: [],
    },
    status: 'active',
    teamId: 'team-1',
  }, command(projection.revision, 'mission-user-review'));
  projection = await dependencies.workRepository.getProjection('work-1');
  await dependencies.workRepository.createTask('work-1', {
    id: 'task-user-review',
    missionId: 'mission-user-review',
    title: 'Await user',
    status: 'submitted',
    teamId: 'team-1',
    assignedAgentId: 'member-1',
    readOnly: true,
  }, command(projection.revision, 'task-user-review'));
  projection = await dependencies.workRepository.getProjection('work-1');
  await dependencies.workRepository.createRun('work-1', {
    id: 'run-user-review',
    missionId: 'mission-user-review',
    taskId: 'task-user-review',
    agentId: 'member-1',
    sessionId: 'session-user-worker',
    attempt: 1,
    maxTurns: 24,
    status: 'succeeded',
  }, command(projection.revision, 'run-user-review'));
  projection = await dependencies.workRepository.getProjection('work-1');
  await dependencies.workRepository.createSession('work-1', {
    id: 'session-user-worker',
    kind: 'run',
    missionId: 'mission-user-review',
    taskId: 'task-user-review',
    runId: 'run-user-review',
    parentSessionId: 'session-primary',
    agentId: 'member-1',
    actorSnapshot: actor('member-1'),
    status: 'closed',
  }, command(projection.revision, 'session-user-worker'));
  projection = await dependencies.workRepository.getProjection('work-1');
  await dependencies.workRepository.gateTaskVerification('work-1', {
    runId: 'run-user-review',
    taskStatus: 'verifying',
    verification: {
      id: 'verification-user-review',
      mode: 'user',
      outcome: 'pending',
      summary: 'Waiting for user',
      criteria: [{
        criterion: 'User accepts the result',
        passed: false,
        evidence: [],
      }],
      revisionAttempt: 0,
    },
  }, command(projection.revision, 'verification-user-pending'));
}

function v3Context(agentId: string, sessionId: string, missionId: string) {
  return {
    companyId: 'company-1',
    teamId: 'team-1',
    workId: 'work-1',
    missionId,
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

function actor(agentId: string) {
  return {
    agentId,
    name: agentId,
    teamId: 'team-1',
    capabilities: [],
    enabledSkills: [],
    allowedTools: ['*'],
  };
}

function command(expectedRevision: number, eventId: string) {
  return { expectedRevision, eventId };
}
