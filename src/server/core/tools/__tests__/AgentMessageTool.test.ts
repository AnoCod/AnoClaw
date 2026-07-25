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
import { AgentMessageTool } from '../builtin/AgentMessageTool.js';
import type { V3WorkToolDependencies } from '../v3/V3WorkToolSupport.js';

const ctx: ExecutionContext = {
  sessionId: 'session-primary',
  agentId: 'legacy-agent-id-must-be-ignored',
  workspace: process.cwd(),
  userConfirmed: true,
};

describe('AgentMessageTool persistent v3 FIFO mailbox', () => {
  let rootDir = '';
  let dependencies: V3WorkToolDependencies;

  beforeEach(async () => {
    rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-v3-agent-message-'));
    dependencies = {
      workRepository: new WorkRepository(rootDir),
      companyRepository: new CompanyRepository(rootDir),
      transcriptRepository: new SessionTranscriptRepository(rootDir),
      idFactory: sequenceId(),
    };
    await bootstrap(dependencies);
    V3ToolExecutionRegistry.resetInstance();
    V3ToolExecutionRegistry.getInstance().register(v3Context('main-agent', 'session-primary'));
  });

  afterEach(async () => {
    V3ToolExecutionRegistry.resetInstance();
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  it('queues ordered notes without creating or mutating Session transcripts', async () => {
    const tool = new AgentMessageTool(dependencies);
    await tool.execute({ to: 'member-1', kind: 'note', content: 'First' }, ctx);
    const result = await tool.execute({ to: 'member-1', kind: 'note', content: 'Second' }, ctx);

    expect(result.success).toBe(true);
    const projection = await dependencies.workRepository.getProjection('work-1');
    const messages = projection.coordinationMessageOrder
      .map((id) => projection.coordinationMessages[id]!)
      .filter((message) => message.recipientAgentId === 'member-1');
    expect(messages.map((message) => [message.sequence, message.content, message.status]))
      .toEqual([[1, 'First', 'queued'], [2, 'Second', 'queued']]);
    expect(await dependencies.transcriptRepository.read('session-primary')).toEqual([]);
  });

  it('creates one independently trackable FIFO record per broadcast recipient', async () => {
    const result = await new AgentMessageTool(dependencies).execute({
      to: '*',
      kind: 'note',
      content: 'Shared update',
      taskId: 'task-1',
    }, ctx);

    expect(result.success).toBe(true);
    const projection = await dependencies.workRepository.getProjection('work-1');
    const messages = Object.values(projection.coordinationMessages);
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.recipientAgentId).sort())
      .toEqual(['member-1', 'member-2']);
    expect(messages.every((message) =>
      message.teamId === 'team-1'
      && message.taskId === 'task-1'
      && message.status === 'queued'
      && message.sequence === 1)).toBe(true);
    expect(new Set(messages.map((message) => message.id)).size).toBe(2);
  });

  it('rejects steer unless the target has a running v3 Run Session', async () => {
    const result = await new AgentMessageTool(dependencies).execute({
      to: 'member-1',
      kind: 'steer',
      content: 'Change direction.',
    }, ctx);
    expect(result.success).toBe(false);
    expect(result.structured).toMatchObject({
      error: { code: 'recipient_not_running' },
    });
  });

  it('does not allow messaging outside the executing persistent Team', async () => {
    const company = dependencies.companyRepository;
    const revision = (await company.getProjection()).revision;
    await company.createAgent({ id: 'outsider', name: 'Outsider' }, command(revision, 'outsider'));

    const result = await new AgentMessageTool(dependencies).execute({
      to: 'outsider',
      kind: 'note',
      content: 'Forbidden',
    }, ctx);
    expect(result.success).toBe(false);
    expect(result.structured).toMatchObject({
      error: { code: 'recipient_not_in_team' },
    });
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
  for (const [revision, agentId, role] of [
    [2, 'main-agent', 'leader'],
    [4, 'member-1', 'member'],
    [6, 'member-2', 'member'],
  ] as const) {
    await company.createAgent(
      { id: agentId, name: agentId },
      command(revision, `${agentId}-created`),
    );
    await company.addMembership({
      id: `membership-${agentId}`,
      teamId: 'team-1',
      agentId,
      role,
      isPrimary: true,
    }, command(revision + 1, `${agentId}-membership`));
  }

  const work = dependencies.workRepository;
  await work.createWork({
    id: 'work-1',
    companyId: 'company-1',
    primarySessionId: 'session-primary',
    title: 'Build v3',
    objective: 'Persistent messages',
    status: 'active',
  }, command(0, 'work'));
  await work.createSession('work-1', {
    id: 'session-primary',
    kind: 'primary',
    agentId: 'main-agent',
    actorSnapshot: actor('main-agent'),
  }, command(1, 'session'));
  await work.createMission('work-1', {
    id: 'mission-1',
    title: 'Messaging',
    objective: 'Test mailbox',
    status: 'active',
    teamId: 'team-1',
  }, command(2, 'mission'));
  await work.createTask('work-1', {
    id: 'task-1',
    missionId: 'mission-1',
    title: 'Send messages',
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

function sequenceId(): () => string {
  let value = 0;
  return () => `tool-id-${++value}`;
}
