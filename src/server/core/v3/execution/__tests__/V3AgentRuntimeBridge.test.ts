import { describe, expect, it } from 'vitest';
import type { Agent as RuntimeAgent } from '../../../agent/Agent.js';
import type { SSEEvent } from '../../../../../shared/types/events.js';
import { SSEEventType } from '../../../../../shared/types/events.js';
import type {
  Agent as V3AgentSnapshot,
  Session,
  SessionTranscriptRecord,
  TranscriptMessage,
} from '../../../../../shared/types/v3/index.js';
import {
  V3AgentRuntimeBridge,
  buildV3PrimarySystemPrompt,
  type V3CredentialSource,
  type V3ExecutionSettings,
  type V3PrimaryTurnInput,
  type V3PrimaryWorkPacket,
  type V3RuntimeAgentRegistry,
  type V3ToolTranscriptCommitter,
  type V3ToolTranscriptSink,
  type V3TurnRunner,
  type V3TurnRunnerRequest,
} from '../V3AgentRuntimeBridge.js';

const API_KEY = 'sk-v3-secret-value';

class FakeRegistry implements V3RuntimeAgentRegistry {
  readonly agents = new Map<string, RuntimeAgent>();
  readonly registered: RuntimeAgent[] = [];
  readonly unregistered: string[] = [];

  agent(agentId: string): RuntimeAgent | undefined {
    return this.agents.get(agentId);
  }

  registerAgent(agent: RuntimeAgent): void {
    this.agents.set(agent.id, agent);
    this.registered.push(agent);
  }

  unregisterAgent(agentId: string): boolean {
    this.unregistered.push(agentId);
    return this.agents.delete(agentId);
  }
}

class FakeSettings implements V3ExecutionSettings {
  readonly requestedKeys: string[] = [];

  constructor(private readonly values: Record<string, unknown>) {}

  get<T>(key: string, defaultValue?: T): T {
    this.requestedKeys.push(key);
    return (this.values[key] ?? defaultValue) as T;
  }
}

class FakeCredentials implements V3CredentialSource {
  readonly loadedRefs: string[] = [];

  async load(credentialRef = 'local-llm') {
    this.loadedRefs.push(credentialRef);
    return {
      credentialRef,
      provider: 'credential-provider',
      apiUrl: 'https://credential.example.test',
      model: 'credential-model',
      contextWindow: 96_000,
      apiKey: API_KEY,
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
    };
  }
}

class RecordingRunner implements V3TurnRunner {
  readonly requests: V3TurnRunnerRequest[] = [];

  constructor(
    private readonly implementation: (
      request: V3TurnRunnerRequest,
    ) => AsyncIterable<SSEEvent>,
  ) {}

  runTurn(request: V3TurnRunnerRequest): AsyncIterable<SSEEvent> {
    this.requests.push(request);
    return this.implementation(request);
  }
}

