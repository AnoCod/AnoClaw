import { createHash, randomUUID } from 'node:crypto';
import { Agent as RuntimeAgent } from '../../agent/Agent.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import type { ProcessMessageOptions } from '../../agent/AgentRuntime.js';
import { AgentRuntime } from '../../agent/AgentRuntime.js';
import { InterruptController, InterruptReason } from '../../agent/supervision/InterruptController.js';
import type { AgentConfigWithKey } from '../../agent/AgentConfig.js';
import { SettingsManager } from '../../../infra/storage/SettingsManager.js';
import { ToolRegistry } from '../../tools/ToolRegistry.js';
import type { SSEEvent } from '../../../../shared/types/events.js';
import { SSEEventType } from '../../../../shared/types/events.js';
import type { Message } from '../../../../shared/types/session.js';
import { MessageRole } from '../../../../shared/types/session.js';
import { AgentRole, AgentState } from '../../../../shared/types/agent.js';
import type {
  Agent as V3AgentSnapshot,
  Mission,
  Session,
  SessionTranscriptRecord,
  Task,
  TeamMembershipRole,
  TokenUsage,
  TranscriptMessage,
  Work,
} from '../../../../shared/types/v3/index.js';
import { V3ToolExecutionRegistry } from '../runtime/V3ToolExecutionRegistry.js';
import {
  LocalCredentialStore,
  type LocalLlmCredential,
} from '../security/LocalCredentialStore.js';

const RUNTIME_AGENT_PREFIX = 'v3-runtime:';
const LEGACY_ORG_TOOL_NAMES = new Set([
  'hireemployee',
  'listemployees',
  'subagentspawn',
  'updateorg',
]);
const LEGACY_ORG_TOOL_WORDING = /HireEmployee|ListEmployees|SubAgentSpawn|UpdateOrg/gi;

export interface V3TeamMemberPacket {
  agentId: string;
  name: string;
  membershipRole: TeamMembershipRole;
  capabilities?: readonly string[];
}

export interface V3TeamPacket {
  id: string;
  name: string;
  description?: string;
  members: readonly V3TeamMemberPacket[];
}

/**
 * Explicit execution context supplied by the v3 orchestration/application
 * layer. The bridge deliberately does not discover any of this from v2 state.
 */
export interface V3PrimaryWorkPacket {
  company?: {
    id: string;
    name: string;
    description?: string;
  };
  work: Pick<Work, 'id' | 'title' | 'objective' | 'status'>;
  mission?: Pick<
    Mission,
    'id' | 'title' | 'objective' | 'acceptanceCriteria' | 'priority' | 'status'
  >;
  task?: Pick<
    Task,
    | 'id'
    | 'title'
    | 'description'
    | 'acceptanceCriteria'
    | 'priority'
    | 'status'
    | 'dependsOnTaskIds'
    | 'readOnly'
    | 'writeScope'
  >;
  team: V3TeamPacket;
}

export interface V3PrimaryTurnInput {
  session: Session;
  agent: V3AgentSnapshot;
  content: string;
  packet: V3PrimaryWorkPacket;
  workspaceRoot?: string;
  transcript?: readonly SessionTranscriptRecord[];
  messageId?: string;
  signal?: AbortSignal;
  permissionMode?: string;
  effort?: string;
}

export interface V3TurnRunnerRequest {
  sessionId: string;
  runtimeAgentId: string;
  message: Message;
  history: Message[];
  options: ProcessMessageOptions;
  signal?: AbortSignal;
}

/** Injectable seam used by unit tests and future execution backends. */
export interface V3TurnRunner {
  runTurn(request: V3TurnRunnerRequest): AsyncIterable<SSEEvent>;
}

export interface V3ToolTranscriptSink {
  /**
   * Resolve only after the tool message is durable. The bridge advances the
   * v3 tool journal to transcript_committed after this promise resolves.
   */
  persistToolMessage(sessionId: string, message: TranscriptMessage): Promise<void>;
}

export interface V3ToolTranscriptCommitter {
  markTranscriptCommitted(sessionId: string, toolCallId: string): Promise<void>;
}

export interface V3PrimaryTurnResult {
  sessionId: string;
  agentId: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  done: boolean;
  assistantText: string;
  tokenUsage: TokenUsage;
  turnCount: number;
  toolCount: number;
  error?: string;
}

export interface V3ExecutionSettings {
  get<T>(key: string, defaultValue?: T): T;
}

export interface V3CredentialSource {
  load(credentialRef?: string): Promise<LocalLlmCredential | null>;
}

