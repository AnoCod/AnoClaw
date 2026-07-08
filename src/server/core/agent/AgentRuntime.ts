

import { EventEmitter } from 'events';
import { AgentRegistry } from './AgentRegistry.js';
import { AgentLoop } from './AgentLoop.js';
import type { AgentLoopConfig } from './AgentLoop.js';
import type { Message, SessionGoal } from '../../../shared/types/session.js';
import { MessageRole } from '../../../shared/types/session.js';
import type { SubAgentConfig } from '../../../shared/types/agent.js';
import { AgentRole, AgentStatus } from '../../../shared/types/agent.js';
import type { ToolResult } from '../../../shared/types/tool.js';
import type { SSEEvent } from '../../../shared/types/events.js';
import { SSEEventType, AgentRuntimeEvents } from '../../../shared/types/events.js';
import type { CapabilityRecord, TaskResolveResult } from '../../../shared/types/capability.js';
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
import { SettingsManager } from '../../infra/storage/SettingsManager.js';
import { buildTaskNotificationXML } from './TaskNotification.js';
import {
  bubbleEventToParent,
  emitDelegationStatus,
  handleSubAgentOutput,
  spawnSubAgent,
  subAgentAllowedTools,
  type DelegationState,
} from './AgentDelegation.js';
import { resolveSessionEffort, resolveSessionPermissionMode } from './PermissionModePolicy.js';
import { TaskResolver } from '../capability/TaskResolver.js';

export interface ProcessMessageOptions {
  permissionMode?: string;
  effort?: string;
}

interface UserTaskResolution {
  result: TaskResolveResult;
  agentMissingTools: string[];
}

export class AgentRuntime extends EventEmitter {

  private static _instance: AgentRuntime | null = null;

  static getInstance(): AgentRuntime {
    if (!AgentRuntime._instance) {
      AgentRuntime._instance = new AgentRuntime();
    }
    return AgentRuntime._instance;
  }

  /** Reset the singleton (primarily for testing). */
  static resetInstance(): void {
    if (AgentRuntime._instance) {
      AgentRuntime._instance._unsubTaskCompleted?.();
      AgentRuntime._instance._unsubTaskFailed?.();
    }
    AgentRuntime._instance = null;
  }


  private _taskNotificationsWired = false;
  private _unsubTaskCompleted: (() => void) | null = null;
  private _unsubTaskFailed: (() => void) | null = null;



  private _activeLoops: Map<string, AgentLoop> = new Map();

