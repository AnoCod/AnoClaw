

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
import { SessionLeaseManager } from '../session/SessionLeaseManager.js';
import { createLogger } from '../logger.js';
import { SupervisionManager } from './supervision/SupervisionManager.js';
import { TypedEventBus } from '../events/index.js';
import { TokenCounter } from '../context/index.js';
import { WsServer } from '../../infra/network/WsServer.js';
import { SettingsManager } from '../../infra/storage/SettingsManager.js';
import { buildTaskNotificationXML } from './TaskNotification.js';
import {
  spawnSubAgent,
} from './AgentDelegation.js';
import {
  activeGoalPermissionMode,
  resolveSessionEffort,
  resolveSessionPermissionMode,
} from './PermissionModePolicy.js';
import { TaskResolver } from '../capability/TaskResolver.js';
import type { CoordinationTask } from '../../../shared/types/coordination.js';
import {
  CANCELLATION_REQUESTED_BLOCKER,
  CoordinationService,
} from '../coordination/CoordinationService.js';
import { buildTaskPacket, renderTaskPacket } from '../coordination/TaskPacketBuilder.js';
import { WorkspaceLeaseService } from '../coordination/WorkspaceLeaseService.js';

export interface ProcessMessageOptions {
  permissionMode?: string;
  effort?: string;
  goalKick?: boolean;
  systemPromptOverride?: string;
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

    const taskResolution = options.goalKick
      ? null
      : await this._resolveUserTask(sessionId, agent, message, logger);
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

    const sessionManager = SessionManager.getInstance();
    await sessionManager.setRuntimeStatus(sessionId, 'Active').catch(() => {});
    const resolvedPermissionMode = resolveSessionPermissionMode(sessionManager, sessionId, options.permissionMode);
    const resolvedEffort = resolveSessionEffort(sessionManager, sessionId, options.effort);
    let activeGoal: SessionGoal | null = null;
    try {
      activeGoal = sessionManager.getGoal(sessionId);
    } catch {
      // Some internal/test callers can invoke the runtime before session recovery.
    }

    // Build AgentLoop configuration from agent config
    const loopConfig: AgentLoopConfig = {
      agentId: agent.id,
      sessionId,
      maxTurns: agent.maxTurns,
      temperature: agent.temperature,
      contextWindow: agent.contextWindow,
      permissionMode: resolvedPermissionMode,
      effort: resolvedEffort,
      workspace: activeGoal?.status === 'active' ? activeGoal.workspace : undefined,
      extraAllowedTools: [
        ...taskResolutionExtraTools(taskResolution),
      ],
      systemPromptOverride: options.systemPromptOverride,
    };

    const loop = new AgentLoop(loopConfig);
    this._activeLoops.set(sessionId, loop);