export interface V3RuntimeAgentRegistry {
  agent(agentId: string): RuntimeAgent | undefined;
  registerAgent(agent: RuntimeAgent): void;
  unregisterAgent(agentId: string): boolean;
}

export interface V3AgentRuntimeBridgeOptions {
  runner: V3TurnRunner;
  registry?: V3RuntimeAgentRegistry;
  settings?: V3ExecutionSettings;
  credentials?: V3CredentialSource;
  transcriptSink?: V3ToolTranscriptSink;
  toolTranscriptCommitter?: V3ToolTranscriptCommitter;
}

interface ManagedRuntimeAgent {
  agent: RuntimeAgent;
  activeTurns: number;
  configFingerprint: string;
}

const managedAgentsByRegistry = new WeakMap<
  object,
  Map<string, ManagedRuntimeAgent>
>();

/**
 * Production runner for the existing v2 Agent engine.
 *
 * Cancellation is adapted to the engine's session-scoped InterruptController.
 * The short retry timer covers the small interval before processMessage has
 * installed its internal AbortController.
 */
export class AgentRuntimeV3TurnRunner implements V3TurnRunner {
  constructor(
    private readonly runtime: AgentRuntime = AgentRuntime.getInstance(),
    private readonly interrupts: InterruptController = InterruptController.getInstance(),
  ) {}

  async *runTurn(request: V3TurnRunnerRequest): AsyncIterable<SSEEvent> {
    if (request.signal?.aborted) return;

    let interruptRetry: ReturnType<typeof setInterval> | undefined;
    const forwardCancellation = (): void => {
      this.interrupts.requestInterrupt(request.sessionId, InterruptReason.UserStop);
      if (interruptRetry) return;
      interruptRetry = setInterval(() => {
        if (!request.signal?.aborted) return;
        this.interrupts.requestInterrupt(request.sessionId, InterruptReason.UserStop);
      }, 25);
      interruptRetry.unref?.();
    };

    request.signal?.addEventListener('abort', forwardCancellation, { once: true });
    try {
      for await (const event of this.runtime.processMessage(
        request.sessionId,
        request.runtimeAgentId,
        request.message,
        request.history,
        request.options,
      )) {
        if (request.signal?.aborted) {
          this.interrupts.requestInterrupt(request.sessionId, InterruptReason.UserStop);
        }
        yield event;
      }
    } finally {
      request.signal?.removeEventListener('abort', forwardCancellation);
      if (interruptRetry) clearInterval(interruptRetry);
    }
  }
}

/**
 * Isolated adapter from persistent v3 Agent/Session snapshots to the existing
 * in-process Agent engine. It never loads or saves v2 AgentConfig JSON.
 */
export class V3AgentRuntimeBridge {
  private readonly runner: V3TurnRunner;
  private readonly registry: V3RuntimeAgentRegistry;
  private readonly settings: V3ExecutionSettings;
  private readonly credentials: V3CredentialSource;
  private readonly transcriptSink?: V3ToolTranscriptSink;
  private readonly toolTranscriptCommitter: V3ToolTranscriptCommitter;

  constructor(options: V3AgentRuntimeBridgeOptions) {
    this.runner = options.runner;
    this.registry = options.registry ?? AgentRegistry.getInstance();
    this.settings = options.settings ?? SettingsManager.getInstance();
    this.credentials = options.credentials ?? new LocalCredentialStore();
    this.transcriptSink = options.transcriptSink;
    this.toolTranscriptCommitter = options.toolTranscriptCommitter
      ?? V3ToolExecutionRegistry.getInstance();
  }

  /** Create a bridge wired to AgentRuntime.processMessage. */
  static production(
    options: Omit<V3AgentRuntimeBridgeOptions, 'runner'> = {},
  ): V3AgentRuntimeBridge {
    return new V3AgentRuntimeBridge({
      ...options,
      runner: new AgentRuntimeV3TurnRunner(),
    });
  }

