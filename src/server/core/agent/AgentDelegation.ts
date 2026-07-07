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
import type { Message, SessionNode } from '../../../shared/types/session.js';
import type { SessionType, SessionStatus } from '../../../shared/types/session.js';
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
  persister: { persistEvent: (...args: any[]) => Promise<any> },
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
    if (event.type === 'text') {
      await persister.persistEvent('text', { content: event.content || '' });
    } else if (event.type === 'think') {
      await persister.persistEvent('think', { content: event.content || '' });
    } else if (event.type === 'tool_call') {
      await persister.persistEvent('tool_call', {
        id: (event.toolCallId || event.toolId || '') as string,
        name: (event.toolName || event.name || '') as string,
        input: (event.params || event.args || event.input || event.toolInput || {}) as Record<string, unknown>,
      });
    } else if (event.type === 'tool_result') {
      await persister.persistEvent('tool_result', {
        toolCallId: (event.toolCallId || event.toolId || '') as string,
        is_error: (event as Record<string, unknown>).success === false,
        content: (event.result || event.content || '') as string,
      });
    } else if (event.type === SSEEventType.Error) {
      await persister.persistEvent('error', { error: errorMessage || 'Unknown error', source: 'delegation' });
    }

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
    allowedTools: subAgentAllowedTools(runtime, config.subagent_type),
    enabledSkills: [],
    mcpServers: [],
    state: AgentState.Active,
    createdAt: new Date().toISOString(),
  };

  const subAgent = new Agent(tempAgentConfig);

  // Register temporarily
  registry.registerAgent(subAgent);

  // ── Create session — persist creates disk-only record, no in-memory tree ──
  let subSessionId = `temp-${tempId}`;
  let persister: { persistEvent: (...args: any[]) => Promise<any> } | null = null;

  if (config.persist && parentSessionId) {
    try {
      const { StreamPersister } = await import('../../infra/StreamPersister.js');
      const { SessionStore } = await import('../session/SessionStore.js');
      const store = SessionStore.getInstance();
      const diskSessionId = `sub-${parentSessionId}-${Date.now().toString(36)}`;

      // Write minimal session meta to disk (discoverable via SessionStore, no UI tree)
      await store.writeSessionMeta(diskSessionId, {
        sessionId: diskSessionId,
        parentSessionId,
        level: 0,
        agentId: tempId,
        type: 'Sub' as SessionType,
        status: 'Active' as SessionStatus,
        title: `SubAgent: ${config.description?.slice(0, 60) || config.subagent_type}`,
        workspace: SessionManager.getInstance().session(parentSessionId)?.workspace || '',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        subSessionIds: [],
        metadata: {
          subagentType: config.subagent_type,
          callerAgentId,
          taskDescription: (config.description || config.prompt).slice(0, 200),
          tempAgentId: tempId,
        },
      } as SessionNode);

      subSessionId = diskSessionId;

      // Create StreamPersister for per-event JSONL persistence
      const turnMsgId = `msg-sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      persister = new StreamPersister(store, subSessionId, turnMsgId, '00000000-0000-0000-0000-000000000000', tempId);

      logger.debug('SubAgent persistent session created', { subSessionId, parentSessionId, tempId });
    } catch (err) {
      logger.warn('Failed to create persistent sub-session, falling back to temp', {
        tempId,
        error: (err as Error).message,
      });
      subSessionId = `temp-${tempId}`;
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

  let fullContent = '';
  let turnCount = 0;

  try {
    for await (const event of runtime.processMessage(subSessionId, tempId, taskMessage)) {
      if (event.type === SSEEventType.Text) {
        fullContent += (event.content as string) || '';
      }
      if (event.type === 'tool_call') {
        turnCount++;
      }
      // ── Bubble progress to parent ──
      if (parentSessionId && BUBBLE_TYPES.has(event.type)) {
        bubbleEventToParent(runtime, parentSessionId, subSessionId, tempId, event);
      }
      // ── Persist events to JSONL if session is real ──
      if (persister) {
        if (event.type === 'text') {
          await persister.persistEvent('text', { content: event.content || '' });
        } else if (event.type === 'think') {
          await persister.persistEvent('think', { content: event.content || '' });
        } else if (event.type === 'tool_call') {
          await persister.persistEvent('tool_call', {
            id: (event.toolCallId || event.toolId || '') as string,
            name: (event.toolName || event.name || '') as string,
            input: (event.params || event.args || event.input || event.toolInput || {}) as Record<string, unknown>,
          });
        } else if (event.type === 'tool_result') {
          await persister.persistEvent('tool_result', {
            toolCallId: (event.toolCallId || event.toolId || '') as string,
            is_error: (event as Record<string, unknown>).success === false,
            content: (event.result || event.content || '') as string,
          });
        } else if (event.type === SSEEventType.Error) {
          await persister.persistEvent('error', {
            error: ((event as Record<string, unknown>).errorMessage || (event as Record<string, unknown>).message || 'Unknown error') as string,
            source: 'subagent',
          });
        }
      }
    }

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

    return {
      toolCallId: `subagent-${tempId}`,
      success: true,
      content: fullContent,
      structured: { subSessionId },
      tokensUsed: Math.ceil(fullContent.length / 4),
      startedAt,
      finishedAt: Date.now(),
      durationMs,
      wasTruncated: false,
    };
  } catch (err) {
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

    return {
      toolCallId: `subagent-${tempId}`,
      success: false,
      content: fullContent,
      structured: { subSessionId },
      errorMessage,
      tokensUsed: Math.ceil(fullContent.length / 4),
      startedAt,
      finishedAt: Date.now(),
      durationMs,
      wasTruncated: false,
    };
  } finally {
    // Always destroy the SubAgent — session data persists separately (if persist=true)
    logger.debug('SubAgent destroyed', { tempId, type: config.subagent_type });
    subAgent.setState(AgentState.Destroyed);
    registry.unregisterAgent(tempId);
  }
}