  private constructor() {
    super();
    this._subscribeToTaskNotifications();
  }



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
    options: ProcessMessageOptions = {},
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
      logger.info('Session active - queuing as pending message (soft interrupt)', { sid: sessionId, aid: agentId });
      InterruptController.getInstance().setPendingUserMessage(sessionId, message.content as string);
      InterruptController.getInstance().requestInterrupt(sessionId, InterruptReason.UserSteer);
      yield {
        type: SSEEventType.StatusInfo,
        content: '(Your message has been queued -- the agent will respond shortly)',
      };
      return;
    }

    const taskResolution = await this._resolveUserTask(sessionId, agent, message, logger);
    if (taskResolution) {
      yield {
        type: SSEEventType.StatusInfo,
        content: this._formatTaskResolutionStatus(taskResolution),
        taskResolution: summarizeTaskResolution(taskResolution.result),
        agentMissingTools: taskResolution.agentMissingTools,
      };

      if (shouldStopForTaskResolution(taskResolution)) {
        if (taskResolution.result.nextAction === 'recommend_plugin') {
          yield {
            type: SSEEventType.TaskResolution,
            taskResolution: summarizeTaskResolution(taskResolution.result),
            agentMissingTools: taskResolution.agentMissingTools,
          };
        }
        yield {
          type: SSEEventType.Text,
          content: this._formatTaskResolutionResponse(taskResolution),
        };
        yield buildImmediateDoneEvent();
        return;
      }
    }


    const lease = SessionLeaseManager.getInstance().acquire(sessionId);
    if (!lease) {
      logger.warn('Too many concurrent sessions - rejecting', { sid: sessionId });
      yield {
        type: SSEEventType.Error,
        errorMessage: 'Server busy -- too many concurrent sessions. Please wait and try again.',
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
      permissionMode: options.permissionMode,
      effort: options.effort,
      extraAllowedTools: taskResolutionExtraTools(taskResolution),
    };

    const loop = new AgentLoop(loopConfig);
    this._activeLoops.set(sessionId, loop);

    try {
      // Run the AgentLoop
      const effectiveHistory = this._historyWithTaskResolution(history, sessionId, taskResolution);
      yield* this._executeAndForwardLoop(loop, message, effectiveHistory, signal, sessionId, agentId, logger);

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


      runMemoryLifecycle(agentId, sessionId).catch(() => {});

      // Goal mode: keep advancing the active root-session goal after completion.
      const sessionManager = SessionManager.getInstance();
      yield* this._runGoalMode(sessionId, sessionManager, loopConfig, signal);

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



  /**
   * Run the AgentLoop, emitting AgentRuntime events, heartbeating supervision,
   * and forwarding SSE events to the caller.
   */
  private async *_executeAndForwardLoop(
    loop: AgentLoop,
    message: Message,
    history: Message[],
    signal: AbortSignal,
    sessionId: string,
    agentId: string,
    logger: ReturnType<typeof createLogger>,
  ): AsyncGenerator<SSEEvent> {
    let supervisionCheckCounter = 0;

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

      // Refresh heartbeat on every event -- proves the agent is still alive
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
            content: '(Warning: session heartbeat overdue -- agent may be unresponsive)',
          };
        }
      }
    }
  }

  // Goal mode loop

  /**
   * Keep the session alive after the main AgentLoop completes while a root
   * session goal is active. Goal state lives in root-session metadata.
   */
  private async *_runGoalMode(
    sessionId: string,
    sessionManager: ReturnType<typeof SessionManager.getInstance>,
    loopConfig: AgentLoopConfig,
    signal: AbortSignal,
  ): AsyncGenerator<SSEEvent> {
    const session = sessionManager.session(sessionId);
    if (session && !session.isRoot()) return;

    while (true) {
      const goal = sessionManager.getGoal(sessionId);
      if (!goal || goal.status !== 'active') break;

      yield { type: SSEEventType.Sleep, content: '(Goal active -- waiting before next step)' };

      await this._sleepUntilGoalWake(signal, 3000);
      if (signal.aborted) {
        const interruptController = InterruptController.getInstance();
        const pending = interruptController.takePendingUserMessage(sessionId);
        if (!pending) break;

        yield { type: SSEEventType.StatusInfo, content: '(Processing your new message...)' };
        signal = interruptController.createController(sessionId).signal;

        const fullHistory = await sessionManager.getHistory(sessionId);
        const pendingMessage = this._takeLatestPendingUserMessage(fullHistory, pending, sessionId);
        const loopHistory = fullHistory
          .filter((m) => m.id !== pendingMessage.id);
        const freshLoopConfig: AgentLoopConfig = {
          ...loopConfig,
          permissionMode: resolveSessionPermissionMode(sessionManager, sessionId),
          effort: resolveSessionEffort(sessionManager, sessionId),
        };
        const newLoop = new AgentLoop(freshLoopConfig);
        this._activeLoops.set(sessionId, newLoop);
        yield { type: SSEEventType.Wake, content: '(Goal wake -- processing user message)' };
        try {
          for await (const evt of newLoop.run(pendingMessage, loopHistory, signal)) {
            yield evt;
            SupervisionManager.getInstance().heartbeat(sessionId);
          }
        } finally {
          this._activeLoops.delete(sessionId);
        }
        continue;
      }

      const currentGoal = sessionManager.getGoal(sessionId);
      if (!currentGoal || currentGoal.status !== 'active') {
        yield { type: SSEEventType.StatusInfo, content: '(Goal paused or deleted)' };
        break;
      }

      try {
        const freshPermissionMode = resolveSessionPermissionMode(sessionManager, sessionId);
        const freshEffort = resolveSessionEffort(sessionManager, sessionId);
        const settings = SettingsManager.getInstance();
        const userMode = settings.get<string>('ui.userMode', 'simple');
        const locale = settings.get<string>('ui.lang', 'zh-CN');
        const root = sessionManager.getRootSession(sessionId);
        const taskResolution = await this._resolveGoalTask(currentGoal.objective, userMode, locale);
        const runGoal = await sessionManager.touchGoalRun(sessionId, {
          workspace: root.workspace,
          permissionMode: freshPermissionMode,
          effort: freshEffort,
          userMode,
        }) || currentGoal;
        WsServer.getInstance().send(root.id, {
          type: SSEEventType.GoalChanged,
          sessionId: root.id,
          action: 'run',
          goal: runGoal,
        });
        const content = buildGoalContinuationContent({
          sessionId,
          goal: runGoal,
          workspace: root.workspace,
          permissionMode: freshPermissionMode,
          effort: freshEffort,
          userMode,
          locale,
          taskResolution,
        });
        const goalMessage: Message = {
          id: `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          sessionId,
          role: MessageRole.User,
          content,
          tokenCount: 0,
          compressed: false,
          timestamp: new Date().toISOString(),
        };
        await sessionManager.appendMessage(sessionId, goalMessage, { notify: false });

        const fullHistory = await sessionManager.getHistory(sessionId);
        const loopHistory = fullHistory.filter((m) => m.id !== goalMessage.id);
        const freshLoopConfig: AgentLoopConfig = {
          ...loopConfig,
          permissionMode: freshPermissionMode,
          effort: freshEffort,
        };
        const newLoop = new AgentLoop(freshLoopConfig);
        this._activeLoops.set(sessionId, newLoop);
        yield { type: SSEEventType.Wake, content: '(Goal wake -- continuing active goal)' };
        try {
          for await (const evt of newLoop.run(goalMessage, loopHistory, signal)) {
            yield evt;
            SupervisionManager.getInstance().heartbeat(sessionId);
          }
        } finally {
          this._activeLoops.delete(sessionId);
        }
      } catch (err) {
        createLogger('anochat.agent').warn('Goal mode sub-loop error', { sid: sessionId, error: (err as Error).message });
        yield { type: SSEEventType.Error, errorMessage: `Goal mode error: ${(err as Error).message}`, code: 'GOAL_LOOP_ERROR' };
      }

      SupervisionManager.getInstance().heartbeat(sessionId);
    }
  }

  private async _resolveUserTask(
    sessionId: string,
    agent: { role: AgentRole; allowedTools(): string[] },
    message: Message,
    logger: ReturnType<typeof createLogger>,
  ): Promise<UserTaskResolution | null> {
    if (message.role !== MessageRole.User) return null;
    if (agent.role !== AgentRole.MainAgent) return null;
    if (typeof message.content !== 'string' || !message.content.trim()) return null;

    const session = SessionManager.getInstance().session(sessionId);
    if (session && !session.isRoot()) return null;

    try {
      const settings = SettingsManager.getInstance();
      const result = await new TaskResolver().resolve({
        message: message.content,
        userMode: settings.get<string>('ui.userMode', 'simple'),
        locale: settings.get<string>('ui.lang', 'zh-CN'),
        includeUnavailable: true,
      });
      if (result.intent !== 'capability' || !result.bestCapability) return null;

      const agentMissingTools: string[] = [];
      logger.info('User task resolved to capability', {
        sid: sessionId,
        capabilityId: result.bestCapability.id,
        nextAction: result.nextAction,
        missingTools: result.missingTools,
        autoGrantedTools: taskResolutionToolNames(result),
      });
      return { result, agentMissingTools };
    } catch (err) {
      logger.warn('Task resolution failed; falling back to normal agent loop', {
        sid: sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async _resolveGoalTask(
    objective: string,
    userMode: string,
    locale: string,
  ): Promise<TaskResolveResult | null> {
    try {
      const result = await new TaskResolver().resolve({
        message: objective,
        userMode,
        locale,
        includeUnavailable: true,
      });
      return result.intent === 'capability' && result.bestCapability ? result : null;
    } catch (err) {
      createLogger('anochat.agent').debug('Goal task resolution skipped', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private _historyWithTaskResolution(
    history: Message[],
    sessionId: string,
    taskResolution: UserTaskResolution | null,
  ): Message[] {
    if (!taskResolution || shouldStopForTaskResolution(taskResolution)) return history;
    const context = buildTaskResolutionContext(taskResolution);
    if (!context) return history;
    return [
      ...history,
      {
        id: `task-resolution-${Date.now().toString(36)}`,
        sessionId,
        role: MessageRole.System,
        content: context,
        tokenCount: 0,
        compressed: false,
        timestamp: new Date().toISOString(),
      },
    ];
  }

  private _formatTaskResolutionStatus(taskResolution: UserTaskResolution): string {
    const capability = taskResolution.result.bestCapability;
    if (!capability) return 'Task understood.';
    const action = taskResolution.agentMissingTools.length > 0 ? 'enable_tools' : taskResolution.result.nextAction;
    if (isLikelyChinese(taskResolution.result.query)) {
      if (action === 'execute_capability') return `已识别任务：${capability.title}。`;
      if (action === 'ask_user') return `已识别任务：${capability.title}，还需要补充信息。`;
      if (action === 'enable_tools') return `已识别任务：${capability.title}，但当前 Agent 还没启用所需工具。`;
      return `已识别任务：${capability.title}，但需要先准备插件能力。`;
    }
    if (action === 'execute_capability') return `Resolved task: ${capability.title}.`;
    if (action === 'ask_user') return `Resolved task: ${capability.title}; more input is needed.`;
    if (action === 'enable_tools') return `Resolved task: ${capability.title}; required tools are not enabled for this agent.`;
    return `Resolved task: ${capability.title}; a plugin capability is required.`;
  }

  private _formatTaskResolutionResponse(taskResolution: UserTaskResolution): string {
    const capability = taskResolution.result.bestCapability;
    if (!capability) return taskResolution.result.suggestedResponse;

    if (taskResolution.agentMissingTools.length > 0) {
      const tools = taskResolution.agentMissingTools.join(', ');
      if (isLikelyChinese(taskResolution.result.query)) {
        return [
          `我识别到你想使用「${capability.title}」能力，但当前 MainAgent 还不能调用所需工具：${tools}。`,
          '',
          '请先在 Agent 的工具白名单里启用这些工具，或安装/启用提供该能力的插件；启用后你可以直接用同一句话让我继续完成。',
        ].join('\n');
      }
      return [
        `I recognized this as "${capability.title}", but MainAgent cannot use the required tools yet: ${tools}.`,
        '',
        'Enable those tools for the agent, or install/enable the plugin that provides them, then ask the same request again.',
      ].join('\n');
    }

    if (taskResolution.result.nextAction === 'ask_user') {
      const fields = taskResolution.result.missingInputs.map((field) => field.label || field.name).join(', ');
      if (isLikelyChinese(taskResolution.result.query)) {
        return `我可以处理「${capability.title}」，但还需要你补充：${fields}。`;
      }
      return `I can handle "${capability.title}", but I still need: ${fields}.`;
    }

    if (taskResolution.result.nextAction === 'recommend_plugin') {
      const pluginLines = formatPluginRecommendationLines(taskResolution.result, isLikelyChinese(taskResolution.result.query));
      const tools = taskResolution.result.missingTools.length > 0
        ? taskResolution.result.missingTools.join(', ')
        : '';
      if (isLikelyChinese(taskResolution.result.query)) {
        return [
          `我识别到你想使用「${capability.title}」能力，但 AnoClaw 当前还没有准备好对应能力。`,
          '',
          ...pluginLines,
          tools ? `缺少工具：${tools}。` : '',
          '插件启用或安装完成后，你可以直接用同一句话让我继续完成。',
        ].filter(Boolean).join('\n');
      }
      return [
        `I recognized this as "${capability.title}", but AnoClaw does not have the required plugin/tool ready yet.`,
        '',
        ...pluginLines,
        tools ? `Missing tools: ${tools}.` : '',
        'Once it is ready, you can ask the same request again and I can continue.',
      ].filter(Boolean).join('\n');
    }

    return taskResolution.result.suggestedResponse;
  }

  private _sleepUntilGoalWake(signal: AbortSignal, ms: number): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => done();
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private _takeLatestPendingUserMessage(history: Message[], content: string, sessionId: string): Message {
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (msg.role === MessageRole.User && msg.content === content) {
        return msg;
      }
    }
    return {
      id: `interrupt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      role: MessageRole.User,
      content,
      tokenCount: 0,
      compressed: false,
      timestamp: new Date().toISOString(),
    };
  }



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
    priority: string = 'normal',
  ): Promise<ToolResult> {

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

      InterruptController.getInstance().linkChild(parentSessionId, subSessionId);
      logger.info('Sub-session created for delegation', { parentSid: parentSessionId, subSid: subSessionId, targetAid: actualAgentId });

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


    // Append a structured summary of the parent conversation so the sub-agent
    // understands the broader goal (prevents "memory rupture").
    const taskParts: string[] = [task];
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
        taskParts.push('\n\n---\n# Parent Session Context\n' + contextParts.join('\n'));
      }
    } catch {}

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
          .map(e => `[${e.writtenBy}]: ${e.key}=${String(e.value).slice(0, 200)}`)
          .join('\n');
        taskParts.push('\n\n---\n# Shared Context (live updates from team)\n' + contextSummary);
      }
    } catch { /* non-critical */ }

    const enrichedTask = taskParts.join('');

    // Build delegation message
    const parentAgent = AgentRegistry.getInstance().agent(parentAgentId);
    const delegatorName = parentAgent?.name || parentAgentId;
    const delegationMessage: Message = {
      id: `delegate-msg-${Date.now()}`,
      sessionId: subSessionId,
      role: MessageRole.System,
      content: `[Task delegated by ${delegatorName} (priority: ${priority})]:\n\n${enrichedTask}`,
      tokenCount: TokenCounter.estimate(`[Task delegated by ${delegatorName} (priority: ${priority})]:\n\n${enrichedTask}`),
      compressed: false,
      timestamp: new Date().toISOString(),
      agentId: parentAgentId,
      agentName: delegatorName,
    };

    const startedAt = Date.now();


    const state: DelegationState = {
      fullContent: '',
      thinking: '',
      turnCount: 0,
      currentTool: undefined,
    };


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
      InterruptController.getInstance().wakeOnly(subSessionId);
      logger.info('Task injected into active session', { subSid: subSessionId, targetAid: actualAgentId });
      return {
        toolCallId: `delegate-${actualAgentId}`,
        success: true,
        content: `Task injected into existing session for '${actualAgentId}' (${subSessionId}).\n` +
          `The agent is currently working -- your task will be picked up on its next turn.`,
        structured: {
          status: 'queued',
          type: 'subagent',
          subSessionId,
          targetAgentId: actualAgentId,
          parentSessionId,
          parentAgentId,
          priority,
          background: false,
          activeSession: true,
        },
        tokensUsed: 0,
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        wasTruncated: false,
      };
    }


    const bgManager = BackgroundTaskManager.getInstance();
    const taskId = bgManager.register({
      type: 'subagent',
      parentSessionId,
      parentAgentId,
      summary: task.slice(0, 60),
    });


    // oneShot: true = auto-unsubscribe after first delivery, no manual cleanup needed
    const esm = EventSubscriptionManager.getInstance();
    esm.subscribe(parentSessionId, parentAgentId, `task:completed:${taskId}`, { oneShot: true });
    esm.subscribe(parentSessionId, parentAgentId, `task:failed:${taskId}`, { oneShot: true });

    // Per-event persistence via StreamPersister (unified with main.ts)
    const store = SessionStore.getInstance();
    const turnMsgId = `msg-sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const initialPrevUuid = '00000000-0000-0000-0000-000000000000';
    const { StreamPersister } = await import('../../infra/StreamPersister.js');
    const persister = new StreamPersister(store, subSessionId, turnMsgId, initialPrevUuid, actualAgentId);


    (async () => {
      let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      try {

        // Also detects unresponsive sub-agents and auto-kills them.
        heartbeatInterval = setInterval(() => {
          const supMgr = SupervisionManager.getInstance();


          if (supMgr.isUnresponsive(subSessionId)) {
            logger.warn('Sub-agent unresponsive, auto-killing', {
              subSid: subSessionId,
              targetAid: actualAgentId,
              secondsSinceHeartbeat: supMgr.secondsSinceLastHeartbeat(subSessionId),
            });
            InterruptController.getInstance().requestInterrupt(subSessionId, InterruptReason.Timeout);
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            return;
          }

          supMgr.setCurrentTool(subSessionId, state.currentTool);

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


        const DELEGATION_TIMEOUT_MS = 600000;
        timeoutHandle = setTimeout(() => {
          logger.warn('Delegation timeout, aborting sub-session', { subSid: subSessionId, targetAid: actualAgentId });
          InterruptController.getInstance().requestInterrupt(subSessionId, InterruptReason.Timeout);
        }, DELEGATION_TIMEOUT_MS);


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

        const durationMs = Date.now() - startedAt;


        if (state.turnCount === 0 && !state.fullContent.trim()) {
          const abortReason = state.fullContent.includes('[ERROR]')
            ? `Sub-agent process error: ${state.fullContent.replace('[ERROR] ', '')}`
            : 'Sub-agent exited immediately with no output. The agent may have failed to start (check model config, API key, or agent setup).';
          logger.warn('Delegation aborted - sub-agent produced no output', { parentSid: parentSessionId, subSid: subSessionId, targetAid: actualAgentId, durationMs });

          emitDelegationStatus(this, parentSessionId, subSessionId, actualAgentId, {
            phase: 'error',
            taskSummary: task.slice(0, 60),
            elapsedMs: durationMs,
          });

          await bgManager.fail(taskId, abortReason, durationMs);
        } else {

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
        const errorMessage = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - startedAt;

        logger.error('Delegation failed (background)', { parentSid: parentSessionId, subSid: subSessionId, targetAid: actualAgentId, error: errorMessage.slice(0, 200) });


        emitDelegationStatus(this, parentSessionId, subSessionId, actualAgentId, {
          phase: 'error',
          taskSummary: task.slice(0, 60),
          elapsedMs: durationMs,
        });

        // Fail in BackgroundTaskManager (injects error message into parent)
        await bgManager.fail(taskId, errorMessage, durationMs);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        InterruptController.getInstance().unlinkChild(subSessionId);
      }
    })();


    return {
      toolCallId: `delegate-${actualAgentId}`,
      success: true,
      content: `Task dispatched to '${actualAgentId}' (session: ${subSessionId}).\n` +
        `Task ID: ${taskId}\n` +
        `The agent will work on it independently.\n` +
        `Use TaskList to monitor progress, AgentMessage to communicate, or TaskOutput to get the final result when complete.`,
      structured: {
        taskId,
        status: 'running',
        type: 'subagent',
        subSessionId,
        targetAgentId: actualAgentId,
        parentSessionId,
        parentAgentId,
        priority,
        background: true,
      },
      tokensUsed: 0,
      startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      wasTruncated: false,
    };
  }




  /**
   * Create a temporary SubAgent and execute a task synchronously. The SubAgent
   * is destroyed after completion (or error). If config.persist is true, the
   * SubAgent survives and is set to Idle for reuse.
   */
  async spawnSubAgent(config: SubAgentConfig, callerAgentId?: string, parentSessionId?: string): Promise<ToolResult> {
    return spawnSubAgent(this, config, callerAgentId, parentSessionId);
  }



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
      const icon = task.status === 'completed' ? '[done]' : '[pending]';
      summary += `- ${icon} **${task.agentId}**: ${task.description.slice(0, 60)}`;
      if (task.result) {
        summary += `\n  Result: ${task.result.slice(0, 200)}`;
      }
      summary += '\n';
    }

    return summary;
  }



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
        const parentAgent = AgentRegistry.getInstance().agent(payload.parentAgentId);
        if (!parentAgent) {
          log.warn('Skipping task notification for missing parent agent', {
            taskId: payload.taskId,
            sid: payload.parentSessionId,
            aid: payload.parentAgentId,
          });
          return;
        }

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
              const persister = new StreamPersister(store, payload.parentSessionId, turnMsgId, '00000000-0000-0000-0000-000000000000', payload.parentAgentId);
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
                  case 'error':
                    await consumer.beforeToolEvent();
                    await persister.persistEvent('error', {
                      error: (event.errorMessage || event.message || event.content || 'Unknown error') as string,
                      source: 'task_notification',
                    });
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

    this._unsubTaskCompleted = TypedEventBus.on('task:completed', handler('task:completed'));
    this._unsubTaskFailed = TypedEventBus.on('task:failed', handler('task:failed'));
  }

  /** Get the number of currently active sessions. */
  get activeSessionCount(): number {
    return this._activeLoops.size;
  }
}

export interface GoalContinuationContext {
  sessionId: string;
  goal: SessionGoal;
  workspace: string;
  permissionMode: string;
  effort: 'HIGH' | 'NORMAL';
  userMode: string;
  locale?: string;
  taskResolution?: TaskResolveResult | null;
}

export function buildGoalContinuationContent(ctx: GoalContinuationContext): string {
  const lines = [
    'Continue working toward the active session goal.',
    '',
    '# Active Goal',
    `Objective: ${ctx.goal.objective}`,
    `Status: ${ctx.goal.status}`,
    `Run count: ${ctx.goal.runCount || 0}`,
    ctx.goal.lastRunAt ? `Last run: ${ctx.goal.lastRunAt}` : '',
    '',
    '# Current Execution Context',
    `Session: ${ctx.sessionId}`,
    `Workspace: ${ctx.workspace || '(default workspace)'}`,
    `Permission mode: ${ctx.permissionMode}`,
    `Effort: ${ctx.effort}`,
    `User mode: ${ctx.userMode}`,
    ctx.locale ? `Locale: ${ctx.locale}` : '',
  ].filter(Boolean);

  const routing = formatGoalTaskRouting(ctx.taskResolution || null);
  if (routing.length > 0) {
    lines.push('', '# Goal Capability Routing', ...routing);
  }

  lines.push('', '# Goal Execution Rules');
  lines.push(
    '- Treat the workspace as the primary working context. Inspect current files, artifacts, and project state before broad assumptions.',
    '- Advance exactly one meaningful next step unless the goal clearly requires a short burst of tightly coupled steps.',
    '- Prefer durable artifacts, code changes, tests, or concrete workspace updates over vague progress summaries.',
    '- If the goal is already complete, say so clearly and stop taking further action.',
    '- If blocked, name the blocker, preserve useful partial work, and suggest the next concrete unblock action.',
  );

  if (ctx.userMode === 'coding') {
    lines.push(
      '- Coding mode: start from the current IDE/workspace context, inspect relevant files before edits, and run focused build/test checks after changes.',
    );
  } else if (ctx.userMode === 'office') {
    lines.push(
      '- Office mode: prefer Artifact and Workspace outputs such as documents, reports, slides, spreadsheets, previews, and downloadable files.',
    );
  } else if (ctx.userMode === 'professional') {
    lines.push(
      '- Professional mode: expose concise tool/log reasoning when it helps verify correctness, plugin behavior, or workflow state.',
    );
  }

  if (ctx.permissionMode === 'Plan') {
    lines.push(
      '- Plan mode is active: do not write files or run destructive commands. Produce the next plan, inspection, or verification step only.',
    );
  } else if (ctx.permissionMode === 'Ask') {
    lines.push(
      '- Ask mode is active: request confirmation before file changes, command execution, or other side effects.',
    );
  }

  return lines.join('\n');
}

function shouldStopForTaskResolution(taskResolution: UserTaskResolution): boolean {
  return taskResolution.agentMissingTools.length > 0
    || taskResolution.result.nextAction === 'ask_user'
    || taskResolution.result.nextAction === 'recommend_plugin';
}

function formatGoalTaskRouting(result: TaskResolveResult | null): string[] {
  if (!result?.bestCapability) return [];
  const capability = result.bestCapability;
  const lines = [
    `Resolved capability: ${capability.id}`,
    `Capability title: ${capability.title}`,
    `Domain: ${capability.domain}`,
    `Next action: ${result.nextAction}`,
    `Confidence: ${result.confidence.toFixed(2)}`,
    `Reason: ${result.reason}`,
  ];

  const tools = capabilityToolNames(capability);
  if (tools.length > 0) lines.push(`Relevant tools: ${tools.join(', ')}`);
  if (result.missingTools.length > 0) lines.push(`Missing tools: ${result.missingTools.join(', ')}`);
  if (result.missingInputs.length > 0) {
    lines.push(`Missing inputs: ${result.missingInputs.map((input) => input.label || input.name).join(', ')}`);
  }
  if (result.recommendedPlugins.length > 0) {
    lines.push(`Recommended plugins: ${result.recommendedPlugins.join(', ')}`);
  }
  if (result.suggestedToolCall) {
    lines.push(`Suggested first tool call: ${result.suggestedToolCall.toolName}`);
    lines.push(`Suggested tool parameters: ${JSON.stringify(result.suggestedToolCall.parameters)}`);
    if (result.suggestedToolCall.notes.length > 0) {
      lines.push(`Tool call notes: ${result.suggestedToolCall.notes.join(' ')}`);
    }
  }

  return lines;
}

function buildTaskResolutionContext(taskResolution: UserTaskResolution): string {
  const { result } = taskResolution;
  const capability = result.bestCapability;
  if (!capability) return '';

  const requiredTools = capabilityToolNames(capability);
  const outputs = (capability.outputs || [])
    .map((output) => [output.label, output.extension, output.artifactType].filter(Boolean).join(' / '))
    .filter(Boolean);

  const lines = [
    '[AnoClaw task routing]',
    `User request resolved to capability: ${capability.id}`,
    `Capability title: ${capability.title}`,
    `Domain: ${capability.domain}`,
    `Kind: ${capability.kind || 'utility'}`,
    `User mode: ${result.userMode}`,
    `Confidence: ${result.confidence.toFixed(2)}`,
    `Reason: ${result.reason}`,
  ];

  if (requiredTools.length > 0) {
    lines.push(`Prefer these tools for this task when available: ${requiredTools.join(', ')}`);
  }
  if (capability.domain === 'coding') {
    lines.push(
      'Coding route: use the existing workspace/IDE context as the first signal. If the Editor Context section shows an active file, open files, or selected text, inspect that before broad repository search.',
      'For implementation tasks, prefer Read/Grep/Glob/Edit/Write for code changes and Bash only for git inspection, tests, builds, or package commands.',
      'For review tasks, inspect changed lines first and return findings first with file and line references when possible.',
    );
  }
  if (result.suggestedToolCall) {
    lines.push(`Suggested first tool call: ${result.suggestedToolCall.toolName}`);
    lines.push(`Suggested tool parameters: ${JSON.stringify(result.suggestedToolCall.parameters)}`);
    if (result.suggestedToolCall.notes.length > 0) {
      lines.push(`Tool call notes: ${result.suggestedToolCall.notes.join(' ')}`);
    }
  }
  if (capability.skills?.length) {
    lines.push(`Relevant skills: ${capability.skills.join(', ')}`);
  }
  if (outputs.length > 0) {
    lines.push(`Expected outputs: ${outputs.join('; ')}`);
  }
  if (result.assumptions.length > 0) {
    lines.push(`Assumptions: ${result.assumptions.join('; ')}`);
  }

  lines.push(
    'Use this routing as the task plan. Do not ask the user to restate the same request.',
    'If a required tool is not visible in your available tool list, explain that the tool must be enabled for this agent before execution.',
  );
  return lines.join('\n');
}

function summarizeTaskResolution(result: TaskResolveResult): Record<string, unknown> {
  return {
    intent: result.intent,
    query: result.query,
    userMode: result.userMode,
    locale: result.locale,
    confidence: result.confidence,
    nextAction: result.nextAction,
    canStart: result.canStart,
    bestCapability: result.bestCapability ? {
      id: result.bestCapability.id,
      title: result.bestCapability.title,
      domain: result.bestCapability.domain,
      status: result.bestCapability.status,
      source: result.bestCapability.source,
      sourceName: result.bestCapability.sourceName,
      pluginName: result.bestCapability.pluginName,
    } : undefined,
    missingInputs: result.missingInputs.map((input) => ({
      name: input.name,
      label: input.label,
      type: input.type,
    })),
    missingTools: result.missingTools,
    recommendedPlugins: result.recommendedPlugins,
    pluginRecommendations: result.pluginRecommendations,
    suggestedToolCall: result.suggestedToolCall,
    reason: result.reason,
  };
}

function capabilityToolNames(capability: CapabilityRecord): string[] {
  return uniqueStrings([
    ...(capability.requiredTools || []),
    ...(capability.tools || []),
  ]);
}

function taskResolutionExtraTools(taskResolution: UserTaskResolution | null): string[] {
  if (!taskResolution || shouldStopForTaskResolution(taskResolution)) return [];
  return taskResolutionToolNames(taskResolution.result);
}

function taskResolutionToolNames(result: TaskResolveResult): string[] {
  return result.bestCapability ? capabilityToolNames(result.bestCapability) : [];
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function formatPluginRecommendationLines(result: TaskResolveResult, chinese: boolean): string[] {
  const recommendations = result.pluginRecommendations;
  if (recommendations.length === 0) {
    const fallback = result.recommendedPlugins.length > 0
      ? result.recommendedPlugins.join(', ')
      : (chinese ? '能提供该能力的插件' : 'a plugin that provides this capability');
    return [chinese ? `建议插件：${fallback}。` : `Recommended plugin: ${fallback}.`];
  }

  return recommendations.map((plugin) => {
    const name = plugin.displayName && plugin.displayName !== plugin.pluginName
      ? `${plugin.displayName} (${plugin.pluginName})`
      : plugin.pluginName;

    if (chinese) {
      if (plugin.status === 'installed') return `建议启用插件：${name}。`;
      if (plugin.status === 'activated' && plugin.action === 'reload') return `建议重载插件：${name}。`;
      if (plugin.status === 'activated') return `插件 ${name} 已启用，但能力仍未完整就绪。`;
      if (plugin.status === 'error') return `插件 ${name} 当前加载异常，需要检查插件详情。`;
      if (plugin.installable) return `建议从插件市场安装：${name}。`;
      return `建议插件：${name}，但当前未安装。`;
    }

    if (plugin.status === 'installed') return `Recommended action: activate ${name}.`;
    if (plugin.status === 'activated' && plugin.action === 'reload') return `Recommended action: reload ${name}.`;
    if (plugin.status === 'activated') return `${name} is active, but the capability is still incomplete.`;
    if (plugin.status === 'error') return `${name} has a load error; inspect the plugin details.`;
    if (plugin.installable) return `Recommended action: install ${name} from the plugin marketplace.`;
    return `Recommended plugin: ${name}, but it is not installed.`;
  });
}

function isLikelyChinese(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value);
}

function buildImmediateDoneEvent(): SSEEvent {
  return {
    type: SSEEventType.Done,
    tokenUsage: {
      systemPrompt: 0,
      systemTools: 0,
      skills: 0,
      messages: 0,
      freeSpace: 0,
      total: 0,
    },
  };
}



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
