/**
 * AgentDelegation — delegation and SubAgent lifecycle helpers.
 *
 * Extracted from AgentRuntime.ts to keep that class focused on the core
 * message-processing loop. All functions take the AgentRuntime instance
 * as their first parameter so they can access singletons (WS server,
 * registry, logger, etc.) without being class methods.
 *
 * @module AgentDelegation
 */

import type { AgentRuntime } from './AgentRuntime.js';
import type { Message } from '../../../shared/types/session.js';
import { MessageRole } from '../../../shared/types/session.js';
import type { SubAgentConfig } from '../../../shared/types/agent.js';
import type { AgentConfigWithKey } from './AgentConfig.js';
import { AgentRole, AgentState } from '../../../shared/types/agent.js';
import type { ToolResult } from '../../../shared/types/tool.js';
import type { SSEEvent } from '../../../shared/types/events.js';
import { SSEEventType } from '../../../shared/types/events.js';
import { AgentRegistry } from './AgentRegistry.js';
import { Agent } from './Agent.js';
import { SessionManager } from '../session/index.js';
import { createLogger } from '../logger.js';
import { TypedEventBus } from '../events/index.js';
import { WsServer } from '../../infra/network/WsServer.js';
import { TokenCounter } from '../context/index.js';
import type { SessionTurnRecorder } from '../../infra/SessionTurnRecorder.js';
import { CoordinationService } from '../coordination/CoordinationService.js';
import { SettingsManager } from '../../infra/storage/SettingsManager.js';
import { PromptAssembler } from '../prompt/PromptAssembler.js';
import {
  InterruptController,
  InterruptReason,
} from './supervision/InterruptController.js';

// ── SubAgent tool filtering ──

/** Event types eligible for bubbling to parent during SubAgent execution. */
const BUBBLE_TYPES = new Set(['text', 'think', 'tool_call', 'tool_result', 'error']);

// ── SubAgent tool filtering ──

/**
 * Map a SubAgent type to the list of allowed tool names.
 *
 * Explore gets read-only tools, Plan gets planning
 * tools, general-purpose gets a broader set including Bash.
 */
export function subAgentAllowedTools(
  _runtime: AgentRuntime,
  subagentType: SubAgentConfig['subagent_type'],
): string[] {
  switch (subagentType) {
    case 'Explore':
      return ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];
    case 'Plan':
      return ['Read', 'Glob', 'Grep', 'EnterPlanMode', 'TodoWrite'];
    case 'general-purpose':
      return ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'TodoWrite'];
    default:
      return ['Read', 'Glob', 'Grep'];
  }
}

// ── Delegation visibility helpers ──

/**
 * Bubble a sub-agent SSE event to the parent session via TypedEventBus.
 * WsForwardSubscriber picks up the event and sends it to the browser.
 * Only a subset of event types are forwarded to avoid flooding.
 */
