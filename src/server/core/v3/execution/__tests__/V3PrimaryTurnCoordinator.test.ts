import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CompanyRepository,
  SessionTranscriptRepository,
  WorkRepository,
} from '../../store/index.js';
import {
  V3PrimaryTurnCoordinator,
  type V3PrimaryTurnExecutor,
} from '../V3PrimaryTurnCoordinator.js';
import type {
  V3PrimaryTurnInput,
  V3PrimaryTurnResult,
} from '../V3AgentRuntimeBridge.js';

const NOW = '2026-07-25T08:00:00.000Z';

describe('V3PrimaryTurnCoordinator', () => {
  let rootDir = '';
  let companyRepository: CompanyRepository;
  let workRepository: WorkRepository;
  let transcriptRepository: SessionTranscriptRepository;

  beforeEach(async () => {
    rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-v3-primary-turn-'));
    companyRepository = new CompanyRepository(rootDir, { clock: () => NOW });
    workRepository = new WorkRepository(rootDir, { clock: () => NOW });
    transcriptRepository = new SessionTranscriptRepository(rootDir, { clock: () => NOW });
    await seedPrimarySession(companyRepository, workRepository);
  });

  afterEach(async () => {
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  it('marks the Session active only while executing and persists one assistant reply', async () => {
    let statusDuringExecution = '';
    const executor = new RecordingExecutor(async (input) => {
      statusDuringExecution = (
        await workRepository.getProjection(input.session.workId)
      ).sessions[input.session.id]?.status ?? '';
      return success(input, 'I have started the company plan.');
    });
    const coordinator = createCoordinator(executor);
    await appendUserMessage('user-1', 'Start the plan');

    const result = await coordinator.execute({
      workId: 'work-1',
      sessionId: 'session-primary',
      messageId: 'user-1',
    });

    expect(result.status).toBe('succeeded');
    expect(statusDuringExecution).toBe('active');
    expect((await workRepository.getProjection('work-1')).sessions['session-primary'])
      .toMatchObject({ status: 'idle', transcriptRevision: 2 });
    expect((await transcriptRepository.read('session-primary')).map((record) => record.entry))
      .toMatchObject([
        { kind: 'message', id: 'user-1', role: 'user', content: 'Start the plan' },
        {
          kind: 'message',
          id: 'assistant-for-user-1',
          role: 'assistant',
          content: 'I have started the company plan.',
        },
      ]);
    expect(executor.inputs[0]?.packet.team.members).toHaveLength(1);
  });

  it('serializes queued turns per primary Session in FIFO order', async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const executor = new RecordingExecutor(async (input) => {
      order.push(`start:${input.messageId}`);
      if (input.messageId === 'user-1') {
        markFirstStarted?.();
        await firstBlocked;
      }
      order.push(`finish:${input.messageId}`);
      return success(input, `reply:${input.messageId}`);
    });
    const coordinator = createCoordinator(executor);
    await appendUserMessage('user-1', 'First');
    await appendUserMessage('user-2', 'Second');

    coordinator.enqueue({ workId: 'work-1', sessionId: 'session-primary', messageId: 'user-1' });
    coordinator.enqueue({ workId: 'work-1', sessionId: 'session-primary', messageId: 'user-2' });
    await firstStarted;
    expect(order).toEqual(['start:user-1']);
    releaseFirst?.();
    await coordinator.waitForIdle('session-primary');

    expect(order).toEqual([
      'start:user-1',
      'finish:user-1',
      'start:user-2',
      'finish:user-2',
    ]);
  });

  it('cascades stop through the active turn AbortSignal and returns Session to idle', async () => {
    let started: (() => void) | undefined;
    const executionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const executor = new RecordingExecutor(async (input) => {
      if (!input.signal) throw new Error('Coordinator must provide an AbortSignal');
      const signal = input.signal;
      started?.();
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        ...success(input, ''),
        status: 'cancelled',
        done: false,
        error: 'Turn cancelled',
      };
    });
    const coordinator = createCoordinator(executor);
    await appendUserMessage('user-1', 'Stop me');
    coordinator.enqueue({ workId: 'work-1', sessionId: 'session-primary', messageId: 'user-1' });
    await executionStarted;

    expect(coordinator.stopSession('session-primary')).toBe(true);
    await coordinator.waitForIdle('session-primary');

    expect((await workRepository.getProjection('work-1')).sessions['session-primary']?.status)
      .toBe('idle');
    const transcript = await transcriptRepository.read('session-primary');
    expect(transcript.at(-1)?.entry).toMatchObject({
      role: 'assistant',
      content: 'This turn was stopped.',
    });
  });

  function createCoordinator(executor: V3PrimaryTurnExecutor): V3PrimaryTurnCoordinator {
    return new V3PrimaryTurnCoordinator({
      companyRepository,
      workRepository,
      transcriptRepository,
      executor,
      clock: () => NOW,
      idFactory: (() => {
        let value = 0;
        return () => `event-${++value}`;
      })(),
    });
  }

  async function appendUserMessage(id: string, content: string): Promise<void> {
    const records = await transcriptRepository.read('session-primary');
    const record = await transcriptRepository.append(
      'session-primary',
      { kind: 'message', id, role: 'user', content },
      { expectedSequence: records.at(-1)?.sequence ?? 0, entryId: id, occurredAt: NOW },
    );
    const projection = await workRepository.getProjection('work-1');
    await workRepository.updateSession(
      'work-1',
      'session-primary',
      { transcriptRevision: record.sequence },
      {
        expectedRevision: projection.revision,
        eventId: `sync-${id}`,
        occurredAt: NOW,
      },
    );
  }
});

