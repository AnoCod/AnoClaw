/**
 * AgentRuntime — singleton runtime manager.
 *
 * Extends EventEmitter. Entry point for processing messages, delegating tasks,
 * and spawning SubAgents. Coordinates WorkerPool, AgentLoop, and LLMProvider.
 * Delegation and SubAgent lifecycle helpers live in {@link AgentDelegation}.
 *
 * @module AgentRuntime
 */

import { EventEmitter } from 'events';
import { AgentRegistry } from './AgentRegistry.js';
import { AgentLoop } from './AgentLoop.js';
import type { AgentLoopConfig } from './AgentLoop.js';
import type { Message } from '../../../shared/types/session.js';
import { MessageRole } from '../../../shared/types/session.js';
import type { SubAgentConfig } from '../../../shared/types/agent.js';
import { AgentStatus } from '../../../shared/types/agent.js';
import type { ToolResult } from '../../../shared/types/tool.js';
import type { SSEEvent } from '../../../shared/types/events.js';
import { SSEEventType, AgentRuntimeEvents } from '../../../shared/types/events.js';
import { InterruptController, InterruptReason } from './supervision/InterruptController.js';
import { SessionManager } from '../session/index.js';
import { SessionStore } from '../session/SessionStore.js';
import { SessionLeaseManager } from '../session/SessionLeaseManager.js';
import { createLogger } from '../logger.js';
import { SupervisionManager, TaskStatus } from './supervision/SupervisionManager.js';
import { BackgroundTaskManager } from './supervision/BackgroundTaskManager.js';
import { buildContextSummary } from '../prompt/sections/DelegationContextSection.js';
import { TypedEventBus } from '../events/index.js';
import { SharedContextStore } from './SharedContextStore.js';
import { TokenCounter } from '../context/index.js';
import { TaskDAG } from './TaskDAG.js';
import { ExecutionPlan } from './ExecutionPlan.js';
import { EventSubscriptionManager } from '../events/index.js';
import { WsServer } from '../../infra/network/WsServer.js';
import { buildTaskNotificationXML } from './TaskNotification.js';
import {
  bubbleEventToParent,
  emitDelegationStatus,
  handleSubAgentOutput,
  spawnSubAgent,
  subAgentAllowedTools,
  type DelegationState,
} from './AgentDelegation.js';

export class AgentRuntime extends EventEmitter {
  // ── Singleton ──
  private static _instance: AgentRuntime | null = null;

  static getInstance(): AgentRuntime {
    if (!AgentRuntime._instance) {
      AgentRuntime._instance = new AgentRuntime();
    }
    return AgentRuntime._instance;
  }

  /** Reset the singleton (primarily for testing). */
  static resetInstance(): void {
    AgentRuntime._instance = null;
  }

  // ── Task notification wiring ──
  private _taskNotificationsWired = false;

  // ── Session tracking ──
  /** Map of sessionId → active AgentLoop instance */
  private _activeLoops: Map<string, AgentLoop> = new Map();

  private constructor() {
    super();
    this._subscribeToTaskNotifications();
  }

  // ── Core: process message ──