  async executePrimaryTurn(input: V3PrimaryTurnInput): Promise<V3PrimaryTurnResult> {
    this.assertInput(input);
    const emptyUsage = createEmptyTokenUsage();
    if (input.signal?.aborted) {
      return {
        sessionId: input.session.id,
        agentId: input.agent.id,
        status: 'cancelled',
        done: false,
        assistantText: '',
        tokenUsage: emptyUsage,
        turnCount: 0,
        toolCount: 0,
        error: 'Turn cancelled',
      };
    }

    const runtimeAgentId = runtimeAgentIdFor(input.agent);
    const config = await this.buildRuntimeConfig(input, runtimeAgentId);
    const secrets = [config.apiKey];
    const messageId = input.messageId?.trim() || randomUUID();
    const message = buildRuntimeUserMessage(
      input.session.id,
      input.content,
      messageId,
      input.agent,
    );
    const history = buildRuntimeHistory(
      input.session,
      input.transcript ?? [],
    ).filter((entry) => entry.id !== message.id);
    const options: ProcessMessageOptions = {
      permissionMode: input.permissionMode,
      effort: input.effort,
      skipTaskResolution: true,
      systemPromptOverride: buildV3PrimarySystemPrompt(input.agent, input.packet),
      ...(input.workspaceRoot ? { workspace: input.workspaceRoot } : {}),
    };
    const managed = this.acquireRuntimeAgent(config);

    let assistantText = '';
    let done = false;
    let failure = '';
    let cancelledByAbort = false;
    let tokenUsage = emptyUsage;
    let turnCount = 0;
    const toolCallIds = new Set<string>();

    try {
      for await (const event of this.runner.runTurn({
        sessionId: input.session.id,
        runtimeAgentId,
        message,
        history,
        options,
        signal: input.signal,
      })) {
        if (event.type === SSEEventType.Text) {
          assistantText += stringEventField(event, 'content');
        } else if (event.type === SSEEventType.ToolCall) {
          const toolCallId = stringEventField(event, 'toolCallId');
          if (toolCallId) toolCallIds.add(toolCallId);
        } else if (event.type === SSEEventType.ToolResult) {
          const toolCallId = stringEventField(event, 'toolCallId');
          if (toolCallId) {
            toolCallIds.add(toolCallId);
            await this.persistToolResult(input, event, toolCallId, secrets);
          }
        } else if (event.type === SSEEventType.Error) {
          failure = stringEventField(event, 'errorMessage')
            || stringEventField(event, 'content')
            || 'Agent runtime failed';
        } else if (event.type === SSEEventType.Done) {
          done = true;
          tokenUsage = normalizeTokenUsage(event.tokenUsage);
          turnCount = finiteNumber(event.turnCount);
        }
      }
    } catch (error) {
      if (isAbortError(error) || input.signal?.aborted) {
        failure = 'Turn cancelled';
        cancelledByAbort = true;
      } else {
        failure = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.releaseRuntimeAgent(runtimeAgentId, managed);
    }

    const cancelled = input.signal?.aborted || cancelledByAbort;
    if (!cancelled && !failure && !done) {
      failure = 'Agent runtime ended without a Done event';
    }

    const result: V3PrimaryTurnResult = {
      sessionId: input.session.id,
      agentId: input.agent.id,
      status: cancelled ? 'cancelled' : failure ? 'failed' : 'succeeded',
      done,
      assistantText: redactSecrets(assistantText, secrets),
      tokenUsage,
      turnCount,
      toolCount: toolCallIds.size,
    };
    if (cancelled || failure) {
      result.error = redactSecrets(
        cancelled ? 'Turn cancelled' : failure,
        secrets,
      );
    }
    return result;
  }

  private assertInput(input: V3PrimaryTurnInput): void {
    if (input.session.kind !== 'primary') {
      throw new Error(`V3AgentRuntimeBridge requires a primary Session: ${input.session.id}`);
    }
    if (input.session.agentId !== input.agent.id) {
      throw new Error(
        `Session Agent mismatch: ${input.session.agentId} !== ${input.agent.id}`,
      );
    }
    if (input.agent.status !== 'active') {
      throw new Error(`Agent is not active: ${input.agent.id}`);
    }
    if (!input.content.trim()) {
      throw new Error('Primary turn content is required');
    }
  }

  private async buildRuntimeConfig(
    input: V3PrimaryTurnInput,
    runtimeAgentId: string,
  ): Promise<AgentConfigWithKey> {
    const credential = await this.credentials.load(
      input.agent.credentialRef?.trim() || 'local-llm',
    );
    return {
      id: runtimeAgentId,
      name: input.agent.name,
      role: AgentRole.MainAgent,
      parentAgentId: null,
      level: 0,
      teamName: input.packet.team.name,
      provider: nonEmpty(
        input.agent.provider,
        nonEmpty(
          credential?.provider,
          this.settings.get<string>('llm.provider', 'openai-compatible'),
        ),
      ),
      apiUrl: nonEmpty(
        credential?.apiUrl,
        this.settings.get<string>('llm.apiUrl', ''),
      ),
      apiKey: credential?.apiKey ?? '',
      model: nonEmpty(
        input.agent.model,
        nonEmpty(
          credential?.model,
          this.settings.get<string>('llm.model', ''),
        ),
      ),
      contextWindow: credential?.contextWindow
        ?? this.settings.get<number>('llm.contextWindow', 131_072),
      maxTurns: this.settings.get<number>('agent.maxTurns', 0),
      temperature: this.settings.get<number>('llm.temperature', 1),
      allowedTools: resolveAllowedTools(input.agent.allowedTools),
      enabledSkills: [...input.agent.enabledSkills],
      mcpServers: [],
      agentPrompt: input.agent.instructions ?? '',
      preferredLanguage: 'en',
      conversationLanguage: 'en',
      state: AgentState.Active,
      createdAt: input.agent.createdAt,
    };
  }

  private acquireRuntimeAgent(config: AgentConfigWithKey): ManagedRuntimeAgent {
    const states = managedStatesFor(this.registry);
    const fingerprint = fingerprintConfig(config);
    let managed = states.get(config.id);

    if (managed) {
      if (this.registry.agent(config.id) !== managed.agent) {
        if (managed.activeTurns > 0) {
          throw new Error(`Runtime bridge Agent changed during an active turn: ${config.id}`);
        }
        states.delete(config.id);
        managed = undefined;
      } else if (managed.configFingerprint !== fingerprint) {
        if (managed.activeTurns > 0 || managed.agent.servingSessionCount > 0) {
          throw new Error(`Runtime bridge Agent is busy and cannot be refreshed: ${config.id}`);
        }
        const refreshed = new RuntimeAgent(config);
        this.registry.registerAgent(refreshed);
        managed.agent = refreshed;
        managed.configFingerprint = fingerprint;
      }
    }

    if (!managed) {
      if (this.registry.agent(config.id)) {
        throw new Error(`Runtime bridge Agent id collision: ${config.id}`);
      }
      const agent = new RuntimeAgent(config);
      this.registry.registerAgent(agent);
      managed = {
        agent,
        activeTurns: 0,
        configFingerprint: fingerprint,
      };
      states.set(config.id, managed);
    }

    managed.activeTurns += 1;
    return managed;
  }

  private releaseRuntimeAgent(
    runtimeAgentId: string,
    managed: ManagedRuntimeAgent,
  ): void {
    const states = managedStatesFor(this.registry);
    const current = states.get(runtimeAgentId);
    if (current !== managed) return;
    managed.activeTurns = Math.max(0, managed.activeTurns - 1);
    if (managed.activeTurns > 0) return;

    const registered = this.registry.agent(runtimeAgentId);
    if (registered !== managed.agent) {
      states.delete(runtimeAgentId);
      return;
    }
    if (managed.agent.servingSessionCount > 0) return;
    this.registry.unregisterAgent(runtimeAgentId);
    states.delete(runtimeAgentId);
  }

  private async persistToolResult(
    input: V3PrimaryTurnInput,
    event: SSEEvent,
    toolCallId: string,
    secrets: readonly string[],
  ): Promise<void> {
    if (!this.transcriptSink) return;
    const content = redactSecrets(stringEventField(event, 'content')
      || stringEventField(event, 'result')
      || '(tool result)', secrets);
    const toolName = stringEventField(event, 'toolName') || undefined;
    const message: TranscriptMessage = {
      kind: 'message',
      id: `tool-result-${toolCallId}`,
      role: 'tool',
      content,
      agentId: input.agent.id,
      toolCallId,
      ...(toolName ? { toolName } : {}),
    };
    await this.transcriptSink.persistToolMessage(input.session.id, message);
    await this.toolTranscriptCommitter.markTranscriptCommitted(
      input.session.id,
      toolCallId,
    );
  }
}

export function buildV3PrimarySystemPrompt(
  agent: V3AgentSnapshot,
  packet: V3PrimaryWorkPacket,
): string {
  const prompt = [
    `You are ${agent.name}, the MainAgent coordinator for this v3 Work.`,
    'You own the end-to-end coordination responsibility: understand the objective, plan the work, coordinate execution, track dependencies, review evidence, and synthesize the final response.',
    'The supplied Team is your current organizational home, not a limit on MainAgent oversight. You may inspect and coordinate any active Team in this Company.',
    'Collaborate exclusively through persistent Teams, Team task assignments, and Team messages. The roster is a current snapshot; create nested Teams with parentTeamId and add persistent Agents only when durable capacity is genuinely useful.',
    'When another Team owns a Mission, pass that Team id to MissionCreate, then create and assign its Tasks to active members of that responsible Team.',
    'Keep company mechanics invisible by default. Users normally talk only to MainAgent, so organize Missions, Tasks, staffing, dependencies, and verification autonomously unless a business decision truly requires the user.',
    'When the objective contains at least two independent, useful workstreams and eligible Team Agents exist, create dependency-aware Tasks and run them in parallel. Do not split work merely to simulate activity.',
    'Keep Work, Mission, and Task state distinct. Base progress and completion claims on explicit evidence.',
    agent.instructions?.trim()
      ? `Agent instructions:\n${agent.instructions.trim()}`
      : '',
    `Execution packet:\n${JSON.stringify(packet, null, 2)}`,
  ].filter(Boolean).join('\n\n');

  return prompt.replace(LEGACY_ORG_TOOL_WORDING, '[legacy action omitted]');
}

export function buildRuntimeHistory(
  session: Session,
  transcript: readonly SessionTranscriptRecord[],
): Message[] {
  const messages: Message[] = [];
  for (const record of transcript) {
    if (record.sessionId !== session.id) {
      throw new Error(
        `Transcript record ${record.entryId} belongs to ${record.sessionId}, not ${session.id}`,
      );
    }
    if (record.entry.kind !== 'message') continue;
    const entry = record.entry;
    messages.push({
      id: entry.id,
      sessionId: session.id,
      role: transcriptRole(entry.role),
      content: entry.content,
      tokenCount: 0,
      compressed: false,
      timestamp: record.occurredAt,
      ...(entry.agentId ? { agentId: entry.agentId } : {}),
    });
  }
  return messages;
}

function buildRuntimeUserMessage(
  sessionId: string,
  content: string,
  messageId: string,
  agent: V3AgentSnapshot,
): Message {
  return {
    id: messageId,
    sessionId,
    role: MessageRole.User,
    content,
    tokenCount: 0,
    compressed: false,
    timestamp: new Date().toISOString(),
    agentId: agent.id,
    agentName: agent.name,
  };
}

function transcriptRole(role: TranscriptMessage['role']): Message['role'] {
  switch (role) {
    case 'assistant':
      return MessageRole.Assistant;
    case 'system':
      return MessageRole.System;
    case 'tool':
      return MessageRole.Tool;
    case 'user':
    default:
      return MessageRole.User;
  }
}

function runtimeAgentIdFor(agent: V3AgentSnapshot): string {
  return `${RUNTIME_AGENT_PREFIX}${agent.companyId}:${agent.id}`;
}

function resolveAllowedTools(allowedTools: readonly string[]): string[] {
  const requested = allowedTools.includes('*')
    ? ToolRegistry.getInstance().allToolNames()
    : [...allowedTools];
  return [...new Set(requested)].filter(
    (name) => !LEGACY_ORG_TOOL_NAMES.has(name.toLowerCase()),
  );
}

function managedStatesFor(
  registry: V3RuntimeAgentRegistry,
): Map<string, ManagedRuntimeAgent> {
  const key = registry as object;
  let states = managedAgentsByRegistry.get(key);
  if (!states) {
    states = new Map();
    managedAgentsByRegistry.set(key, states);
  }
  return states;
}

function fingerprintConfig(config: AgentConfigWithKey): string {
  return createHash('sha256')
    .update(JSON.stringify(config))
    .digest('hex');
}

function nonEmpty(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function stringEventField(event: SSEEvent, key: string): string {
  const value = event[key];
  return typeof value === 'string' ? value : '';
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function createEmptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
}

function normalizeTokenUsage(value: unknown): TokenUsage {
  if (!value || typeof value !== 'object') return createEmptyTokenUsage();
  const usage = value as Record<string, unknown>;
  const inputTokens = firstFiniteNumber(usage, ['inputTokens', 'input_tokens']);
  const outputTokens = firstFiniteNumber(usage, ['outputTokens', 'output_tokens']);
  const cacheReadTokens = firstFiniteNumber(usage, [
    'cacheReadTokens',
    'cache_read_tokens',
  ]);
  const cacheWriteTokens = firstFiniteNumber(usage, [
    'cacheWriteTokens',
    'cache_write_tokens',
  ]);
  const calculated = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const explicitTotal = firstFiniteNumber(usage, [
    'totalTokens',
    'total_tokens',
    'total',
  ]);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: explicitTotal || calculated,
  };
}

function firstFiniteNumber(
  source: Record<string, unknown>,
  keys: readonly string[],
): number {
  for (const key of keys) {
    const value = finiteNumber(source[key]);
    if (value > 0) return value;
  }
  return 0;
}

function redactSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
