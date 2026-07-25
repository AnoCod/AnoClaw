import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent as RuntimeAgent } from '../../../agent/Agent.js';
import type { SSEEvent } from '../../../../../shared/types/events.js';
import { SSEEventType } from '../../../../../shared/types/events.js';
import type {
  Agent,
  CompanyProjection,
  CoordinationMessage,
  Mission,
  Run,
  Session,
  SessionTranscriptRecord,
  Task,
  Work,
  WorkProjection,
} from '../../../../../shared/types/v3/index.js';
import type {
  V3RuntimeAgentRegistry,
  V3TurnRunner,
  V3TurnRunnerRequest,
} from '../../execution/V3AgentRuntimeBridge.js';
import { SessionTranscriptRepository } from '../../store/SessionTranscriptRepository.js';
import type { V3AgentTurnRequest } from '../V3RunExecutor.js';
import { V3RunAgentTurnExecutor } from '../V3RunAgentTurnExecutor.js';

const temporaryRoots: string[] = [];
const API_KEY = 'sk-run-secret';

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => (
    fsp.rm(root, { recursive: true, force: true })
  )));
});

class FakeRegistry implements V3RuntimeAgentRegistry {
  readonly agents = new Map<string, RuntimeAgent>();
  readonly unregistered: string[] = [];

  agent(agentId: string): RuntimeAgent | undefined {
    return this.agents.get(agentId);
  }

  registerAgent(agent: RuntimeAgent): void {
    this.agents.set(agent.id, agent);
  }

  unregisterAgent(agentId: string): boolean {
    this.unregistered.push(agentId);
    return this.agents.delete(agentId);
  }
}

class FakeRunner implements V3TurnRunner {
  readonly requests: V3TurnRunnerRequest[] = [];

  constructor(private readonly events: SSEEvent[]) {}

  runTurn(request: V3TurnRunnerRequest): AsyncIterable<SSEEvent> {
    this.requests.push(request);
    return eventStream(this.events);
  }
}

class FakeWorkRepository {
  readonly projection: WorkProjection;

  constructor(session: Session) {
    this.projection = {
      work: work(),
      missions: { 'mission-1': mission() },
      tasks: {
        'task-dependency': {
          ...task(),
          id: 'task-dependency',
          title: 'Dependency',
          status: 'completed',
          dependsOnTaskIds: [],
        },
        'task-1': task(),
      },
      runs: { 'run-1': run() },
      sessions: { [session.id]: session },
      taskReports: {
        'report-dependency': {
          id: 'report-dependency',
          taskId: 'task-dependency',
          runId: 'run-dependency',
          agentId: 'agent-other',
          outcome: 'completed',
          summary: 'Dependency evidence',
          artifacts: ['docs/dependency.md'],
          createdAt: '2026-07-25T00:00:00.000Z',
        },
      },
      coordinationMessages: {},
      coordinationMessageOrder: [],
      workspaceLeases: {},
      orchestrationDecisions: {},
      verificationRecords: {},
      toolCallJournal: {},
      revision: 10,
      updatedAt: '2026-07-25T00:00:00.000Z',
    };
  }

  async getProjection(): Promise<WorkProjection> {
    return this.projection;
  }

  async updateSession(
    _workId: string,
    sessionId: string,
    update: { transcriptRevision?: number; status?: Session['status']; closedAt?: string },
    options: { expectedRevision: number },
  ): Promise<Session> {
    expect(options.expectedRevision).toBe(this.projection.revision);
    const current = this.projection.sessions[sessionId];
    if (!current) throw new Error('missing session');
    const next = { ...current, ...update };
    this.projection.sessions[sessionId] = next;
    this.projection.revision += 1;
    return next;
  }

  async transitionCoordinationMessage(
    _workId: string,
    messageId: string,
    nextStatus: CoordinationMessage['status'],
    input: {
      consumingTurnId?: string;
      recipientSessionId?: string;
      error?: string;
    },
    options: { expectedRevision: number },
  ): Promise<CoordinationMessage> {
    expect(options.expectedRevision).toBe(this.projection.revision);
    const current = this.projection.coordinationMessages[messageId];
    if (!current) throw new Error('missing coordination message');
    const next: CoordinationMessage = {
      ...current,
      status: nextStatus,
      ...(input.recipientSessionId
        ? { recipientSessionId: input.recipientSessionId }
        : {}),
      ...(input.consumingTurnId
        ? { consumingTurnId: input.consumingTurnId }
        : {}),
      ...(input.error ? { lastError: input.error } : {}),
    };
    if (nextStatus === 'delivered') {
      next.deliveryAttempts += 1;
      delete next.consumingTurnId;
      delete next.consumedAt;
    }
    this.projection.coordinationMessages[messageId] = next;
    this.projection.revision += 1;
    return next;
  }
}