  /**
   * Main entry point for processing a user message through an AgentLoop.
   *
   * 1. Resolves the agent for this session
   * 2. Creates an AgentLoop instance
   * 3. Runs the ReAct loop, yielding SSE events
   * 4. Emits AgentRuntimeEvents for each phase
   *
   * @returns AsyncGenerator of SSE events for the frontend
   */
  async *processMessage(
    sessionId: string,
    agentId: string,
    message: Message,
    history: Message[] = [],
  ): AsyncGenerator<SSEEvent> {
    const registry = AgentRegistry.getInstance();
    const agent = registry.agent(agentId);
    const logger = createLogger('anochat.agent');

    logger.debug('Agent loop starting', { sid: sessionId, aid: agentId });

    if (!agent) {
      logger.warn('Agent not found', { sid: sessionId, aid: agentId });
      yield {
        type: SSEEventType.Error,
        errorMessage: `Agent not found: ${agentId}`,
      };
      return;
    }

    if (!agent.isActive) {
      logger.warn('Agent is destroyed', { sid: sessionId, aid: agentId });
      yield {
        type: SSEEventType.Error,
        errorMessage: `Agent ${agentId} is destroyed`,
      };
      return;
    }

    // Guard: prevent concurrent AgentLoop on the same session.
    // Instead of rejecting, queue the message as a pending interrupt.
    if (this.isSessionActive(sessionId)) {
      logger.info('Session active — queuing as pending message (soft interrupt)', { sid: sessionId, aid: agentId });
      InterruptController.getInstance().setPendingUserMessage(sessionId, message.content as string);
      InterruptController.getInstance().requestInterrupt(sessionId, InterruptReason.UserSteer);
      yield {
        type: SSEEventType.StatusInfo,
        content: '(Your message has been queued — the agent will respond shortly)',
      };
      return;
    }

    // Acquire lease — reject if too many concurrent sessions
    const lease = SessionLeaseManager.getInstance().acquire(sessionId);
    if (!lease) {
      logger.warn('Too many concurrent sessions — rejecting', { sid: sessionId });
      yield {
        type: SSEEventType.Error,
        errorMessage: 'Server busy — too many concurrent sessions. Please wait and try again.',
        code: 'TOO_MANY_SESSIONS',
      };
      return;
    }

    // Track per-session agent serving count
    agent.adjustSessionCount(+1);

    // Set up interrupt controller for this session
    const interruptController = InterruptController.getInstance();
    const signal = interruptController.createController(sessionId).signal;

    // Mark agent as working in this session
    agent.setSessionStatus(sessionId, AgentStatus.Working);

    // SupervisionManager integration
    // Register heartbeat for this session
    SupervisionManager.getInstance().heartbeat(sessionId);

    // Build AgentLoop configuration from agent config
    const loopConfig: AgentLoopConfig = {
      agentId: agent.id,
      sessionId,
      maxTurns: agent.maxTurns,
      temperature: agent.temperature,
      contextWindow: agent.contextWindow,
    };

    const loop = new AgentLoop(loopConfig);
    this._activeLoops.set(sessionId, loop);

    let supervisionCheckCounter = 0;

    try {
      // Run the AgentLoop
      for await (const event of loop.run(message, history, signal)) {
        supervisionCheckCounter++;

        // Forward events from AgentRuntime
        if (event.type === SSEEventType.ToolCall) {
          this.emit(AgentRuntimeEvents.ToolCallStarted, {
            sessionId,
            agentId,
            toolName: event.toolName,
          });
        } else if (event.type === SSEEventType.ToolResult) {
          this.emit(AgentRuntimeEvents.ToolCallFinished, {
            sessionId,
            agentId,
            toolName: event.toolName,
          });
        } else if (event.type === SSEEventType.Think || event.type === SSEEventType.Text) {
          this.emit(AgentRuntimeEvents.StreamingToken, {
            sessionId,
            agentId,
            type: event.type,
            content: event.content,
          });
        }

        yield event;

        // Refresh heartbeat on every event — proves the agent is still alive
        SupervisionManager.getInstance().heartbeat(sessionId);

        // Periodically check if session has gone unresponsive (every 5 events)
        if (supervisionCheckCounter % 5 === 0) {
          if (SupervisionManager.getInstance().isUnresponsive(sessionId)) {
            logger.warn('Session detected as unresponsive by SupervisionManager', {
              sid: sessionId,
              aid: agentId,
            });
            yield {
              type: SSEEventType.StatusInfo,
              content: '(Warning: session heartbeat overdue — agent may be unresponsive)',
            };
          }
        }
      }

      // Loop completed successfully
      agent.setSessionStatus(sessionId, AgentStatus.Working); // back to "ready" (not actively in loop)
      this.emit(AgentRuntimeEvents.AgentLoopCompleted, {
        sessionId,
        agentId,
        status: 'completed',
      });
      TypedEventBus.emit('loop:completed', {
        sessionId,
        agentId,
        turnCount: loop.maxTurns,
        totalTokens: 0,
      });
      logger.debug('Agent loop completed', { sid: sessionId, aid: agentId });

      // ── Memory lifecycle: post-loop extraction, decay, consolidation ──
      runMemoryLifecycle(agentId, sessionId).catch(() => {});

      // ── Infinite mode: keep alive after completion ──
      const sessionManager = SessionManager.getInstance();
      let processedCount = sessionManager.getMessageCount(sessionId);

      while (sessionManager.getRunningMode(sessionId) === 'infinite') {
        yield { type: SSEEventType.Sleep, content: '∞' };

        // Sleep 3 seconds (30 × 100ms with interrupt check)
        for (let i = 0; i < 30; i++) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        // Check if mode changed during sleep
        if (sessionManager.getRunningMode(sessionId) !== 'infinite') {
          yield { type: SSEEventType.StatusInfo, content: '(Exiting ∞ mode — mode changed)' };
          break;
        }

        // Check for new user messages
        const currentCount = sessionManager.getMessageCount(sessionId);
        if (currentCount > processedCount) {
          processedCount = currentCount;
          yield { type: SSEEventType.Wake, content: '(New task — resuming work in ∞ mode)' };

          try {
            const fullHistory = await sessionManager.getHistory(sessionId);
            const recentHistory = fullHistory.slice(-200);

            // Find the last user message that we haven't processed yet
            const newUserMsg = recentHistory.filter(m => m.role === 'user').pop();
            if (newUserMsg) {
              const newLoop = new AgentLoop(loopConfig);
              this._activeLoops.set(sessionId, newLoop);
              try {
                for await (const evt of newLoop.run(newUserMsg, recentHistory, signal)) {
                  yield evt;
                  SupervisionManager.getInstance().heartbeat(sessionId);
                }
              } finally {
                this._activeLoops.delete(sessionId);
              }

              // Update processed count after sub-loop finishes
              processedCount = sessionManager.getMessageCount(sessionId);
            }
          } catch (err) {
            logger.warn('Infinite mode sub-loop error', { sid: sessionId, error: (err as Error).message });
            yield { type: SSEEventType.Error, errorMessage: `Infinite mode error: ${(err as Error).message}`, code: 'INFINITE_LOOP_ERROR' };
          }
        }

        // Refresh heartbeat during idle
        SupervisionManager.getInstance().heartbeat(sessionId);
      }

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      agent.setSessionStatus(sessionId, AgentStatus.Error);
      this.emit(AgentRuntimeEvents.AgentLoopCompleted, {
        sessionId,
        agentId,
        status: 'error',
        error: errorMessage,
      });
      logger.error('Agent loop error', { sid: sessionId, aid: agentId, error: errorMessage.slice(0, 200) });
      yield {
        type: SSEEventType.Error,
        errorMessage: `Agent loop error: ${errorMessage}`,
        code: 'AGENT_LOOP_ERROR',
      };
    } finally {
      this._activeLoops.delete(sessionId);
      interruptController.removeController(sessionId);
      agent.clearSessionStatus(sessionId);
      agent.adjustSessionCount(-1);
      SessionLeaseManager.getInstance().release(sessionId);
    }
  }