export function bubbleEventToParent(
  _runtime: AgentRuntime,
  parentSessionId: string,
  subSessionId: string,
  subAgentId: string,
  event: SSEEvent,
): void {
  if (!BUBBLE_TYPES.has(event.type)) return;

  // Truncate content to avoid flooding the WS with large tool outputs
  const content = ((event.content || event.result || '') as string).slice(0, 500);

  TypedEventBus.emit('delegation:progress', {
    parentSessionId,
    subSessionId,
    subAgentId,
    originalType: event.type,
    content,
    toolName: (event.toolName || event.name || undefined) as string | undefined,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Emit a delegation lifecycle event to TypedEventBus.
 * WsForwardSubscriber picks it up and sends `delegation_status` to the browser.
 * Used for phases: started, working, tool_executing, completed, error.
 */
export function emitDelegationStatus(
  _runtime: AgentRuntime,
  parentSessionId: string,
  subSessionId: string,
  subAgentId: string,
  payload: {
    phase: 'started' | 'working' | 'tool_executing' | 'completed' | 'error';
    taskSummary: string;
    turnCount?: number;
    currentTool?: string;
    elapsedMs?: number;
  },
): void {
  const base = {
    parentSessionId,
    subSessionId,
    subAgentId,
    taskSummary: payload.taskSummary,
  };

  switch (payload.phase) {
    case 'started':
      TypedEventBus.emit('delegation:started', base);
      break;
    case 'working':
      TypedEventBus.emit('delegation:working', {
        ...base,
        turnCount: payload.turnCount ?? 0,
        currentTool: payload.currentTool,
        elapsedMs: payload.elapsedMs ?? 0,
      });
      break;
    case 'tool_executing':
      TypedEventBus.emit('delegation:tool_executing', {
        ...base,
        turnCount: payload.turnCount ?? 0,
        currentTool: payload.currentTool ?? 'unknown',
        elapsedMs: payload.elapsedMs ?? 0,
      });
      break;
    case 'completed':
      TypedEventBus.emit('delegation:completed', {
        ...base,
        turnCount: payload.turnCount ?? 0,
        elapsedMs: payload.elapsedMs ?? 0,
      });
      break;
    case 'error':
      TypedEventBus.emit('delegation:error', {
        ...base,
        elapsedMs: payload.elapsedMs ?? 0,
      });
      break;
  }
}

// ── SubAgent output handling ──

/** Mutable state accumulator shared between the delegation loop and heartbeat. */
export interface DelegationState {
  fullContent: string;
  thinking: string;
  turnCount: number;
  currentTool: string | undefined;
}

/**
 * Process the SSE event stream from a delegated sub-agent loop.
 *
 * Handles per-event persistence to the sub-session JSONL, bubbling of
 * progress events to the parent WebSocket, and accumulation of text/thinking
 * content into the shared {@link DelegationState} object.
 *
 * The state object is mutated in-place so a heartbeat callback can observe
 * live `turnCount` and `currentTool` values during execution.
 */
export async function handleSubAgentOutput(
  runtime: AgentRuntime,
  eventStream: AsyncGenerator<SSEEvent>,
  parentSessionId: string,
  subSessionId: string,
  subAgentId: string,
  taskSummary: string,
  startedAt: number,
  recorder: Pick<SessionTurnRecorder, 'record'>,
  state: DelegationState,
): Promise<void> {
  let errorMessage = '';

  for await (const event of eventStream) {
    // ── 0. Detect errors ──
    if (event.type === SSEEventType.Error) {
      const raw = event as Record<string, unknown>;
      errorMessage = String(raw.errorMessage || raw.message || 'Unknown error');
      state.fullContent += `[ERROR] ${errorMessage}`;
    }

    // ── 1. Collect results ──
    if (event.type === SSEEventType.Text) {
      state.fullContent += (event.content as string) || '';
    } else if (event.type === 'tool_call') {
      state.currentTool = (event.toolName || event.name || '') as string;
      state.turnCount++;
      // Emit tool_executing status
      emitDelegationStatus(runtime, parentSessionId, subSessionId, subAgentId, {
        phase: 'tool_executing',
        taskSummary,
        turnCount: state.turnCount,
        currentTool: state.currentTool,
        elapsedMs: Date.now() - startedAt,
      });
    } else if (event.type === 'tool_result') {
      state.currentTool = undefined;
    } else if (event.type === 'think') {
      state.thinking += (event.content || '') as string;
    }

    // ── 2. Per-event persistence to sub-session JSONL ──
    await recorder.record(event, 'delegation');

    // ── 3. Bubble to parent WS ──
    bubbleEventToParent(runtime, parentSessionId, subSessionId, subAgentId, event);

    // ── 4. Forward to sub-session WS so user sees live streaming when viewing sub-session ──
    const FORWARD_TYPES = new Set(['text', 'think', 'tool_call', 'tool_result', 'status_info', 'error']);
    if (FORWARD_TYPES.has(event.type)) {
      WsServer.getInstance().send(subSessionId, event as unknown as Record<string, unknown>);
    }
  }
}

// ── Spawn SubAgent ──

/**
 * Create a temporary SubAgent and execute a task synchronously.
 *
 * The SubAgent is registered temporarily, runs the task through an
 * AgentLoop, and is destroyed (unregistered) after completion or error.
 * Inherits provider, API URL, API key, and model from the caller agent.
 * Emits delegation_status / delegation_progress to the parent session.
 * 
 */
export async function spawnSubAgent(
  runtime: AgentRuntime,
  config: SubAgentConfig,
  callerAgentId?: string,
  parentSessionId?: string,
): Promise<ToolResult> {
  // Role check — only Member(2)+ can use SubAgent
  if (callerAgentId) {
    const caller = AgentRegistry.getInstance().findAgent(callerAgentId);
    const roleLevel: Record<string, number> = { MainAgent: 0, Manager: 1, Member: 2, SubAgent: 3 };
    if (caller && (roleLevel[caller.role] ?? 99) > 2) {
      return {
        toolCallId: `subagent-${Date.now()}`,
        success: false,
        content: '',
        errorMessage: `Permission denied: role "${caller.role}" cannot spawn SubAgent`,
        tokensUsed: 0,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        durationMs: 0,
        wasTruncated: false,
      };
    }
  }
  const startedAt = Date.now();
  const logger = createLogger('anochat.agent');
  logger.debug('SubAgent spawn started', { type: config.subagent_type, model: config.model || 'sonnet', desc: config.description?.slice(0, 60) });

  // ── Inherit API config from parent agent ──
  const registry = AgentRegistry.getInstance();
  const caller = callerAgentId ? registry.findAgent(callerAgentId) : null;
  const inheritedProvider = caller?.provider || '';
  const inheritedApiUrl = caller?.apiUrl || '';
  const inheritedApiKey = caller?.apiKey || '';
  const inheritedModel = config.model || caller?.modelName || '';

  // Generate a temporary id
  const tempId = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Create a temporary Agent instance (not persisted, not in org tree)
  const tempAgentConfig: AgentConfigWithKey = {
    id: tempId,
    name: `SubAgent-${config.subagent_type}`,
    role: AgentRole.SubAgent,
    parentAgentId: callerAgentId || null,
    level: 3,
    teamName: '',
    provider: inheritedProvider,
    apiUrl: inheritedApiUrl,
    apiKey: inheritedApiKey,
    model: inheritedModel,
    contextWindow: caller?.contextWindow || 1048576,
    agentPrompt: config.prompt,
    preferredLanguage: 'en' as const,
    conversationLanguage: 'en' as const,
    allowedTools: config.readOnly
      ? subAgentAllowedTools(runtime, config.subagent_type).filter((name) =>
        ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'EnterPlanMode', 'TodoWrite'].includes(name),
      )
      : subAgentAllowedTools(runtime, config.subagent_type),
    enabledSkills: [],
    mcpServers: [],
    state: AgentState.Active,
    createdAt: new Date().toISOString(),
  };

  const subAgent = new Agent(tempAgentConfig);

  // Register temporarily
  registry.registerAgent(subAgent);

  // ── Create a real scoped session. The Agent is ephemeral; the transcript is durable. ──
  let subSessionId = `temp-${tempId}`;
  let recorder: SessionTurnRecorder | null = null;
  let coordinationHeartbeat: ReturnType<typeof setInterval> | null = null;
  let coordinationTimeout: ReturnType<typeof setTimeout> | null = null;
  let coordinationTimeoutError = '';
  let coordinationTask = config.coordinationTaskId && parentSessionId
    ? CoordinationService.getInstance().getTask(
      SessionManager.getInstance().getRootSession(parentSessionId).id,
      config.coordinationTaskId,
    )
    : undefined;

  if (parentSessionId) {
    try {
      const { SessionTurnRecorder } = await import('../../infra/SessionTurnRecorder.js');
      const session = await SessionManager.getInstance().createSubSession(
        parentSessionId,
        tempId,
        `SubAgent: ${config.description?.slice(0, 60) || config.subagent_type}`,
        {
          scopeId: `ephemeral-${config.coordinationTaskId || tempId}`,
          metadata: {
            subagentType: config.subagent_type,
            callerAgentId,
            taskDescription: (config.description || config.prompt).slice(0, 200),
            tempAgentId: tempId,
            coordinationTaskId: config.coordinationTaskId,
            coordinationRootSessionId: coordinationTask?.rootSessionId,
            contextMode: config.contextMode || 'summary',
          },
        },
      );
      subSessionId = session.id;
      recorder = new SessionTurnRecorder(
        subSessionId,
        tempId,
        `msg-sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      );

      if (coordinationTask) {
        const service = CoordinationService.getInstance();
        coordinationTask = await service.assignTask(
          coordinationTask.rootSessionId,
          coordinationTask.id,
          tempId,
          callerAgentId || tempId,
          coordinationTask.version,
        );
        if (!coordinationTask.readOnly) {
          const root = SessionManager.getInstance().getRootSession(parentSessionId);
          const lease = await service.acquireTaskLease(
            coordinationTask.rootSessionId,
            coordinationTask.id,
            root.workspace,
            SettingsManager.getInstance().get<number>('coordination.workspaceLeaseTtlMs', 30_000),
          );
          if (!lease) throw new Error('SubAgent workspace is blocked by another task lease');
        }
        coordinationTask = await service.claimTask(
          coordinationTask.rootSessionId,
          coordinationTask.id,
          tempId,
          coordinationTask.version,
        );
        coordinationTask = await service.updateTask(
          coordinationTask.rootSessionId,
          coordinationTask.id,
          {
            status: 'running',
            sessionId: subSessionId,
            heartbeatAt: new Date().toISOString(),
            progress: 0,
          },
          tempId,
          coordinationTask.version,
        );
        const leaseTtlMs = SettingsManager.getInstance().get<number>(
          'coordination.workspaceLeaseTtlMs',
          30_000,
        );
        const maxRuntimeMs = SettingsManager.getInstance().get<number>(
          'coordination.maxTaskRuntimeMs',
          600_000,
        );
        coordinationHeartbeat = setInterval(() => {
          const current = service.getTask(coordinationTask!.rootSessionId, coordinationTask!.id);
          if (current?.status !== 'running') return;
          void service.renewTaskLeases(current.rootSessionId, current.id, leaseTtlMs, tempId)
            .catch(() => {});
          void service.updateTask(current.rootSessionId, current.id, {
            heartbeatAt: new Date().toISOString(),
          }, tempId).catch(() => {});
        }, Math.max(1_000, Math.min(5_000, Math.floor(leaseTtlMs / 2))));
        coordinationTimeout = setTimeout(() => {
          coordinationTimeoutError = `SubAgent coordination task timed out after ${maxRuntimeMs}ms`;
          InterruptController.getInstance().requestInterrupt(subSessionId, InterruptReason.Timeout);
        }, maxRuntimeMs);
      }

      logger.debug('SubAgent durable session created', { subSessionId, parentSessionId, tempId });
    } catch (err) {
      logger.warn('Failed to create SubAgent session', {
        tempId,
        error: (err as Error).message,
      });
      if (coordinationTask) {
        const current = CoordinationService.getInstance().getTask(coordinationTask.rootSessionId, coordinationTask.id);
        if (current && !['completed', 'failed', 'cancelled'].includes(current.status)) {
          await CoordinationService.getInstance().updateTask(current.rootSessionId, current.id, {
            status: current.status === 'running' ? 'failed' : 'cancelled',
            error: (err as Error).message,
          }, callerAgentId || tempId).catch(() => {});
        }
      }
      subAgent.setState(AgentState.Destroyed);
      registry.unregisterAgent(tempId);
      return {
        toolCallId: `subagent-${tempId}`,
        success: false,
        content: '',
        errorMessage: `Failed to create durable SubAgent session: ${(err as Error).message}`,
        tokensUsed: 0,
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        wasTruncated: false,
        structured: {
          coordinationTaskId: config.coordinationTaskId,
        },
      };
    }
  }

  // ── Emit delegation_status: started to parent ──
  if (parentSessionId) {
    emitDelegationStatus(runtime, parentSessionId, subSessionId, tempId, {
      phase: 'started',
      taskSummary: config.description?.slice(0, 60) || config.subagent_type,
    });
  }

  const callerName = caller?.name || callerAgentId || 'unknown';
  const taskMessage: Message = {
    id: `subagent-msg-${Date.now()}`,
    sessionId: subSessionId,
    role: MessageRole.System,
    content: `[Task delegated by ${callerName}]:\n\n${config.prompt}`,
    tokenCount: TokenCounter.estimate(`[Task delegated by ${callerName}]:\n\n${config.prompt}`),
    compressed: false,
    timestamp: new Date().toISOString(),
  };
  if (parentSessionId) await SessionManager.getInstance().appendMessage(subSessionId, taskMessage);

  const parentHistory = parentSessionId
    ? await SessionManager.getInstance().getHistory(parentSessionId).catch(() => [] as Message[])
    : [];
  const history = config.contextMode === 'fork'
    ? parentHistory
    : config.contextMode === 'isolated'
      ? []
      : parentHistory.slice(-8);
  const forkedSystemPrompt = config.contextMode === 'fork' && parentSessionId && callerAgentId
    ? PromptAssembler.getInstance().buildEffectivePrompt(callerAgentId, parentSessionId)
    : undefined;

  let fullContent = '';
  let turnCount = 0;
  let tokenUsage = 0;

  try {
    for await (const event of runtime.processMessage(
      subSessionId,
      tempId,
      taskMessage,
      history,
      {
        permissionMode: 'AutoEdit',
        effort: 'HIGH',
        ...(forkedSystemPrompt ? { systemPromptOverride: forkedSystemPrompt } : {}),
      },
    )) {
      if (event.type === SSEEventType.Text) {
        fullContent += (event.content as string) || '';
      }
      if (event.type === 'tool_call') {
        turnCount++;
      }
      if (event.type === SSEEventType.Done) {
        tokenUsage = Number((event.tokenUsage as { total?: number } | undefined)?.total || 0);
      }
      // ── Bubble progress to parent ──
      if (parentSessionId && BUBBLE_TYPES.has(event.type)) {
        bubbleEventToParent(runtime, parentSessionId, subSessionId, tempId, event);
      }
      // ── Persist events to JSONL if session is real ──
      if (recorder) {
        await recorder.record(event, 'subagent');
      }
    }
    if (coordinationTimeoutError) throw new Error(coordinationTimeoutError);
    await recorder?.finalize();

    const durationMs = Date.now() - startedAt;
    logger.debug('SubAgent completed', { tempId, type: config.subagent_type, contentLen: fullContent.length, durationMs });

    // ── Emit delegation_status: completed to parent ──
    if (parentSessionId) {
      emitDelegationStatus(runtime, parentSessionId, subSessionId, tempId, {
        phase: 'completed',
        taskSummary: config.description?.slice(0, 60) || config.subagent_type,
        elapsedMs: durationMs,
      });
    }

    if (coordinationTask) {
      const latest = CoordinationService.getInstance().getTask(coordinationTask.rootSessionId, coordinationTask.id);
      if (latest?.status === 'running') {
        coordinationTask = await CoordinationService.getInstance().updateTask(
          latest.rootSessionId,
          latest.id,
          {
            status: 'completed',
            progress: 100,
            resultSummary: fullContent.trim().slice(0, 2_000) || 'SubAgent completed without text output.',
            outputRef: `session:${subSessionId}`,
            evidence: [`Session transcript: ${subSessionId}`, `Turns: ${turnCount}`],
            tokenUsage,
          },
          tempId,
          latest.version,
        );
      }
    }

    return {
      toolCallId: `subagent-${tempId}`,
      success: true,
      content: fullContent,
      structured: { subSessionId, taskId: coordinationTask?.id },
      tokensUsed: Math.ceil(fullContent.length / 4),
      startedAt,
      finishedAt: Date.now(),
      durationMs,
      wasTruncated: false,
    };
  } catch (err) {
    await recorder?.recordError(
      err instanceof Error ? err.message : String(err),
      'subagent',
    ).catch(() => {});
    await recorder?.finalize().catch(() => {});
    const errorMessage = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startedAt;
    logger.error('SubAgent failed', { tempId, type: config.subagent_type, error: errorMessage.slice(0, 200) });

    // ── Emit delegation_status: error to parent ──
    if (parentSessionId) {
      emitDelegationStatus(runtime, parentSessionId, subSessionId, tempId, {
        phase: 'error',
        taskSummary: config.description?.slice(0, 60) || config.subagent_type,
        elapsedMs: durationMs,
      });
    }

    if (coordinationTask) {
      const latest = CoordinationService.getInstance().getTask(coordinationTask.rootSessionId, coordinationTask.id);
      if (latest?.status === 'running') {
        await CoordinationService.getInstance().updateTask(
          latest.rootSessionId,
          latest.id,
          {
            status: 'failed',
            error: errorMessage.slice(0, 2_000),
            resultSummary: fullContent.trim().slice(0, 2_000) || undefined,
            outputRef: `session:${subSessionId}`,
            tokenUsage,
          },
          tempId,
          latest.version,
        ).catch(() => {});
      }
    }

    return {
      toolCallId: `subagent-${tempId}`,
      success: false,
      content: fullContent,
      structured: { subSessionId, taskId: coordinationTask?.id },
      errorMessage,
      tokensUsed: Math.ceil(fullContent.length / 4),
      startedAt,
      finishedAt: Date.now(),
      durationMs,
      wasTruncated: false,
    };
  } finally {
    if (coordinationHeartbeat) clearInterval(coordinationHeartbeat);
    if (coordinationTimeout) clearTimeout(coordinationTimeout);
    if (coordinationTask) {
      await CoordinationService.getInstance().releaseTaskLeases(
        coordinationTask.rootSessionId,
        coordinationTask.id,
        tempId,
      ).catch(() => {});
    }
    // Always destroy the SubAgent; durable Task and transcript remain.
    logger.debug('SubAgent destroyed', { tempId, type: config.subagent_type });
    subAgent.setState(AgentState.Destroyed);
    registry.unregisterAgent(tempId);
  }
}