describe('V3RunAgentTurnExecutor', () => {
  it('durably maps a run TaskPacket, tool exchange, and real Done into a report', async () => {
    const root = await temporaryRoot();
    const transcriptRepository = new SessionTranscriptRepository(root, {
      clock: () => '2026-07-25T00:00:10.000Z',
    });
    const session = runSession();
    await transcriptRepository.append(
      session.id,
      {
        kind: 'message',
        id: 'old-tool-call',
        role: 'assistant',
        content: '',
        toolCallId: 'old-call',
        toolName: 'Read',
        metadata: {
          toolCalls: [{ id: 'old-call', toolName: 'Read' }],
        },
      },
      { expectedSequence: 0 },
    );
    await transcriptRepository.append(
      session.id,
      {
        kind: 'message',
        id: 'old-tool-result',
        role: 'tool',
        content: 'Earlier evidence',
        toolCallId: 'old-call',
        toolName: 'Read',
      },
      { expectedSequence: 1 },
    );
    session.transcriptRevision = 2;

    const runner = new FakeRunner([
      {
        type: SSEEventType.ToolCall,
        toolCallId: 'call-1',
        toolName: 'Read',
        turnCount: 1,
      },
      {
        type: SSEEventType.ToolResult,
        toolCallId: 'call-1',
        toolName: 'Read',
        content: 'Verified output',
        success: true,
        structured: { path: 'docs/result.md' },
        turnCount: 1,
      },
      {
        type: SSEEventType.Text,
        content: `Completed with evidence. ${API_KEY}`,
        turnCount: 2,
      },
      {
        type: SSEEventType.Done,
        turnCount: 2,
        tokenUsage: {
          systemPrompt: 10,
          systemTools: 5,
          skills: 2,
          messages: 3,
          total: 24,
        },
      },
    ]);
    const registry = new FakeRegistry();
    const committer = { markTranscriptCommitted: vi.fn(async () => {}) };
    const workRepository = new FakeWorkRepository(session);
    const executor = new V3RunAgentTurnExecutor({
      workRepository,
      companyRepository: { getProjection: async () => company() },
      transcriptRepository,
      runner,
      registry,
      settings: {
        get<T>(key: string, fallback?: T): T {
          const values: Record<string, unknown> = {
            'llm.provider': 'provider',
            'llm.apiUrl': 'https://example.test',
            'llm.model': 'model',
            'llm.contextWindow': 64_000,
            'llm.temperature': 0.3,
          };
          return (values[key] ?? fallback) as T;
        },
      },
      credentials: {
        async load() {
          return {
            credentialRef: 'local-llm',
            provider: 'provider',
            apiUrl: 'https://example.test',
            model: 'model',
            contextWindow: 64_000,
            apiKey: API_KEY,
            createdAt: '2026-07-25T00:00:00.000Z',
            updatedAt: '2026-07-25T00:00:00.000Z',
          };
        },
      },
      toolTranscriptCommitter: committer,
      clock: () => '2026-07-25T00:00:10.000Z',
    });
    const heartbeat = vi.fn();

    const result = await executor.execute(request({ session, onHeartbeat: heartbeat }));

    expect(result).toMatchObject({
      type: 'done',
      turnsConsumed: 2,
      toolCount: 1,
      lastCompletedToolCallId: 'call-1',
      tokenUsage: {
        inputTokens: 20,
        totalTokens: 24,
      },
      report: {
        outcome: 'submitted',
        summary: 'Completed with evidence. [REDACTED]',
        artifacts: ['docs/result.md'],
      },
    });
    expect(committer.markTranscriptCommitted).toHaveBeenCalledWith(
      'session-run-1',
      'call-1',
    );
    expect(heartbeat).toHaveBeenCalled();

    const runtimeRequest = runner.requests[0];
    expect(runtimeRequest.options.permissionMode).toBe('AutoEdit');
    expect(runtimeRequest.options.workspace).toBe('C:\\workspace');
    expect(runtimeRequest.message.role).toBe('user');
    expect(runtimeRequest.history.every((message) => Boolean(message.role))).toBe(true);
    expect(runtimeRequest.history).toHaveLength(1);
    expect(runtimeRequest.history[0]).toMatchObject({
      role: 'assistant',
      toolCalls: [{ id: 'old-call', toolName: 'Read', params: {} }],
      toolResults: [{ toolCallId: 'old-call', content: 'Earlier evidence' }],
    });

    const transcript = await transcriptRepository.read(session.id);
    expect(transcript.map((record) => (
      record.entry.kind === 'message' ? record.entry.role : 'event'
    ))).toEqual([
      'assistant',
      'tool',
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(JSON.stringify(transcript)).not.toContain(API_KEY);
    expect(workRepository.projection.sessions[session.id]?.transcriptRevision).toBe(6);
    expect(registry.unregistered).toHaveLength(1);
  });

  it('maps an explicit max-turn termination without submitting a report', async () => {
    const root = await temporaryRoot();
    const session = runSession();
    const executor = new V3RunAgentTurnExecutor({
      workRepository: new FakeWorkRepository(session),
      companyRepository: { getProjection: async () => company() },
      transcriptRepository: new SessionTranscriptRepository(root),
      runner: new FakeRunner([
        { type: SSEEventType.Text, content: 'Partial answer', turnCount: 4 },
        {
          type: SSEEventType.Done,
          turnCount: 4,
          maxTurnsReached: true,
          terminationReason: 'max_turns',
        },
      ]),
      registry: new FakeRegistry(),
      settings: { get: <T>(_key: string, fallback?: T) => fallback as T },
      credentials: { load: async () => null },
    });
    const value = request({ session });
    value.run.maxTurns = 4;

    await expect(executor.execute(value)).resolves.toMatchObject({
      type: 'max_turns',
      turnsConsumed: 4,
    });
    const transcript = await executorTranscript(root, session.id);
    expect(transcript.some((record) => (
      record.entry.kind === 'message'
      && record.entry.id.endsWith('assistant-result')
    ))).toBe(false);
  });

  it('maps aborts and streams ending without Done to non-success terminal results', async () => {
    const interruptedRoot = await temporaryRoot();
    const interruptedSession = runSession();
    const interrupted = new V3RunAgentTurnExecutor({
      workRepository: new FakeWorkRepository(interruptedSession),
      companyRepository: { getProjection: async () => company() },
      transcriptRepository: new SessionTranscriptRepository(interruptedRoot),
      runner: new FakeRunner([{ type: SSEEventType.Text, content: 'partial' }]),
      registry: new FakeRegistry(),
      settings: { get: <T>(_key: string, fallback?: T) => fallback as T },
      credentials: { load: async () => null },
    });
    await expect(interrupted.execute(request({ session: interruptedSession })))
      .resolves.toMatchObject({ type: 'interrupted' });

    const cancelledRoot = await temporaryRoot();
    const cancelledSession = runSession();
    const controller = new AbortController();
    controller.abort();
    const cancelled = new V3RunAgentTurnExecutor({
      workRepository: new FakeWorkRepository(cancelledSession),
      companyRepository: { getProjection: async () => company() },
      transcriptRepository: new SessionTranscriptRepository(cancelledRoot),
      runner: new FakeRunner([{ type: SSEEventType.Done }]),
      registry: new FakeRegistry(),
      settings: { get: <T>(_key: string, fallback?: T) => fallback as T },
      credentials: { load: async () => null },
    });
    await expect(cancelled.execute(request({
      session: cancelledSession,
      signal: controller.signal,
    }))).resolves.toMatchObject({ type: 'cancelled' });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-v3-run-turn-'));
  temporaryRoots.push(root);
  return root;
}

async function executorTranscript(
  root: string,
  sessionId: string,
): Promise<SessionTranscriptRecord[]> {
  return new SessionTranscriptRepository(root).read(sessionId);
}

async function* eventStream(events: SSEEvent[]): AsyncIterable<SSEEvent> {
  for (const event of events) yield event;
}

function request(
  overrides: {
    session?: Session;
    signal?: AbortSignal;
    onHeartbeat?: V3AgentTurnRequest['onHeartbeat'];
  } = {},
): V3AgentTurnRequest {
  return {
    work: work(),
    mission: mission(),
    task: task(),
    run: run(),
    session: overrides.session ?? runSession(),
    agent: agent(),
    signal: overrides.signal ?? new AbortController().signal,
    recovering: false,
    onHeartbeat: overrides.onHeartbeat ?? (() => {}),
  };
}

function work(): Work {
  return {
    id: 'work-1',
    companyId: 'company-1',
    workspaceId: 'workspace-1',
    primarySessionId: 'session-primary',
    title: 'Ship release',
    objective: 'Deliver the product',
    status: 'active',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

function mission(): Mission {
  return {
    id: 'mission-1',
    workId: 'work-1',
    title: 'Implementation',
    objective: 'Implement and verify',
    acceptanceCriteria: ['Tests pass'],
    priority: 'high',
    verificationPolicy: {
      mode: 'automatic',
      requireDifferentAgent: false,
      maxRevisionAttempts: 2,
      requiredEvidence: [],
    },
    status: 'active',
    teamId: 'team-1',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

function task(): Task {
  return {
    id: 'task-1',
    workId: 'work-1',
    missionId: 'mission-1',
    title: 'Implement adapter',
    description: 'Connect the existing engine',
    acceptanceCriteria: ['Focused tests pass'],
    status: 'running',
    priority: 'high',
    teamId: 'team-1',
    assignedAgentId: 'agent-1',
    dependsOnTaskIds: ['task-dependency'],
    readOnly: false,
    writeScope: ['src/server'],
    version: 2,
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

function run(): Run {
  return {
    id: 'run-1',
    workId: 'work-1',
    missionId: 'mission-1',
    taskId: 'task-1',
    agentId: 'agent-1',
    sessionId: 'session-run-1',
    status: 'running',
    attempt: 1,
    maxTurns: 8,
    turnsConsumed: 0,
    fencingToken: 1,
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    },
    cost: { currency: 'USD', amount: 0, estimated: true },
    toolCount: 0,
    workspaceExecution: {
      mode: 'lease',
      workspaceId: 'workspace-1',
      leaseIds: ['lease-1'],
      writeScope: ['src/server'],
    },
    createdAt: '2026-07-25T00:00:00.000Z',
    startedAt: '2026-07-25T00:00:01.000Z',
  };
}

function runSession(): Session {
  return {
    id: 'session-run-1',
    workId: 'work-1',
    kind: 'run',
    missionId: 'mission-1',
    taskId: 'task-1',
    runId: 'run-1',
    parentSessionId: 'session-primary',
    agentId: 'agent-1',
    actorSnapshot: {
      agentId: 'agent-1',
      name: 'Worker',
      teamId: 'team-1',
      capabilities: ['implementation'],
      enabledSkills: [],
      allowedTools: ['Read'],
    },
    status: 'active',
    transcriptRevision: 0,
    createdAt: '2026-07-25T00:00:00.000Z',
  };
}

function agent(): Agent {
  return {
    id: 'agent-1',
    companyId: 'company-1',
    name: 'Worker',
    instructions: 'Implement carefully.',
    status: 'active',
    provider: 'provider',
    model: 'model',
    credentialRef: 'local-llm',
    capabilities: ['implementation'],
    enabledSkills: [],
    allowedTools: ['Read'],
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

function company(): CompanyProjection {
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
    workspaces: {
      'workspace-1': {
        id: 'workspace-1',
        companyId: 'company-1',
        name: 'Workspace',
        rootPath: 'C:\\workspace',
        createdAt: '2026-07-25T00:00:00.000Z',
        updatedAt: '2026-07-25T00:00:00.000Z',
      },
    },
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
      'membership-1': {
        id: 'membership-1',
        companyId: 'company-1',
        teamId: 'team-1',
        agentId: 'agent-1',
        role: 'member',
        isPrimary: true,
        createdAt: '2026-07-25T00:00:00.000Z',
        updatedAt: '2026-07-25T00:00:00.000Z',
      },
    },
    agents: { 'agent-1': agent() },
    revision: 1,
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}