  // ── Delegate task ──

  /**
   * Delegate a task to a subordinate agent. Creates a sub-session
   * and runs the target agent's loop with the task as a user message.
   *
   * @returns ToolResult with the delegation outcome
   */
  async delegateTask(
    targetAgentId: string,
    task: string,
    parentSessionId: string,
    parentAgentId: string,
  ): Promise<ToolResult> {
    // Role check — only CEO(0) and Manager(1) can delegate tasks
    const delegator = AgentRegistry.getInstance().findAgent(parentAgentId);
    if (!delegator || !delegator.isManagerRole()) {
      return {
        toolCallId: `delegate-${targetAgentId}`,
        success: false,
        content: '',
        errorMessage: `Permission denied: role "${delegator?.role}" cannot delegate tasks (requires Manager or MainAgent)`,
        tokensUsed: 0,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        durationMs: 0,
        wasTruncated: false,
      };
    }
    const logger = createLogger('anochat.agent');
    logger.info('Delegation started', { parentSid: parentSessionId, targetAid: targetAgentId, taskPreview: task.slice(0, 60) });

    const registry = AgentRegistry.getInstance();
    const targetAgent = registry.findAgent(targetAgentId);
    if (!targetAgent) {
      return {
        toolCallId: `delegate-${targetAgentId}`,
        success: false,
        content: '',
        errorMessage: `Target agent not found: ${targetAgentId}`,
        tokensUsed: 0,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        durationMs: 0,
        wasTruncated: false,
      };
    }

    if (!targetAgent.isActive) {
      return {
        toolCallId: `delegate-${targetAgentId}`,
        success: false,
        content: '',
        errorMessage: `Target agent ${targetAgentId} is destroyed`,
        tokensUsed: 0,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        durationMs: 0,
        wasTruncated: false,
      };
    }

    // ── Validate org-tree relationship ──
    // Tasks can ONLY be delegated to direct subordinates (immediate children).
    if (targetAgent.parentAgentId !== parentAgentId) {
      return {
        toolCallId: `delegate-${targetAgentId}`,
        success: false,
        content: '',
        errorMessage: `Cannot delegate to '${targetAgentId}': tasks can only be assigned to your direct subordinates (immediate children).`,
        tokensUsed: 0,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        durationMs: 0,
        wasTruncated: false,
      };
    }

    // Create a real sub-session via SessionManager (use agent's internal ID, not LLM-provided name)
    const actualAgentId = targetAgent.id; // internal ID like "manager-research", not "Research-Manager"
    const sessionManager = SessionManager.getInstance();
    let subSessionId: string;
    try {
      const subSession = await sessionManager.createSubSession(parentSessionId, actualAgentId,
        `Task: ${task.slice(0, 40)}`);
      subSessionId = subSession.id;
      // Link parent→child for interrupt propagation
      InterruptController.getInstance().linkChild(parentSessionId, subSessionId);
      logger.info('Sub-session created for delegation', { parentSid: parentSessionId, subSid: subSessionId, targetAid: actualAgentId });
      // Notify via TypedEventBus → WsForwardSubscriber so the frontend tree updates
      TypedEventBus.emit('delegation:subsession_created', {
        sessionId: subSessionId,
        parentSessionId,
        agentId: actualAgentId,
        title: `Task: ${task.slice(0, 40)}`,
      });
    } catch (err) {
      return {
        toolCallId: `delegate-${targetAgentId}`,
        success: false,
        content: '',
        errorMessage: `Failed to create sub-session: ${(err as Error).message}`,
        tokensUsed: 0,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        durationMs: 0,
        wasTruncated: false,
      };
    }

    // ── Inject parent context into delegation message ──
    // Append a structured summary of the parent conversation so the sub-agent
    // understands the broader goal (prevents "memory rupture").
    let enrichedTask = task;
    try {
      const parentHistory = await sessionManager.getHistory(parentSessionId);
      if (parentHistory.length > 0) {
        const contextParts: string[] = [];
        // User's original request (most important)
        const userMsgs = parentHistory.filter((m: Message) => m.role === 'user');
        const lastUser = userMsgs.length > 0 ? userMsgs[userMsgs.length - 1] : parentHistory[parentHistory.length - 1];
        if (lastUser && lastUser.content) {
          contextParts.push(`**Original Request:** ${lastUser.content.slice(0, 300)}`);
        }
        // Last 3 conversation turns for direction
        const recent = parentHistory.slice(-3);
        if (recent.length > 1) {
          contextParts.push(`**Recent Context:** ${recent.map((m: Message) => `[${m.role}] ${(m.content || '').slice(0, 80)}`).join(' | ')}`);
        }
        enrichedTask = task + '\n\n---\n# Parent Session Context\n' + contextParts.join('\n');
      }
    } catch { /* parent history unavailable — proceed with task only */ }

    // Store parent context in sub-session metadata for DelegationContextSection
    try {
      const parentHistory = await sessionManager.getHistory(parentSessionId);
      if (parentHistory.length > 0) {
        const contextStr = buildContextSummary(parentHistory);
        const subSession = sessionManager.session(subSessionId);
        if (subSession) {
          subSession.setMetadata('parentContext', contextStr);
          subSession.setMetadata('parentSessionId', parentSessionId);
        }
      }
    } catch { /* non-critical */ }

    // Build delegation message
    const parentAgent = AgentRegistry.getInstance().agent(parentAgentId);
    const delegatorName = parentAgent?.name || parentAgentId;
    const delegationMessage: Message = {
      id: `delegate-msg-${Date.now()}`,
      sessionId: subSessionId,
      role: MessageRole.System,
      content: `[Task delegated by ${delegatorName}]:\n\n${enrichedTask}`,
      tokenCount: TokenCounter.estimate(`[Task delegated by ${delegatorName}]:\n\n${enrichedTask}`),
      compressed: false,
      timestamp: new Date().toISOString(),
      agentId: parentAgentId,
      agentName: delegatorName,
    };

    // Persist the delegation message
    try {
      await sessionManager.appendMessage(subSessionId, delegationMessage);
    } catch { /* non-critical */ }

    // ── Emit delegation_status: started ──
    emitDelegationStatus(this,parentSessionId, subSessionId, targetAgentId, {
      phase: 'started',
      taskSummary: task.slice(0, 60),
    });

    // Populate SharedContextStore for bidirectional parent↔child context sharing
    const teamScope = delegator?.teamName || parentSessionId;
    try {
      SharedContextStore.getInstance().set(teamScope, `task:${subSessionId}`, task, parentAgentId);
      SharedContextStore.getInstance().set(teamScope, `status:${subSessionId}`, 'started', parentAgentId);
    } catch { /* non-critical */ }

    // Inject live SharedContextStore entries into the delegation message so the
    // sub-agent can see team-wide context updates (other active sub-agents, progress).
    try {
      const contextEntries = SharedContextStore.getInstance().getAll(teamScope);
      if (contextEntries.length > 0) {
        const contextSummary = contextEntries
          .map(e => `[${e.writtenBy}]: ${e.key}=${e.value.slice(0, 200)}`)
          .join('\n');
        enrichedTask += '\n\n---\n# Shared Context (live updates from team)\n' + contextSummary;
      }
    } catch { /* non-critical */ }

    const startedAt = Date.now();

    // Shared mutable state — the heartbeat callback reads turnCount/currentTool live
    const state: DelegationState = {
      fullContent: '',
      thinking: '',
      turnCount: 0,
      currentTool: undefined,
    };

    // ── Re-delegation guard: if this session already has an active AgentLoop,
    // inject the task as a soft interrupt instead of creating a new background task.
    // This keeps the "one agent = one session = one AgentLoop" contract intact.
    if (this.isSessionActive(subSessionId)) {
      try {
        await sessionManager.appendMessage(subSessionId, delegationMessage);
      } catch { /* non-critical */ }
      InterruptController.getInstance().setPendingUserMessage(
        subSessionId,
        `[New task from ${delegatorName}]:\n\n${task}`,
      );
      InterruptController.getInstance().requestSteerInterrupt(subSessionId);
      logger.info('Task injected into active session', { subSid: subSessionId, targetAid: actualAgentId });
      return {
        toolCallId: `delegate-${actualAgentId}`,
        success: true,
        content: `Task injected into existing session for '${actualAgentId}' (${subSessionId}).\n` +
          `The agent is currently working — your task will be picked up on its next turn.`,
        tokensUsed: 0,
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        wasTruncated: false,
      };
    }

    // ── Register with BackgroundTaskManager ──
    const bgManager = BackgroundTaskManager.getInstance();
    const taskId = bgManager.register({
      type: 'subagent',
      parentSessionId,
      parentAgentId,
      summary: task.slice(0, 60),
    });

    // ── Subscribe parent agent to task completion/failure events ──
    // oneShot: true = auto-unsubscribe after first delivery, no manual cleanup needed
    const esm = EventSubscriptionManager.getInstance();
    esm.subscribe(parentSessionId, parentAgentId, `task:completed:${taskId}`, { oneShot: true });
    esm.subscribe(parentSessionId, parentAgentId, `task:failed:${taskId}`, { oneShot: true });

    // Per-event persistence via StreamPersister (unified with main.ts)
    const store = SessionStore.getInstance();
    const turnMsgId = `msg-sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const initialPrevUuid = '00000000-0000-0000-0000-000000000000';
    const { StreamPersister } = await import('../../infra/StreamPersister.js');
    const persister = new StreamPersister(store, subSessionId, turnMsgId, initialPrevUuid);

    // ── Start sub-agent loop in background (non-blocking) ──
    (async () => {
      // Heartbeat timer — sends 'working' status every 5 seconds (WS-only, no message injection)
      // Also detects unresponsive sub-agents and auto-kills them.
      const heartbeatInterval = setInterval(() => {
        const supMgr = SupervisionManager.getInstance();

        // ── Unresponsive detection: kill sub-agent if heartbeat overdue ──
        if (supMgr.isUnresponsive(subSessionId)) {
          logger.warn('Sub-agent unresponsive, auto-killing', {
            subSid: subSessionId,
            targetAid: actualAgentId,
            secondsSinceHeartbeat: supMgr.secondsSinceLastHeartbeat(subSessionId),
          });
          InterruptController.getInstance().requestInterrupt(subSessionId, InterruptReason.Timeout);
          clearInterval(heartbeatInterval);
          return;
        }

        supMgr.setCurrentTool(subSessionId, state.currentTool);
        // Keep the SupervisionManager heartbeat alive — processMessage can't
        // heartbeat when the AgentLoop is in its background-task wait loop.
        supMgr.heartbeat(subSessionId);
        emitDelegationStatus(this, parentSessionId, subSessionId, actualAgentId, {
          phase: 'working',
          taskSummary: task.slice(0, 60),
          turnCount: state.turnCount,
          currentTool: state.currentTool,
          elapsedMs: Date.now() - startedAt,
        });
        // Update BackgroundTaskManager progress (rate-limited internally)
        bgManager.updateProgress(taskId, { turnCount: state.turnCount, currentTool: state.currentTool });
      }, 5000);

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      try {
        // ── Timeout protection: terminate sub-agent loop after 10 minutes ──
        const DELEGATION_TIMEOUT_MS = 600000;
        timeoutHandle = setTimeout(() => {
          logger.warn('Delegation timeout, aborting sub-session', { subSid: subSessionId, targetAid: actualAgentId });
          InterruptController.getInstance().requestInterrupt(subSessionId, InterruptReason.Timeout);
        }, DELEGATION_TIMEOUT_MS);

        // Run the sub-agent's AgentLoop — per-event persistence + event bubbling
        await handleSubAgentOutput(
          this,
          this.processMessage(subSessionId, actualAgentId, delegationMessage),
          parentSessionId,
          subSessionId,
          actualAgentId,
          task.slice(0, 60),
          startedAt,
          persister,
          state,
        );

        clearTimeout(timeoutHandle);
        clearInterval(heartbeatInterval);
        InterruptController.getInstance().unlinkChild(subSessionId);

        const durationMs = Date.now() - startedAt;

        // ── Detect silent failure: AgentLoop produced zero output ──
        if (state.turnCount === 0 && !state.fullContent.trim()) {
          const abortReason = state.fullContent.includes('[ERROR]')
            ? `Sub-agent process error: ${state.fullContent.replace('[ERROR] ', '')}`
            : 'Sub-agent exited immediately with no output. The agent may have failed to start (check model config, API key, or agent setup).';
          logger.warn('Delegation aborted — sub-agent produced no output', { parentSid: parentSessionId, subSid: subSessionId, targetAid: actualAgentId, durationMs });

          emitDelegationStatus(this, parentSessionId, subSessionId, actualAgentId, {
            phase: 'error',
            taskSummary: task.slice(0, 60),
            elapsedMs: durationMs,
          });

          await bgManager.fail(taskId, abortReason, durationMs);
        } else {
          // ── Normal completion ──
          emitDelegationStatus(this, parentSessionId, subSessionId, actualAgentId, {
            phase: 'completed',
            taskSummary: task.slice(0, 60),
            turnCount: state.turnCount,
            elapsedMs: durationMs,
          });

          await bgManager.complete(taskId, { content: state.fullContent, turnCount: state.turnCount, durationMs });
        }

        logger.info('Delegation completed (background)', { parentSid: parentSessionId, subSid: subSessionId, targetAid: actualAgentId, turnCount: state.turnCount, durationMs });
      } catch (err) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        clearInterval(heartbeatInterval);
        InterruptController.getInstance().unlinkChild(subSessionId);
        const errorMessage = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - startedAt;

        logger.error('Delegation failed (background)', { parentSid: parentSessionId, subSid: subSessionId, targetAid: actualAgentId, error: errorMessage.slice(0, 200) });

        // ── Emit delegation_status: error ──
        emitDelegationStatus(this, parentSessionId, subSessionId, actualAgentId, {
          phase: 'error',
          taskSummary: task.slice(0, 60),
          elapsedMs: durationMs,
        });

        // Fail in BackgroundTaskManager (injects error message into parent)
        await bgManager.fail(taskId, errorMessage, durationMs);
      }
    })();

    // ── Return immediately — the CEO continues working ──
    return {
      toolCallId: `delegate-${actualAgentId}`,
      success: true,
      content: `Task dispatched to '${actualAgentId}' (session: ${subSessionId}).\n` +
        `The agent will work on it independently.\n` +
        `Use TaskList to monitor progress, AgentMessage to communicate, or TaskOutput to get the final result when complete.`,
      tokensUsed: 0,
      startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      wasTruncated: false,
    };
  }


  // ── Spawn SubAgent ──

  /**
   * Create a temporary SubAgent and execute a task synchronously. The SubAgent
   * is destroyed after completion (or error). If config.persist is true, the
   * SubAgent survives and is set to Idle for reuse.
   */
  async spawnSubAgent(config: SubAgentConfig, callerAgentId?: string, parentSessionId?: string): Promise<ToolResult> {
    return spawnSubAgent(this, config, callerAgentId, parentSessionId);
  }

  // ── Parallel task orchestration ──

  /**
   * Execute multiple delegated tasks in dependency-ordered parallel batches.
   *
   * @param tasks - Array of {agentId, description, dependsOn?}. dependsOn lists
   *   task IDs (by their 0-based index in the array) that must complete first.
   * @returns Formatted summary string for the delegating agent.
   */
  async executeParallelPlan(
    tasks: Array<{agentId: string; description: string; dependsOn?: string[]}>,
    parentSessionId: string,
    parentAgentId: string,
  ): Promise<string> {
    const logger = createLogger('anochat.agent');
    const dag = new TaskDAG();

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      dag.addTask({
        id: `task-${i}`,
        agentId: t.agentId,
        description: t.description,
        dependsOn: (t.dependsOn || []).map(d => d.startsWith('task-') ? d : `task-${d}`),
        status: 'pending',
      });
    }

    logger.info('executeParallelPlan starting', {
      parentSessionId,
      parentAgentId,
      taskCount: tasks.length,
    });

    const plan = new ExecutionPlan(dag, AgentRegistry.getInstance());
    const results = await plan.execute(parentSessionId, parentAgentId);

    // Format summary
    let summary = `## Parallel Plan Results\n\n${dag.summary()}\n\n`;
    for (const task of dag.tasks.values()) {
      const icon = task.status === 'completed' ? '✓' : '✗';
      summary += `- ${icon} **${task.agentId}**: ${task.description.slice(0, 60)}`;
      if (task.result) {
        summary += `\n  Result: ${task.result.slice(0, 200)}`;
      }
      summary += '\n';
    }

    return summary;
  }