class RecordingExecutor implements V3PrimaryTurnExecutor {
  readonly inputs: V3PrimaryTurnInput[] = [];

  constructor(
    private readonly implementation: (
      input: V3PrimaryTurnInput,
    ) => Promise<V3PrimaryTurnResult>,
  ) {}

  async executePrimaryTurn(input: V3PrimaryTurnInput): Promise<V3PrimaryTurnResult> {
    this.inputs.push(input);
    return this.implementation(input);
  }
}

function success(
  input: V3PrimaryTurnInput,
  assistantText: string,
): V3PrimaryTurnResult {
  return {
    sessionId: input.session.id,
    agentId: input.agent.id,
    status: 'succeeded',
    done: true,
    assistantText,
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
    },
    turnCount: 1,
    toolCount: 0,
  };
}

async function seedPrimarySession(
  companyRepository: CompanyRepository,
  workRepository: WorkRepository,
): Promise<void> {
  const company = await companyRepository.bootstrapCompany(
    {
      id: 'company-1',
      name: 'AnoClaw',
      rootTeamId: 'team-root',
      mainAgentId: 'agent-main',
      membershipId: 'membership-main',
      defaultLocale: 'zh-CN',
    },
    { expectedRevision: 0, eventId: 'company-bootstrap', occurredAt: NOW },
  );
  await workRepository.createWork(
    {
      id: 'work-1',
      companyId: company.company.id,
      primarySessionId: 'session-primary',
      title: 'Plan',
      objective: 'Run the company',
      status: 'active',
    },
    { expectedRevision: 0, eventId: 'work-create', occurredAt: NOW },
  );
  const mainAgent = company.agents[company.company.mainAgentId]!;
  await workRepository.createSession(
    'work-1',
    {
      id: 'session-primary',
      kind: 'primary',
      agentId: mainAgent.id,
      status: 'idle',
      actorSnapshot: {
        agentId: mainAgent.id,
        name: mainAgent.name,
        teamId: company.company.rootTeamId,
        capabilities: [...mainAgent.capabilities],
        enabledSkills: [...mainAgent.enabledSkills],
        allowedTools: [...mainAgent.allowedTools],
      },
    },
    { expectedRevision: 1, eventId: 'session-create', occurredAt: NOW },
  );
}