describe('V3AgentRuntimeBridge', () => {
  it('treats a Done-only stream as success and uses the referenced v3 credential', async () => {
    const registry = new FakeRegistry();
    const executionSettings = settings();
    const credentials = new FakeCredentials();
    const runner = new RecordingRunner(() => eventStream([
      {
        type: SSEEventType.Done,
        turnCount: 2,
        tokenUsage: { total: 17 },
      },
    ]));
    const bridge = new V3AgentRuntimeBridge({
      runner,
      registry,
      settings: executionSettings,
      credentials,
    });
    const input = primaryTurnInput({
      transcript: [
        transcriptRecord('history-user', 'user', 'Earlier request', 1),
        transcriptRecord('history-tool', 'tool', 'Tool output', 2),
      ],
    });

    const result = await bridge.executePrimaryTurn(input);

    expect(result).toEqual({
      sessionId: 'session-primary',
      agentId: 'agent-main',
      status: 'succeeded',
      done: true,
      assistantText: '',
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 17,
      },
      turnCount: 2,
      toolCount: 0,
    });
    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0].message.role).toBe('user');
    expect(runner.requests[0].history.map((message) => message.role)).toEqual([
      'user',
      'tool',
    ]);
    expect(runner.requests[0].history.every((message) => Boolean(message.role))).toBe(true);

    const runtimeAgent = registry.registered[0];
    expect(runtimeAgent.id).toBe('v3-runtime:company-1:agent-main');
    expect(runtimeAgent.provider).toBe('credential-provider');
    expect(runtimeAgent.apiUrl).toBe('https://credential.example.test');
    expect(runtimeAgent.apiKey).toBe(API_KEY);
    expect(runtimeAgent.modelName).toBe('credential-model');
    expect(runtimeAgent.contextWindow).toBe(96_000);
    expect(runtimeAgent.allowedTools()).toEqual(['Read', 'TaskCreate']);
    expect(registry.unregistered).toEqual([runtimeAgent.id]);
    expect(credentials.loadedRefs).toEqual(['local-llm']);
    expect(executionSettings.requestedKeys).not.toContain('llm.apiKey');

    const loggableResult = JSON.stringify(result);
    expect(loggableResult).not.toContain(API_KEY);
    expect(loggableResult).not.toContain('apiKey');
  });

  it('uses only non-secret SettingsManager fallbacks when no credential exists', async () => {
    const registry = new FakeRegistry();
    const executionSettings = settings();
    const bridge = new V3AgentRuntimeBridge({
      runner: new RecordingRunner(() => eventStream([
        { type: SSEEventType.Done },
      ])),
      registry,
      settings: executionSettings,
      credentials: {
        async load() {
          return null;
        },
      },
    });

    const result = await bridge.executePrimaryTurn(primaryTurnInput());

    const runtimeAgent = registry.registered[0];
    expect(result.status).toBe('succeeded');
    expect(runtimeAgent.provider).toBe('settings-provider');
    expect(runtimeAgent.apiUrl).toBe('https://llm.example.test');
    expect(runtimeAgent.modelName).toBe('settings-model');
    expect(runtimeAgent.contextWindow).toBe(64_000);
    expect(runtimeAgent.apiKey).toBe('');
    expect(executionSettings.requestedKeys).not.toContain('llm.apiKey');
  });

  it('captures an error event and redacts the configured API key', async () => {
    const runner = new RecordingRunner(() => eventStream([
      { type: SSEEventType.Text, content: `partial ${API_KEY}` },
      {
        type: SSEEventType.Error,
        errorMessage: `provider failed with ${API_KEY}`,
      },
    ]));
    const bridge = new V3AgentRuntimeBridge({
      runner,
      registry: new FakeRegistry(),
      settings: settings(),
      credentials: new FakeCredentials(),
    });

    const result = await bridge.executePrimaryTurn(primaryTurnInput());

    expect(result.status).toBe('failed');
    expect(result.done).toBe(false);
    expect(result.assistantText).toBe('partial [REDACTED]');
    expect(result.error).toBe('provider failed with [REDACTED]');
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it('returns cancelled when the supplied AbortSignal stops a fake runner', async () => {
    const started = deferred<void>();
    const runner = new RecordingRunner((request) => ({
      async *[Symbol.asyncIterator](): AsyncIterator<SSEEvent> {
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
    }));
    const registry = new FakeRegistry();
    const bridge = new V3AgentRuntimeBridge({
      runner,
      registry,
      settings: settings(),
      credentials: new FakeCredentials(),
    });
    const controller = new AbortController();

    const resultPromise = bridge.executePrimaryTurn(primaryTurnInput({
      signal: controller.signal,
    }));
    await started.promise;
    controller.abort();
    const result = await resultPromise;

    expect(result.status).toBe('cancelled');
    expect(result.done).toBe(false);
    expect(result.error).toBe('Turn cancelled');
    expect(registry.unregistered).toHaveLength(1);
  });

  it('commits a tool journal only after the role-bearing tool message is durable', async () => {
    const order: string[] = [];
    const persisted: TranscriptMessage[] = [];
    const sink: V3ToolTranscriptSink = {
      async persistToolMessage(_sessionId, message) {
        order.push('persist');
        persisted.push(message);
      },
    };
    const committer: V3ToolTranscriptCommitter = {
      async markTranscriptCommitted() {
        order.push('commit');
      },
    };
    const runner = new RecordingRunner(() => eventStream([
      {
        type: SSEEventType.ToolResult,
        toolCallId: 'call-1',
        toolName: 'Read',
        content: 'contents',
        success: true,
      },
      { type: SSEEventType.Done },
    ]));
    const bridge = new V3AgentRuntimeBridge({
      runner,
      registry: new FakeRegistry(),
      settings: settings(),
      credentials: new FakeCredentials(),
      transcriptSink: sink,
      toolTranscriptCommitter: committer,
    });

    const result = await bridge.executePrimaryTurn(primaryTurnInput());

    expect(result.status).toBe('succeeded');
    expect(result.toolCount).toBe(1);
    expect(order).toEqual(['persist', 'commit']);
    expect(persisted).toEqual([{
      kind: 'message',
      id: 'tool-result-call-1',
      role: 'tool',
      content: 'contents',
      agentId: 'agent-main',
      toolCallId: 'call-1',
      toolName: 'Read',
    }]);
  });

  it('leaves a newly registered bridge Agent in memory while it is still serving', async () => {
    const registry = new FakeRegistry();
    const runner = new RecordingRunner((request) => ({
      async *[Symbol.asyncIterator](): AsyncIterator<SSEEvent> {
        registry.agent(request.runtimeAgentId)?.adjustSessionCount(1);
        yield { type: SSEEventType.Done };
      },
    }));
    const bridge = new V3AgentRuntimeBridge({
      runner,
      registry,
      settings: settings(),
      credentials: new FakeCredentials(),
    });

    const result = await bridge.executePrimaryTurn(primaryTurnInput());

    expect(result.status).toBe('succeeded');
    expect(registry.unregistered).toEqual([]);
    expect(registry.agent('v3-runtime:company-1:agent-main')).toBeDefined();
  });

  it('builds a MainAgent prompt with an autonomous persistent Team boundary', () => {
    const agent = v3Agent({
      instructions: 'Use the supplied evidence and be concise.',
    });
    const packet = workPacket();

    const prompt = buildV3PrimarySystemPrompt(agent, packet);

    expect(prompt).toContain('MainAgent coordinator');
    expect(prompt).toContain('current organizational home');
    expect(prompt).toContain('pass that Team id to MissionCreate');
    expect(prompt).toContain('Collaborate exclusively through persistent Teams');
    expect(prompt).toContain('Users normally talk only to MainAgent');
    expect(prompt).toContain('run them in parallel');
    expect(prompt).toContain('"objective": "Ship the v3 bridge"');
    expect(prompt).not.toContain('HireEmployee');
    expect(prompt).not.toContain('SubAgentSpawn');
    expect(prompt).not.toContain('UpdateOrg');
  });
});

function settings(): FakeSettings {
  return new FakeSettings({
    'llm.provider': 'settings-provider',
    'llm.apiUrl': 'https://llm.example.test',
    'llm.apiKey': API_KEY,
    'llm.model': 'settings-model',
    'llm.contextWindow': 64_000,
    'llm.maxTokens': 64_000,
    'llm.temperature': 0.4,
    'agent.maxTurns': 8,
  });
}

function primaryTurnInput(
  overrides: Partial<V3PrimaryTurnInput> = {},
): V3PrimaryTurnInput {
  const agent = overrides.agent ?? v3Agent();
  return {
    session: overrides.session ?? v3Session(agent),
    agent,
    content: overrides.content ?? 'Implement the bridge',
    packet: overrides.packet ?? workPacket(),
    transcript: overrides.transcript ?? [],
    messageId: overrides.messageId ?? 'message-current',
    signal: overrides.signal,
    permissionMode: overrides.permissionMode,
    effort: overrides.effort,
  };
}

function v3Agent(
  overrides: Partial<V3AgentSnapshot> = {},
): V3AgentSnapshot {
  return {
    id: 'agent-main',
    companyId: 'company-1',
    name: 'Coordinator',
    status: 'active',
    capabilities: ['coordination'],
    enabledSkills: ['verification-before-completion'],
    allowedTools: [
      'Read',
      'TaskCreate',
      'HireEmployee',
      'SubAgentSpawn',
      'UpdateOrg',
    ],
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    ...overrides,
  };
}

function v3Session(agent: V3AgentSnapshot): Session {
  return {
    id: 'session-primary',
    workId: 'work-1',
    kind: 'primary',
    agentId: agent.id,
    actorSnapshot: {
      agentId: agent.id,
      name: agent.name,
      instructions: 'stale session snapshot must not be authoritative',
      provider: 'stale-provider',
      model: 'stale-model',
      capabilities: [],
      enabledSkills: [],
      allowedTools: [],
    },
    status: 'active',
    transcriptRevision: 0,
    createdAt: '2026-07-25T00:00:00.000Z',
  };
}

function workPacket(): V3PrimaryWorkPacket {
  return {
    company: {
      id: 'company-1',
      name: 'AnoClaw',
    },
    work: {
      id: 'work-1',
      title: 'V3 execution',
      objective: 'Ship the v3 bridge',
      status: 'active',
    },
    mission: {
      id: 'mission-1',
      title: 'Bridge runtime',
      objective: 'Execute one primary turn',
      acceptanceCriteria: ['Done is terminal'],
      priority: 'high',
      status: 'active',
    },
    task: {
      id: 'task-1',
      title: 'Implement',
      acceptanceCriteria: ['Tests pass'],
      priority: 'high',
      status: 'running',
      dependsOnTaskIds: [],
      readOnly: false,
      writeScope: ['src/server/core/v3/execution'],
    },
    team: {
      id: 'team-root',
      name: 'Core Team',
      members: [{
        agentId: 'agent-main',
        name: 'Coordinator',
        membershipRole: 'leader',
        capabilities: ['coordination'],
      }],
    },
  };
}

function transcriptRecord(
  id: string,
  role: TranscriptMessage['role'],
  content: string,
  sequence: number,
): SessionTranscriptRecord {
  return {
    schemaVersion: 3,
    sessionId: 'session-primary',
    sequence,
    entryId: id,
    occurredAt: `2026-07-25T00:00:0${sequence}.000Z`,
    entry: {
      kind: 'message',
      id,
      role,
      content,
    },
  };
}

async function* eventStream(events: readonly SSEEvent[]): AsyncIterable<SSEEvent> {
  for (const event of events) yield event;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