  // ── Session management ──

  /** Check if a session has an active AgentLoop running. */
  isSessionActive(sessionId: string): boolean {
    return this._activeLoops.has(sessionId);
  }

  /** Manually clean up a stuck/broken AgentLoop for a session. */
  cleanupSession(sessionId: string): void {
    this._activeLoops.delete(sessionId);
  }

  /** Subscribe to background task completion/failure notifications (global, called once). */
  private _subscribeToTaskNotifications(): void {
    if (this._taskNotificationsWired) return;
    this._taskNotificationsWired = true;

    const log = createLogger('anochat.agent');

    const handler = (eventName: 'task:completed' | 'task:failed') =>
      (payload: any) => {
        const xml = buildTaskNotificationXML({
          taskId: payload.taskId,
          status: eventName === 'task:completed' ? 'completed' : 'failed',
          type: payload.type,
          summary: payload.summary,
          result: eventName === 'task:completed' ? (payload.content ?? '') : (payload.error ?? ''),
          durationMs: payload.durationMs,
          turnCount: payload.turnCount || undefined,
        });

        const sm = SessionManager.getInstance();
        const timestamp = new Date().toISOString();
        sm.appendMessage(payload.parentSessionId, {
          id: `tn-${payload.taskId}`,
          sessionId: payload.parentSessionId,
          role: MessageRole.User,
          content: xml,
          tokenCount: Math.ceil(xml.length / 4),
          compressed: false,
          timestamp,
          agentId: payload.parentAgentId,
        }).catch(err => {
          log.warn('Failed to inject task notification', { taskId: payload.taskId, error: (err as Error).message });
        });

        // Wake the agent so it sees the notification.
        // If session is idle (no active AgentLoop), start background processing.
        if (this.isSessionActive(payload.parentSessionId)) {
          InterruptController.getInstance().requestSteerInterrupt(payload.parentSessionId);
        } else {
          // Session is idle — start a background AgentLoop with StreamConsumer
          // so the user sees the CEO's streaming response via WebSocket.
          (async () => {
            try {
              const history = await sm.getHistory(payload.parentSessionId).catch(() => []);
              const wakeMessage: Message = {
                id: `tn-msg-${payload.taskId}`,
                sessionId: payload.parentSessionId,
                role: MessageRole.System,
                content: `[System notification] A background task finished. Check the most recent <task-notification> message for details.`,
                tokenCount: 0,
                compressed: false,
                timestamp,
                agentId: payload.parentAgentId,
              };

              const { StreamPersister } = await import('../../infra/StreamPersister.js');
              const { StreamConsumer } = await import('../../infra/stream/StreamConsumer.js');
              const store = SessionStore.getInstance();
              const turnMsgId = `msg-wake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
              const persister = new StreamPersister(store, payload.parentSessionId, turnMsgId, '00000000-0000-0000-0000-000000000000');
              const consumer = new StreamConsumer(WsServer.getInstance(), payload.parentSessionId, persister);

              for await (const event of this.processMessage(payload.parentSessionId, payload.parentAgentId, wakeMessage, history)) {
                switch (event.type) {
                  case 'text':
                    consumer.onDelta('text', event.content as string);
                    break;
                  case 'think':
                    consumer.onDelta('think', event.content as string);
                    break;
                  case 'tool_call':
                    await persister.flushDeltas();
                    await consumer.beforeToolEvent();
                    await persister.persistEvent('tool_call', {
                      id: (event.toolCallId || event.id || event.toolId || '') as string,
                      name: (event.toolName || event.name || '') as string,
                      input: (event.params || event.args || event.input || event.toolInput || {}) as Record<string, unknown>,
                    });
                    consumer.sendDirect(event as unknown as Record<string, unknown>);
                    break;
                  case 'tool_result':
                    await persister.flushDeltas();
                    await consumer.beforeToolEvent();
                    const structured = (event as Record<string, unknown>).structured as Record<string, unknown> | undefined;
                    const todosPayload = structured?.todos as Array<{ content: string; status: string; activeForm: string }> | undefined;
                    await persister.persistEvent('tool_result', {
                      toolCallId: (event.toolCallId || event.toolId || '') as string,
                      is_error: event.success === false,
                      content: (event.result || event.content || '') as string,
                      ...(todosPayload ? { todos: todosPayload } : {}),
                    });
                    if (todosPayload && Array.isArray(todosPayload)) {
                      await persister.persistEvent('todo_write', {
                        todos: todosPayload.map(t => ({ content: t.content, status: t.status, activeForm: t.activeForm })),
                      });
                    }
                    consumer.sendDirect(event as unknown as Record<string, unknown>);
                    break;
                  default:
                    consumer.sendDirect(event as unknown as Record<string, unknown>);
                }
              }
              await consumer.flushAndFinalize();
              sm.rebuildMessageCache(payload.parentSessionId).catch(() => {});
              log.info('Task notification processed by idle agent', { taskId: payload.taskId, sid: payload.parentSessionId });
            } catch (err) {
              log.warn('Task notification background processing error', { taskId: payload.taskId, error: (err as Error).message });
            }
          })();
        }
      };

    TypedEventBus.on('task:completed', handler('task:completed'));
    TypedEventBus.on('task:failed', handler('task:failed'));
  }

  /** Get the number of currently active sessions. */
  get activeSessionCount(): number {
    return this._activeLoops.size;
  }
}

// ── Memory lifecycle helper (lazy-import, fire-and-forget) ───

/** Run post-loop memory lifecycle: auto-extract facts, decay old memories, prune archives. Non-blocking. */
async function runMemoryLifecycle(agentId: string, sessionId: string): Promise<void> {
  try {
    const { runSessionCloseLifecycle } = await import('../memory/lifecycle/MemoryLifecycle.js');
    const mgr = SessionManager.getInstance();
    const history = await mgr.getHistory(sessionId);
    const recent = history.slice(-20);
    const messages = recent.map((m: any) => ({
      role: m.role || 'assistant',
      content: typeof m.content === 'string' ? m.content : '',
    }));
    if (!messages.length) return;
    await runSessionCloseLifecycle(agentId, sessionId, messages);
  } catch { /* lifecycle is best-effort, never throw */ }
}