    try {
      if (!options.goalKick) {
        // Run the user-requested AgentLoop. A goal kick skips this transient
        // bootstrap turn and enters the bounded Goal runner directly.
        const effectiveHistory = this._historyWithTaskResolution(history, sessionId, taskResolution);
        yield* this._executeAndForwardLoop(loop, message, effectiveHistory, signal, sessionId, agentId, logger);

        agent.setSessionStatus(sessionId, AgentStatus.Working);
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
      }

      // Goal mode: keep advancing the active root-session goal after completion.
      yield* this._runGoalMode(sessionId, sessionManager, loopConfig, signal, options.goalKick === true);

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
      await sessionManager.setRuntimeStatus(sessionId, 'Idle').catch(() => {});
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
    startImmediately = false,
  ): AsyncGenerator<SSEEvent> {
    const session = sessionManager.session(sessionId);
    if (session && !session.isRoot()) return;

    let immediate = startImmediately;
    while (true) {
      const goal = sessionManager.getGoal(sessionId);
      if (!goal || goal.status !== 'active') break;

      const scheduledAt = goal.nextRunAt ? Date.parse(goal.nextRunAt) : Date.now() + goal.wakeIntervalMs;
      const waitMs = immediate && !goal.nextRunAt
        ? 0
        : Math.max(0, Number.isFinite(scheduledAt) ? scheduledAt - Date.now() : goal.wakeIntervalMs);
      immediate = false;
      if (waitMs > 0) {
        yield { type: SSEEventType.Sleep, content: '(Goal active -- waiting for the next scheduled run)' };
        await this._sleepUntilGoalWake(signal, waitMs);
      }
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
        for await (const evt of newLoop.run(pendingMessage, loopHistory, signal)) {
          yield evt;
          SupervisionManager.getInstance().heartbeat(sessionId);
        }
        continue;
      }

      const currentGoal = sessionManager.getGoal(sessionId);
      if (!currentGoal || currentGoal.status !== 'active') {
        yield { type: SSEEventType.StatusInfo, content: '(Goal paused or deleted)' };
        break;
      }

      try {
        const freshPermissionMode = activeGoalPermissionMode(currentGoal.permissionMode);
        const freshEffort = resolveSessionEffort(sessionManager, sessionId);
        const settings = SettingsManager.getInstance();
        const userMode = settings.get<string>('ui.userMode', 'simple');
        const locale = settings.get<string>('ui.lang', 'zh-CN');
        const root = sessionManager.getRootSession(sessionId);
        const taskResolution = await this._resolveGoalTask(
          `${currentGoal.objective}\nAcceptance criteria: ${currentGoal.acceptanceCriteria}`,
          userMode,
          locale,
        );
        const resolutionBlocker = goalResolutionBlocker(taskResolution);
        if (resolutionBlocker) {
          const blocked = await sessionManager.updateGoalStatus(sessionId, 'blocked', resolutionBlocker);
          WsServer.getInstance().send(root.id, {
            type: SSEEventType.GoalChanged,
            sessionId: root.id,
            action: 'blocked',
            goal: blocked,
          });
          yield { type: SSEEventType.StatusInfo, content: `(Goal blocked: ${resolutionBlocker})` };
          break;
        }

        const runGoal = await sessionManager.beginGoalRun(sessionId, {
          workspace: currentGoal.workspace,
          permissionMode: freshPermissionMode,
          effort: freshEffort,
          userMode,
        });
        if (!runGoal || runGoal.status !== 'active' || !runGoal.currentRunId) {
          WsServer.getInstance().send(root.id, {
            type: SSEEventType.GoalChanged,
            sessionId: root.id,
            action: 'stopped',
            goal: runGoal,
          });
          break;
        }
        WsServer.getInstance().send(root.id, {
          type: SSEEventType.GoalChanged,
          sessionId: root.id,
          action: 'run',
          goal: runGoal,
        });
        const content = buildGoalContinuationContent({
          sessionId,
          goal: runGoal,
          workspace: runGoal.workspace,
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
        const fullHistory = await sessionManager.getHistory(sessionId);
        const loopHistory = fullHistory;
        const freshLoopConfig: AgentLoopConfig = {
          ...loopConfig,
          permissionMode: freshPermissionMode,
          effort: freshEffort,
          workspace: runGoal.workspace,
          extraAllowedTools: [...new Set([...(loopConfig.extraAllowedTools || []), 'GoalReport'])],
        };
        const newLoop = new AgentLoop(freshLoopConfig);
        this._activeLoops.set(sessionId, newLoop);
        yield { type: SSEEventType.Wake, content: '(Goal wake -- continuing active goal)' };
        for await (const evt of newLoop.run(goalMessage, loopHistory, signal)) {
          yield evt;
          SupervisionManager.getInstance().heartbeat(sessionId);
        }

        const reported = sessionManager.getGoal(sessionId);
        if (!reported || reported.status !== 'active') {
          break;
        }
        if (reported.currentRunId === runGoal.currentRunId) {
          const failed = await sessionManager.failGoalRun(
            sessionId,
            'Goal run ended without the required GoalReport.',
            runGoal.currentRunId,
          );
          WsServer.getInstance().send(root.id, {
            type: SSEEventType.GoalChanged,
            sessionId: root.id,
            action: 'unreported',
            goal: failed,
          });
          if (!failed || failed.status !== 'active') break;
        }
      } catch (err) {
        const errorMessage = (err as Error).message;
        createLogger('anochat.agent').warn('Goal mode sub-loop error', { sid: sessionId, error: errorMessage });
        const current = sessionManager.getGoal(sessionId);
        if (!current || current.status !== 'active') break;
        const failed = await sessionManager.failGoalRun(sessionId, errorMessage);
        const root = sessionManager.getRootSession(sessionId);
        WsServer.getInstance().send(root.id, {
          type: SSEEventType.GoalChanged,
          sessionId: root.id,
          action: 'error',
          goal: failed,
        });
        yield { type: SSEEventType.Error, errorMessage: `Goal mode error: ${errorMessage}`, code: 'GOAL_LOOP_ERROR' };
        if (!failed || failed.status !== 'active') break;
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
   * Create a temporary SubAgent and execute a task synchronously. The SubAgent
   * is always destroyed after completion or error; its task and transcript remain.
   */
  async spawnSubAgent(config: SubAgentConfig, callerAgentId?: string, parentSessionId?: string): Promise<ToolResult> {
    return spawnSubAgent(this, config, callerAgentId, parentSessionId);
  }

  /**
   * Execute one durable coordination task. The scheduler is the only caller.
   * Completion is committed after the AgentLoop terminal event, never after dispatch.
   */
  async runCoordinationTask(task: CoordinationTask): Promise<void> {
    const service = CoordinationService.getInstance();
    const registry = AgentRegistry.getInstance();
    const sessionManager = SessionManager.getInstance();
    const agent = task.assigneeAgentId ? registry.findAgent(task.assigneeAgentId) : undefined;
    if (!agent?.isActive) {
      await service.updateTask(task.rootSessionId, task.id, {
        status: 'blocked',
        blocker: 'assignee_unavailable',
        error: `Assigned agent is unavailable: ${task.assigneeAgentId || '(none)'}`,
      }, task.creatorAgentId);
      return;
    }

    const parentSessionId = task.mode === 'swarm'
      ? task.rootSessionId
      : task.sourceSessionId;
    const scopeId = task.mode === 'swarm' && task.teamId
      ? `team-${task.teamId}`
      : undefined;
    const session = await sessionManager.createSubSession(
      parentSessionId,
      agent.id,
      `Coordination: ${task.subject.slice(0, 80)}`,
      {
        scopeId,
        metadata: {
          coordinationTaskId: task.id,
          coordinationRootSessionId: task.rootSessionId,
          coordinationTeamId: task.teamId,
          coordinationMode: task.mode,
        },
      },
    );
    await sessionManager.setMetadataPersisted(session.id, 'coordinationTaskId', task.id);
    await sessionManager.setMetadataPersisted(session.id, 'coordinationRootSessionId', task.rootSessionId);
    if (task.teamId) await sessionManager.setMetadataPersisted(session.id, 'coordinationTeamId', task.teamId);

    let current = service.getTask(task.rootSessionId, task.id) || task;
    current = await service.updateTask(task.rootSessionId, task.id, {
      status: 'running',
      sessionId: session.id,
      heartbeatAt: new Date().toISOString(),
      progress: 0,
    }, agent.id, current.version);

    const packet = await buildTaskPacket(current);
    const taskContent = renderTaskPacket(packet);
    const message: Message = {
      id: `coord-task-${task.id}-${current.attempt}`,
      sessionId: session.id,
      role: MessageRole.System,
      content: taskContent,
      tokenCount: TokenCounter.estimate(taskContent),
      compressed: false,
      timestamp: new Date().toISOString(),
      agentId: task.creatorAgentId,
      agentName: registry.findAgent(task.creatorAgentId)?.name || task.creatorAgentId,
    };
    await sessionManager.appendMessage(session.id, message);
    const history = (await sessionManager.getHistory(session.id)).filter((entry) => entry.id !== message.id);
    const { SessionTurnRecorder } = await import('../../infra/SessionTurnRecorder.js');
    const recorder = new SessionTurnRecorder(
      session.id,
      agent.id,
      `coord-${task.id}-${current.attempt}`,
    );
    const startedAt = Date.now();
    let content = '';
    let failure = '';
    let turnCount = 0;
    let tokenUsage = 0;
    let currentTool: string | undefined;
    const ttlMs = SettingsManager.getInstance().get<number>(
      'coordination.workspaceLeaseTtlMs',
      30_000,
    );
    const timeoutMs = SettingsManager.getInstance().get<number>(
      'coordination.maxTaskRuntimeMs',
      600_000,
    );
    const heartbeat = setInterval(() => {
      const latest = service.getTask(task.rootSessionId, task.id);
      if (!latest || latest.status !== 'running') return;
      void service.renewTaskLeases(task.rootSessionId, task.id, ttlMs, agent.id).catch(() => {});
      if (latest.blocker === CANCELLATION_REQUESTED_BLOCKER && latest.sessionId) {
        InterruptController.getInstance().requestInterruptWhenAvailable(
          latest.sessionId,
          InterruptReason.ParentStop,
        );
      }
      void service.updateTask(task.rootSessionId, task.id, {
        heartbeatAt: new Date().toISOString(),
        currentTool,
      }, agent.id).catch(() => {});
    }, Math.max(1_000, Math.min(5_000, Math.floor(ttlMs / 2))));
    const timeout = setTimeout(() => {
      InterruptController.getInstance().requestInterrupt(session.id, InterruptReason.Timeout);
      failure = `Coordination task timed out after ${timeoutMs}ms`;
    }, timeoutMs);

    try {
      for await (const event of this.processMessage(session.id, agent.id, message, history, {
        permissionMode: 'AutoEdit',
        effort: 'HIGH',
      })) {
        await recorder.record(event, 'coordination');
        if (event.type === SSEEventType.Text) content += String(event.content || '');
        if (event.type === SSEEventType.ToolCall) {
          currentTool = String(event.toolName || '');
          turnCount += 1;
          await service.updateTask(task.rootSessionId, task.id, {
            heartbeatAt: new Date().toISOString(),
            currentTool,
            progress: Math.min(95, Math.max(1, turnCount * 5)),
          }, agent.id);
        } else if (event.type === SSEEventType.ToolResult) {
          currentTool = undefined;
        } else if (event.type === SSEEventType.Error) {
          failure = String(event.errorMessage || event.content || 'AgentLoop failed');
        } else if (event.type === SSEEventType.Done) {
          tokenUsage = Number((event.tokenUsage as { total?: number } | undefined)?.total || 0);
        }
        WsServer.getInstance().send(session.id, event as unknown as Record<string, unknown>);
      }
      await recorder.finalize();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      await recorder.recordError(failure, 'coordination').catch(() => {});
      await recorder.finalize().catch(() => {});
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      await sessionManager.setRuntimeStatus(session.id, 'Idle').catch(() => {});
    }

    const latest = service.getTask(task.rootSessionId, task.id);
    if (!latest) return;
    if (latest.status === 'cancelled' || latest.status === 'completed' || latest.status === 'failed') {
      await service.releaseTaskLeases(
        latest.rootSessionId,
        latest.id,
        latest.assigneeAgentId || latest.creatorAgentId,
      ).catch(() => {});
      return;
    }
    if (latest.blocker === CANCELLATION_REQUESTED_BLOCKER) {
      await service.updateTask(task.rootSessionId, task.id, {
        status: 'cancelled',
        blocker: undefined,
        currentTool: undefined,
        heartbeatAt: new Date().toISOString(),
        resultSummary: content.trim().slice(0, 2_000) || undefined,
        outputRef: `session:${session.id}`,
        tokenUsage,
      }, agent.id);
      return;
    }
    if (failure) {
      const failed = await service.updateTask(task.rootSessionId, task.id, {
        status: 'failed',
        error: failure.slice(0, 2_000),
        resultSummary: content.trim().slice(0, 2_000) || undefined,
        outputRef: `session:${session.id}`,
        tokenUsage,
      }, agent.id);
      if (isTransientCoordinationError(failure) && failed.attempt < failed.maxAttempts) {
        await service.retryTask(task.rootSessionId, task.id, agent.id);
        return;
      }
      await this.deliverCoordinationResult(failed, 'failed');
      return;
    }

    const completed = await service.updateTask(task.rootSessionId, task.id, {
      status: 'completed',
      progress: 100,
      currentTool: undefined,
      heartbeatAt: new Date().toISOString(),
      resultSummary: content.trim().slice(0, 2_000) || 'Task completed without a text summary.',
      outputRef: `session:${session.id}`,
      tokenUsage,
      evidence: [`Session transcript: ${session.id}`, `Turns: ${turnCount}`, `Duration: ${Date.now() - startedAt}ms`],
    }, agent.id);
    await this.deliverCoordinationResult(completed, 'completed');
  }

  private async deliverCoordinationResult(
    task: CoordinationTask,
    status: 'completed' | 'failed',
  ): Promise<void> {
    const service = CoordinationService.getInstance();
    const sessionManager = SessionManager.getInstance();
    const message = await service.queueMessage({
      rootSessionId: task.rootSessionId,
      teamId: task.teamId,
      taskId: task.id,
      fromAgentId: task.assigneeAgentId || task.creatorAgentId,
      toAgentId: task.creatorAgentId,
      kind: 'task_result',
      summary: `${task.subject}: ${status}`,
      content: task.resultSummary || task.error || status,
      idempotencyKey: `task-result:${task.id}:${task.attempt}:${status}`,
    });
    const source = sessionManager.session(task.sourceSessionId)
      || sessionManager.session(task.rootSessionId);
    if (!source) return;
    const xml = [
      [
        `<coordination-event root-session-id="${task.rootSessionId}"`,
        task.teamId ? `team-id="${task.teamId}"` : '',
        `task-id="${task.id}"`,
        `from-agent="${message.fromAgentId}"`,
        `to-agent="${task.creatorAgentId}"`,
        task.sessionId ? `session-id="${task.sessionId}"` : '',
        `status="${status}">`,
      ].filter(Boolean).join(' '),
      `Subject: ${task.subject}`,
      `Result: ${message.content}`,
      task.outputRef ? `Output: ${task.outputRef}` : '',
      '</coordination-event>',
    ].filter(Boolean).join('\n');
    const sessionMessage: Message = {
      id: message.id,
      sessionId: source.id,
      role: MessageRole.User,
      content: xml,
      tokenCount: TokenCounter.estimate(xml),
      compressed: false,
      timestamp: new Date().toISOString(),
      agentId: message.fromAgentId,
      agentName: registryAgentName(message.fromAgentId),
    };
    await sessionManager.appendMessage(source.id, sessionMessage);
    await service.updateMessageStatus(task.rootSessionId, message.id, 'delivered', task.creatorAgentId);
    if (this.isSessionActive(source.id)) {
      InterruptController.getInstance().setPendingUserMessage(source.id, xml);
      InterruptController.getInstance().wakeOnly(source.id);
    }
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

        const persistNotification = sm.appendMessage(payload.parentSessionId, {
          id: `tn-${payload.taskId}`,
          sessionId: payload.parentSessionId,
          role: MessageRole.User,
          content: xml,
          tokenCount: Math.ceil(xml.length / 4),
          compressed: false,
          timestamp,
          agentId: payload.parentAgentId,
        }).then(() => true).catch(err => {
          log.warn('Failed to inject task notification', { taskId: payload.taskId, error: (err as Error).message });
          return false;
        });

        // Wake the agent so it sees the notification.
        // If session is idle (no active AgentLoop), start background processing.
        if (this.isSessionActive(payload.parentSessionId)) {
          void persistNotification.then((persisted) => {
            if (persisted) {
              InterruptController.getInstance().requestSteerInterrupt(payload.parentSessionId);
            }
          });
        } else {

          // so the user sees the CEO's streaming response via WebSocket.
          (async () => {
            let recorder: import('../../infra/SessionTurnRecorder.js').SessionTurnRecorder | null = null;
            try {
              if (!await persistNotification) return;
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

              const { SessionTurnRecorder } = await import('../../infra/SessionTurnRecorder.js');
              const { StreamConsumer } = await import('../../infra/stream/StreamConsumer.js');
              const turnMsgId = `msg-wake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
              recorder = new SessionTurnRecorder(payload.parentSessionId, payload.parentAgentId, turnMsgId);
              const consumer = new StreamConsumer(WsServer.getInstance(), payload.parentSessionId, recorder);

              for await (const event of this.processMessage(payload.parentSessionId, payload.parentAgentId, wakeMessage, history)) {
                switch (event.type) {
                  case 'text':
                    consumer.onDelta('text', event.content as string);
                    break;
                  case 'think':
                    consumer.onDelta('think', event.content as string);
                    break;
                  case 'tool_call':
                    await consumer.beforeToolEvent();
                    await recorder.record(event, 'task_notification');
                    consumer.sendDirect(event as unknown as Record<string, unknown>);
                    break;
                  case 'tool_result':
                    await consumer.beforeToolEvent();
                    await recorder.record(event, 'task_notification');
                    consumer.sendDirect(event as unknown as Record<string, unknown>);
                    break;
                  case 'error':
                    await consumer.beforeToolEvent();
                    await recorder.record(event, 'task_notification');
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
              await recorder?.recordError(
                err instanceof Error ? err.message : String(err),
                'task_notification',
              ).catch(() => {});
              await recorder?.finalize().catch(() => {});
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
    `Acceptance criteria: ${ctx.goal.acceptanceCriteria || '(not specified)'}`,
    `Status: ${ctx.goal.status}`,
    `Run count: ${ctx.goal.runCount || 0}`,
    `Run ID: ${ctx.goal.currentRunId || '(missing)'}`,
    `Run budget: ${ctx.goal.runCount}/${ctx.goal.maxRuns}`,
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
    '- Before ending this run, call GoalReport exactly once with the Run ID above. A run without GoalReport is treated as a failed no-progress run.',
    '- Use waiting_review when the acceptance criteria appear satisfied. Do not keep working after submitting a terminal or waiting outcome.',
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
  } else if (ctx.permissionMode === 'AutoEdit') {
    lines.push(
      '- Auto Edit is active: all allowed tools are pre-authorized. Execute them directly without requesting approval.',
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

function goalResolutionBlocker(result: TaskResolveResult | null): string | null {
  if (!result) return null;
  if (result.missingTools.length > 0) {
    return `Required tools are unavailable: ${result.missingTools.join(', ')}`;
  }
  if (result.missingInputs.length > 0) {
    return `Required input is missing: ${result.missingInputs.map((input) => input.label || input.name).join(', ')}`;
  }
  if (result.nextAction === 'ask_user') {
    return result.reason || 'User input is required before the Goal can continue.';
  }
  if (result.nextAction === 'recommend_plugin') {
    return result.reason || 'A required capability is not installed.';
  }
  return null;
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

function isTransientCoordinationError(message: string): boolean {
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|rate.?limit|too many requests|overloaded|bad gateway|service unavailable|5\d\d/i
    .test(message);
}

function registryAgentName(agentId: string): string {
  return AgentRegistry.getInstance().findAgent(agentId)?.name || agentId;
}
