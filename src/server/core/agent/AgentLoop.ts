

//
// KEY PATTERNS FROM REFERENCE:
// 1. Generator-based loop: yield SSE events, consumer iterates
// 2. SSE event types: 'think', 'text', 'tool_call', 'tool_result', 'done', 'sleep', 'wake'


// 5. Tool result compression before injecting into conversation
// 6. Interrupt behavior: check AbortSignal before each LLM call
// 7. StallDetector: 5 consecutive no-tool turns, 3 consecutive same-tool failures, >50 tools/turn
// 8. Goal persistence (24/7 breakpoint checkpoint)
// 9. Memory extraction (Hermes nudge every 8 turns)
// 10. Skill nudge (every 20 turns)

import { SettingsManager } from '../../infra/storage/SettingsManager.js';

import { EventEmitter } from 'events';
import type { Message } from '../../../shared/types/session.js';
import type { SSEEvent } from '../../../shared/types/events.js';
import { SSEEventType } from '../../../shared/types/events.js';
import { AgentRegistry } from './AgentRegistry.js';
import { AgentStatus } from '../../../shared/types/agent.js';
import { ToolRegistry } from '../tools/index.js';
import { SessionManager } from '../session/index.js';
import { PromptAssembler } from '../prompt/index.js';
import { TokenCounter } from '../context/index.js';
import { createLogger } from '../logger.js';
import { InterruptController, INTERRUPT_MESSAGE_PREFIX } from './supervision/InterruptController.js';
import {
  MAX_TURNS_DEFAULT,
  COMPRESSION_TRIGGER_RATIO,
  MAX_TOOL_RESULT_CHARS,
} from '../../../shared/constants.js';
import { StallDetector } from './StallDetector.js';
import type { StallResult } from './StallDetector.js';
import {
  messageToApiMessage,
  selectHistoryForContext,
  truncateMessagesPreservingTask,
  truncateMessagesToTail,
} from './AgentLoopHelpers.js';
import type { ApiMessage } from './AgentLoopHelpers.js';
import { extensionPoints } from '../plugin-host/ExtensionPoints.js';
import { compactAndRebuildMessages } from '../context/index.js';
import { callLLMWithRetry } from './AgentLoopLLM.js';
import { AgentChannel } from './AgentChannel.js';
import { TypedEventBus } from '../events/TypedEventBus.js';
import { BackgroundTaskManager } from './supervision/BackgroundTaskManager.js';
import { SharedContextStore } from './SharedContextStore.js';
import { createAgentLoopSummarizer } from './AgentLoopSummarizer.js';
import { normalizePermissionMode, type PermissionMode } from './PermissionModePolicy.js';
import { ConfirmationRegistry } from './ConfirmationRegistry.js';
import { WsServer } from '../../infra/network/WsServer.js';
import { RiskLevel } from '../../../shared/types/tool.js';



export interface AgentLoopConfig {
  maxTurns: number;
  temperature: number;
  contextWindow: number;
  agentId: string;
  sessionId: string;
  permissionMode?: string;
  effort?: string;
}





export class AgentLoop {
  readonly agentId: string;
  readonly sessionId: string;
  readonly maxTurns: number;
  readonly temperature: number;
  readonly contextWindow: number;
  readonly permissionMode?: string;
  readonly effort?: string;

  private stallDetector: StallDetector;
  private toolCallHistory: Array<{ name: string; result: string; ts: number }> = [];

  constructor(config: AgentLoopConfig) {
    this.agentId = config.agentId;
    this.sessionId = config.sessionId;
    this.maxTurns = config.maxTurns ?? MAX_TURNS_DEFAULT;
    this.temperature = config.temperature;
    this.contextWindow = config.contextWindow;
    this.permissionMode = config.permissionMode;
    this.effort = config.effort;
    this.stallDetector = new StallDetector();
  }

  async *run(
    userMessage: Message,
    history: Message[],
    _signal?: AbortSignal,
  ): AsyncGenerator<SSEEvent> {

    let signal = _signal;

    const agentLoopOverride = extensionPoints.get('agentLoop');
    if (agentLoopOverride) {
      try {
        const customLoop = agentLoopOverride({
          userMessage, history, signal,
          agentId: this.agentId, sessionId: this.sessionId,
          config: { maxTurns: this.maxTurns, temperature: this.temperature, contextWindow: this.contextWindow },
        }) as AsyncGenerator<SSEEvent>;
        if (customLoop && typeof customLoop[Symbol.asyncIterator] === 'function') {
          yield* customLoop;
          return;
        }
      } catch (err) {
        createLogger('anochat.agent').warn('Plugin agentLoop override failed, falling back to built-in', { error: (err as Error).message });
      }
    }

    const registry = AgentRegistry.getInstance();
    const agent = registry.agent(this.agentId);
    if (!agent) {
      createLogger('anochat.agent').warn('AgentLoop: agent not found', { aid: this.agentId, sid: this.sessionId });
      yield { type: SSEEventType.Error, errorMessage: `Agent not found: ${this.agentId}` };
      return;
    }

    createLogger('anochat.agent').debug('AgentLoop started', {
      sid: this.sessionId,
      aid: this.agentId,
      historyLen: history.length,
      maxTurns: this.maxTurns,
    });

    let summarizer = createAgentLoopSummarizer({
      provider: agent.provider,
      modelName: agent.modelName,
      contextWindow: agent.contextWindow,
      apiUrl: agent.apiUrl,
      apiKey: agent.apiKey,
    });

    const promptAssembler = PromptAssembler.getInstance();
    const promptBuildContext = () => ({
      permissionMode: this.permissionMode,
      effort: this.effort,
      hideUserInteractionTools: this._isAutoMode(),
    });
    let systemPrompt = promptAssembler.buildEffectivePrompt(
      this.agentId,
      this.sessionId,
      undefined,
      promptBuildContext(),
    );

    const messages: ApiMessage[] = [
      { role: 'system', content: systemPrompt },
    ];

    createLogger('anochat.agent').debug('AgentLoop system prompt built', { sid: this.sessionId, promptLen: systemPrompt.length });

    const toolRegistry = ToolRegistry.getInstance();
    let allowedNames = agent.allowedTools();
    let agentTools = toolRegistry.toolsForAgent(allowedNames, {
      hideUserInteractionTools: this._isAutoMode(),
    });
    // In auto mode, hide tools that require user interaction 閳?user chose
    // to be hands-off; the agent should work autonomously without asking.
    const tools = agentTools.map((t) => t.toAnthropicTool());
    createLogger('anochat.agent').debug('AgentLoop tools loaded', { sid: this.sessionId, toolCount: tools.length, toolNames: agentTools.map(t => t.name()), autoMode: this._isAutoMode() });

    const selectedHistory = selectHistoryForContext(history, {
      contextWindow: this.contextWindow,
      reservedTokens: TokenCounter.estimate(systemPrompt)
        + TokenCounter.estimate(JSON.stringify(tools))
        + TokenCounter.estimate(userMessage.content || ''),
      excludeMessageIds: [userMessage.id],
    });

    // Load conversation history using the active context window instead of a fixed message count.
    for (const h of selectedHistory) {
      if (h.compressed) {
        messages.push({ role: h.role as ApiMessage['role'], content: h.content || '' });
        continue;
      }
      const apiMsg = messageToApiMessage(h);
      messages.push(apiMsg);
      const tcList = apiMsg.tool_calls || [];
      for (const tc of tcList) {
        const hasResult = (h.toolResults || []).some(tr => tr.toolCallId === tc.id);
        if (hasResult) {
          const tr = (h.toolResults || []).find(r => r.toolCallId === tc.id)!;
          messages.push({ role: 'tool', content: tr.content || '(tool result)', tool_call_id: tc.id });
        } else {
          messages.push({ role: 'tool', content: '(completed)', tool_call_id: tc.id });
        }
      }
    }

    messages.push({ role: 'user', content: userMessage.content });

    createLogger('anochat.agent').debug('AgentLoop messages built', {
      sid: this.sessionId,
      messageCount: messages.length,
      historyLen: history.length,
      selectedHistoryLen: selectedHistory.length,
      contextWindow: this.contextWindow,
    });

    const sessionManager = SessionManager.getInstance();
    let lastKnownMsgCount = sessionManager.getMessageCount(this.sessionId);


    // Messages arrive via TypedEventBus (no polling delay). Checked every turn.
    const channelMsgs: Array<{ role: 'system' | 'user'; content: string }> = [];
    const unsubChannel = AgentChannel.getInstance().subscribe(
      this.agentId, this.sessionId,
      (msg) => {
        channelMsgs.push({ role: msg.role, content: msg.content });
      },
    );


    // Checked every inter-turn. Agents read context written by teammates in real-time.
    const sharedStore = SharedContextStore.getInstance();
    const teamScope = agent?.teamName || this.sessionId;
    let lastSharedContextCheck = Date.now();

    let turn = 0;
    let compactCheckCounter = 0;
    let lastCompactionTokenCount = 0;
    let memExtractTurn = 0;
    let skillNudgeTurn = 0;
    let postWait = false;
    let consecutiveFatalErrors = 0;
    const MAX_CONSECUTIVE_FATAL = 3;
    let consecutiveCompactFailures = 0;
    let consecutiveEmptyResponses = 0;
    const MAX_CONSECUTIVE_EMPTY = 3;
    const MAX_CONSECUTIVE_COMPACT_FAILURES = 3;

    const maxTurns = this.maxTurns <= 0 ? Infinity : this.maxTurns;

    try {
    while (turn < maxTurns) {

      // via Agents page while the loop is running (for example, during goal mode).
      const currentAgent = registry.agent(this.agentId);
      if (!currentAgent || !currentAgent.isActive) {
        yield { type: SSEEventType.Error, errorMessage: 'Agent destroyed or removed' };
        break;
      }
      // Reload tools if allowedTools or model changed
      const newAllowedNames = currentAgent.allowedTools();
      const allowedChanged = newAllowedNames.length !== allowedNames.length
        || newAllowedNames.some((n, i) => n !== allowedNames[i]);
      if (allowedChanged || currentAgent.modelName !== agent.modelName
        || currentAgent.provider !== agent.provider
        || currentAgent.apiUrl !== agent.apiUrl
        || currentAgent.apiKey !== agent.apiKey) {
        createLogger('anochat.agent').info('Agent config changed mid-loop, reloading tools', {
          sid: this.sessionId, aid: this.agentId,
          oldToolCount: allowedNames.length, newToolCount: newAllowedNames.length,
        });
        allowedNames.length = 0;
        allowedNames.push(...newAllowedNames);
        agentTools = toolRegistry.toolsForAgent(allowedNames, {
          hideUserInteractionTools: this._isAutoMode(),
        });
        tools.length = 0;
        tools.push(...agentTools.map((t) => t.toAnthropicTool()));
        summarizer = createAgentLoopSummarizer({
          provider: currentAgent.provider,
          modelName: currentAgent.modelName,
          contextWindow: currentAgent.contextWindow,
          apiUrl: currentAgent.apiUrl,
          apiKey: currentAgent.apiKey,
        });
      }


      if (signal?.aborted) {
        const ic = InterruptController.getInstance();
        const pending = ic.takePendingUserMessage(this.sessionId);
        if (pending) {
          yield { type: SSEEventType.StatusInfo, content: '(Processing your new message...)' };
          messages.push({ role: 'user', content: INTERRUPT_MESSAGE_PREFIX + pending });
          // Create a fresh controller for this continuation turn
          signal = ic.createController(this.sessionId).signal;
          this.stallDetector.reset();

          lastKnownMsgCount = sessionManager.getMessageCount(this.sessionId);
          continue;
        }
        const abortReason = ic.reason(this.sessionId);
        if (abortReason === 'timeout') {
          yield { type: SSEEventType.Text, content: '(Session timed out)' };
        } else if (abortReason === 'user_stop') {
          yield { type: SSEEventType.Text, content: '(User stopped)' };
        } else if (abortReason === 'parent_stop') {
          yield { type: SSEEventType.Text, content: '(Parent session stopped)' };
        } else {
          yield { type: SSEEventType.Text, content: '(User aborted)' };
        }
        break;
      }

      turn++;
      compactCheckCounter++;

      systemPrompt = promptAssembler.buildEffectivePrompt(
        this.agentId,
        this.sessionId,
        undefined,
        promptBuildContext(),
      );
      if (messages[0]?.role === 'system') {
        messages[0].content = systemPrompt;
      }

      createLogger('anochat.agent').debug('AgentLoop turn start', { sid: this.sessionId, turn, messageCount: messages.length });


      if (compactCheckCounter > 7) {
        compactCheckCounter = 0;
        // Quick token estimate on conversation messages (skip expensive tool def re-count)
        const convEstimate = TokenCounter.estimateMessages(
          messages.filter(m => m.role !== 'system') as unknown as Message[]
        );
        const shouldCheck = lastCompactionTokenCount === 0
          || convEstimate > lastCompactionTokenCount * 1.5;

        if (!shouldCheck) {
          createLogger('anochat.agent').debug('Compaction check skipped: token growth below threshold', {
            sid: this.sessionId,
            convEstimate,
            lastCompactionTokenCount,
          });
        } else if (consecutiveCompactFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) {
          createLogger('anochat.agent').debug('Compaction circuit breaker open -skipping', { sid: this.sessionId, consecutiveCompactFailures });
        } else {
          const breakdown = TokenCounter.breakdown(
            systemPrompt, tools, '', messages.filter(m => m.role !== 'system') as unknown as Message[],
            this.contextWindow,
          );
          const estimatedTokens = breakdown.total;
          const threshold = Math.floor(this.contextWindow * this._compressionTriggerRatio());

          if (estimatedTokens > threshold) {
            createLogger('anochat.agent').info('Context compaction triggered', { sid: this.sessionId, estimatedTokens, threshold, turn });
            yield { type: SSEEventType.StatusInfo, content: 'Compacting context...' };
            const compaction = await compactAndRebuildMessages(messages, this.contextWindow, this.sessionId, 15, summarizer);
            if (compaction.wasCompacted) {
              consecutiveCompactFailures = 0;
              lastCompactionTokenCount = TokenCounter.estimateMessages(
                compaction.messages.filter(m => m.role !== 'system') as unknown as Message[]
              );
              yield { type: SSEEventType.Think, content: `(Context compacted)` };
              this.stallDetector.reset();
            } else {
              consecutiveCompactFailures++;
              createLogger('anochat.agent').debug('Compaction not needed', { sid: this.sessionId, consecutiveCompactFailures });
            }
          }
        }
      }


      // 1. Drain AgentChannel queue first (sub-millisecond delivery, no JSONL read)
      while (channelMsgs.length > 0) {
        const chMsg = channelMsgs.shift()!;
        messages.push({ role: chMsg.role, content: chMsg.content } as unknown as ApiMessage);
        yield {
          type: SSEEventType.Think,
          content: `(Received via channel: ${chMsg.content.slice(0, 100)}${chMsg.content.length > 100 ? '...' : ''})`,
        };
      }

      // 2. Poll SharedContextStore for team-wide bidirectional state sharing
      {
        const newEntries = sharedStore.getSince(teamScope, lastSharedContextCheck);
        if (newEntries.length > 0) {
          const contextText = newEntries
            .filter(e => e.writtenBy !== this.agentId) // don't read own writes
            .map(e => `[${e.writtenBy}] ${e.key}: ${String(e.value).slice(0, 300)}`)
            .join('\n');
          if (contextText) {
            messages.push({
              role: 'system',
              content: `[Shared context updates from team]:\n${contextText}`,
            } as unknown as ApiMessage);
            createLogger('anochat.agent').debug('Injected shared context into loop', {
              sid: this.sessionId,
              entryCount: newEntries.length,
            });
          }
        }
        lastSharedContextCheck = Date.now();
      }

      // 3. Fallback: polling-based detection for externally-appended session messages
      const currentMsgCount = sessionManager.getMessageCount(this.sessionId);
      if (currentMsgCount > lastKnownMsgCount) {
        try {
          const fullHistory = await sessionManager.getHistory(this.sessionId);
          const existingIds = new Set(messages.map(m => (m as any).__msgId).filter(Boolean));
          const newExternalMessages = fullHistory
            .filter(m => (m.role === 'system' || m.role === 'user') && !existingIds.has(m.id))
            .slice(-(currentMsgCount - lastKnownMsgCount));

          for (const msg of newExternalMessages) {
            (msg as any).__msgId = msg.id;
            const pushRole = msg.role === 'system' ? 'system' : 'user';
            messages.push({
              role: pushRole,
              content: msg.content,
              __msgId: msg.id,
            } as unknown as ApiMessage);
            yield {
              type: SSEEventType.Think,
              content: `(Received: ${msg.content.slice(0, 100)}${msg.content.length > 100 ? '...' : ''})`,
            };
          }

          if (newExternalMessages.length > 0) {
            createLogger('anochat.agent').debug('Injected external messages into loop', {
              sid: this.sessionId,
              count: newExternalMessages.length,
            });
          }
        } catch (err) {
          createLogger('anochat.agent').warn('Failed to check for new messages', {
            sid: this.sessionId,
            error: (err as Error).message,
          });
        }
        lastKnownMsgCount = currentMsgCount;
      }


      let assistantMessage: ApiMessage | null = null;
      let hadThinkContent = false;
      {
        const llmResult = yield* callLLMWithRetry(
          {
            agentId: this.agentId,
            sessionId: this.sessionId,
            modelName: agent.modelName,
            provider: agent.provider,
            apiUrl: agent.apiUrl,
            apiKey: agent.apiKey,
            agentContextWindow: agent.contextWindow,
            temperature: this.temperature,
            contextWindow: this.contextWindow,
            turn,
            postWait,
            summarizer,
          },
          messages,
          systemPrompt,
          tools,
          signal,
        );

        postWait = false;

        if (llmResult.fatalError) {
          yield {
            type: SSEEventType.Error,
            errorMessage: `Fatal: ${llmResult.errorMessage?.slice(0, 300) || 'API Error'}`,
          };
          break;
        }

        assistantMessage = llmResult.assistantMessage;
        hadThinkContent = llmResult.hadThinkContent;


        if (!assistantMessage) {
          consecutiveFatalErrors++;
          if (consecutiveFatalErrors >= MAX_CONSECUTIVE_FATAL) {
            yield {
              type: SSEEventType.Error,
              errorMessage: `Fatal: ${MAX_CONSECUTIVE_FATAL} consecutive API failures. Last error: ${llmResult.errorMessage?.slice(0, 200) || 'unknown'}`,
            };
            break;
          }
          yield { type: SSEEventType.Think, content: '(API error after retries, compressing and retrying once more...)' };
          const compaction = await compactAndRebuildMessages(messages, this.contextWindow, this.sessionId, 8, summarizer);
          if (!compaction.wasCompacted) {
            truncateMessagesToTail(messages, 8);
          }
          continue;
        }
      }


      consecutiveFatalErrors = 0;

      // If signal was aborted during the API call, check for soft interrupt
      if (signal?.aborted) {
        const ic = InterruptController.getInstance();
        const pending = ic.takePendingUserMessage(this.sessionId);
        if (pending) {
          yield { type: SSEEventType.StatusInfo, content: '(Processing your new message...)' };
          messages.push({ role: 'user', content: INTERRUPT_MESSAGE_PREFIX + pending });
          signal = ic.createController(this.sessionId).signal;
          this.stallDetector.reset();
          // Sync message count to prevent duplicate injection via inter-turn check
          lastKnownMsgCount = sessionManager.getMessageCount(this.sessionId);
          continue;
        }
        yield { type: SSEEventType.Text, content: '(User aborted during API call)' };
        break;
      }

      // If no assistant message was produced, break out
      if (!assistantMessage) {
        yield { type: SSEEventType.Error, errorMessage: 'No response from LLM after all retries' };
        break;
      }

      // Append assistant message to transcript
      messages.push(assistantMessage);

      /** Keyword extraction (every 10 turns) */
      memExtractTurn++;
      if (memExtractTurn >= 10) {
        memExtractTurn = 0;
        try {
          // Collect recent user + assistant messages for keyword extraction
          const userMsgs = messages
            .filter(m => m.role === 'user')
            .slice(-5)
            .map(m => m.content || '');
          const assistantMsgs = messages
            .filter(m => m.role === 'assistant')
            .slice(-5)
            .map(m => m.content || '');
          if (userMsgs.length > 0 || assistantMsgs.length > 0) {
            TypedEventBus.emit('loop:keyword_turn', {
              sessionId: this.sessionId,
              agentId: this.agentId,
              turnNumber: turn,
              userMessages: userMsgs,
              assistantMessages: assistantMsgs,
            });
          }
        } catch {

        }
      }

      /** Autonomous skill nudge (every 20 turns) */
      skillNudgeTurn++;
      if (skillNudgeTurn >= 20 && turn >= 10) {
        skillNudgeTurn = 0;
        yield { type: SSEEventType.Think, content: '(Skill nudge - not yet integrated)' };
      }

      /** Tool execution gate */
      if (!assistantMessage.tool_calls?.length) {
        const textContent = assistantMessage.content || '';
        const hasNoContent = textContent.trim().length === 0;


        if (hasNoContent) {
          consecutiveEmptyResponses++;
          this.stallDetector.recordEmptyResponse();

          const stallCheck = this.stallDetector.check();
          if (stallCheck.stalled) {
            createLogger('anochat.agent').warn('Stall detected (empty response)', { sid: this.sessionId, action: stallCheck.action, message: stallCheck.message, turn, consecutiveEmptyResponses });
            yield {
              type: SSEEventType.StatusInfo,
              content: `(Stall detected: ${stallCheck.message})`,
            };

            if (stallCheck.action === 'hint') {
              // Level 1: inject a hint message into context, don't truncate
              messages.push({
                role: 'system',
                content: `[Note: ${stallCheck.message || 'You seem stuck. Try a different approach.'}]`,
              } as unknown as ApiMessage);
              continue;
            } else if (stallCheck.action === 'compact') {
              yield { type: SSEEventType.StatusInfo, content: '(Compacting context to reorient...)' };
              const compaction = await compactAndRebuildMessages(messages, this.contextWindow, this.sessionId, 15, summarizer);
              if (compaction.wasCompacted) {
                this.stallDetector.reset();
                consecutiveEmptyResponses = 0;
              } else {
                truncateMessagesToTail(messages, 15);
              }
              continue;
            } else if (stallCheck.action === 'yield') {
              yield {
                type: SSEEventType.Error,
                errorMessage: stallCheck.message || 'LLM returned empty content repeatedly',
              };
              break;
            }
          }


          yield {
            type: SSEEventType.Think,
            content: `(LLM returned empty response (${consecutiveEmptyResponses}/${MAX_CONSECUTIVE_EMPTY}), reducing context and retrying...)`,
          };

          messages.push({
            role: 'system',
            content: '[Recovery: The previous model response was empty. Continue the current user task from the preserved request and recent tool results. Do not restart, greet the user, or ask what to do next.]',
          } as unknown as ApiMessage);
          truncateMessagesPreservingTask(messages, 12);
          continue;
        }

        createLogger('anochat.agent').debug('AgentLoop: no tool calls, finishing', { sid: this.sessionId, turn, textLen: assistantMessage.content?.length || 0 });
        if (hadThinkContent && !assistantMessage.content && turn < this.maxTurns - 1) {
          yield { type: SSEEventType.Think, content: '(Reasoning complete - requesting final answer)' };
          messages.push({
            role: 'user',
            content: 'Please provide your final answer based on your reasoning above. Do not repeat the reasoning.',
          });
          hadThinkContent = false;
          continue;
        }


        // If this agent dispatched background work (Bash run_in_background, TaskAssign,
        // SubAgentSpawn), don't exit the loop. Subscribe to BackgroundTaskManager
        // taskCompletedInSession events for instant wakeup instead of polling.
        const bgm = BackgroundTaskManager.getInstance();
        const pendingTasks = bgm.getTasksForParent(this.sessionId);
        const hasRunning = pendingTasks.length > 0 && pendingTasks.some(t => t.status === 'running');
        if (hasRunning) {
          const WAIT_MAX_MS = 5 * 60_000; // 5 min safety net
          const HEARTBEAT_MS = 5000; // Yield heartbeat every 5s for SupervisionManager
          const waitStarted = Date.now();
          let taskWaitInterrupted = false;
          yield { type: SSEEventType.StatusInfo, content: '(Waiting for background tasks to complete...)' };

          // Event-driven wakeup: BackgroundTaskManager emits on complete/fail
          let wakeResolve: (() => void) | null = null;
          const onTaskCompleted = (payload: { parentSessionId: string; taskId: string; status: string }) => {
            if (payload.parentSessionId === this.sessionId && wakeResolve) {
              wakeResolve();
            }
          };
          bgm.on('taskCompletedInSession', onTaskCompleted);

          try {
            while (Date.now() - waitStarted < WAIT_MAX_MS) {
              // Check if any tasks are still running
              const stillRunning = bgm.getTasksForParent(this.sessionId)
                .some(t => t.status === 'running');
              if (!stillRunning) break;

              // Check for interrupt
              if (signal?.aborted) {
                const ic = InterruptController.getInstance();
                const pending = ic.takePendingUserMessage(this.sessionId);
                if (pending) {
                  messages.push({ role: 'user', content: INTERRUPT_MESSAGE_PREFIX + pending });
                  signal = ic.createController(this.sessionId).signal;
                  this.stallDetector.reset();
                  lastKnownMsgCount = sessionManager.getMessageCount(this.sessionId);
                  taskWaitInterrupted = true;
                  break;
                }

                break;
              }

              // Wait for task completion event or heartbeat timeout
              await new Promise<void>(resolve => {
                wakeResolve = resolve;
                const timer = setTimeout(() => {
                  if (wakeResolve === resolve) wakeResolve = null;
                  resolve();
                }, HEARTBEAT_MS);
              });
              wakeResolve = null;

              // Yield heartbeat so SupervisionManager stays alive
              yield { type: SSEEventType.StatusInfo, content: '' };
            }
          } finally {
            wakeResolve = null;
            bgm.off('taskCompletedInSession', onTaskCompleted);
          }

          // If woke up by notification or user interrupt, skip the break and continue the loop
          if (taskWaitInterrupted || sessionManager.getMessageCount(this.sessionId) > lastKnownMsgCount) {
            continue;
          }
        }

        break;
      }

      /** Execute each tool call, compress and append results */
      const toolCalls = assistantMessage.tool_calls;
      const toolNames: string[] = [];
      const toolResults: string[] = [];

      createLogger('anochat.agent').debug('AgentLoop executing tools', { sid: this.sessionId, turn, toolCount: toolCalls.length, toolNames: toolCalls.map(tc => tc.function.name) });

      agent.setSessionStatus(this.sessionId, AgentStatus.WaitingTool);

      yield {
        type: SSEEventType.StatusInfo,
        content: toolCalls.length === 1
          ? `Executing: ${toolCalls[0].function.name}...`
          : `Executing ${toolCalls.length} tools: ${toolCalls.map(t => t.function.name).join(', ')}...`,
      };

      let allDeferred = true;
      let anyUserInteraction = false;
      const completedToolIds = new Set<string>();

      // Read session workspace for tool execution context
      const sessionWorkspace = SessionManager.getInstance().session(this.sessionId)?.workspace || process.cwd();

      try {
      for (const tc of toolCalls) {
        if (signal?.aborted) break;

        const toolName = tc.function.name;
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = {};
        }

        toolNames.push(toolName);

        const tool = agentTools.find((t) => t.name() === toolName);


        let userRejected = false;
        if (tool && this._needsConfirmation(tool, this._permissionMode())) {
          WsServer.getInstance().send(this.sessionId, {
            type: 'tool_confirm_request',
            toolCallId: tc.id,
            toolName: tool.name(),
            displayName: tool.displayName?.() ?? tool.name(),
            riskLevel: tool.riskLevel(),
            params: args,
          });
          const approved = await ConfirmationRegistry.getInstance().waitForConfirmation(tc.id, 60000, signal);
          if (!approved) {
            userRejected = true;
          }
        }

        if (tool && !tool.shouldDefer()) {
          allDeferred = false;
        }
        if (tool?.requiresUserInteraction()) {
          anyUserInteraction = true;
        }

        const t0 = Date.now();
        let result: { success: boolean; content: string; errorMessage?: string; structured?: unknown };
        if (userRejected) {
          result = { success: false, content: '', errorMessage: `User rejected tool "${toolName}".` };
        } else {
        try {
          result = await toolRegistry.execute(toolName, args, {
            sessionId: this.sessionId,
            agentId: this.agentId,
            workspace: sessionWorkspace,
            userConfirmed: true,
            mode: this._toolExecutionMode(),
            callerRole: agent.role,
            signal: signal,
          });
        } catch (err) {
          result = { success: false, content: '', errorMessage: `Tool crash: ${(err as Error).message}` };
        }
        }
        createLogger('anochat.agent').debug('Tool executed', { sid: this.sessionId, toolName, success: result.success, durationMs: Date.now() - t0, turn });

        const resultContent = result.success ? result.content : `Error: ${result.errorMessage || 'Unknown error'}`;
        toolResults.push(resultContent);

        const displayResult = resultContent.slice(0, MAX_TOOL_RESULT_CHARS);
        yield {
          type: SSEEventType.ToolResult,
          toolCallId: tc.id,
          toolName,
          result: displayResult,
          content: displayResult,
          success: result.success,
          structured: result.structured,
        };

        // Emit plan_enter / plan_exit so frontend shows plan mode UI
        if (result.success && (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode')) {
          const planEventType = toolName === 'EnterPlanMode' ? 'plan_enter' : 'plan_exit';
          yield { type: planEventType as SSEEventType };
          if (toolName === 'EnterPlanMode') {
            yield { type: SSEEventType.Think, content: '(Plan mode active - only read-only tools are available. Use ExitPlanMode to return to normal execution.)' };
          }
        }

        // Pipeline already handles output normalization + truncation
        const toolResultContent = result.success
          ? (result.content || '')
          : `Error: ${result.errorMessage || 'Unknown error'}`;
        messages.push({
          role: 'tool',
          content: toolResultContent,
          tool_call_id: tc.id,
        });
        completedToolIds.add(tc.id);
      }
      } finally {

        // exceptions during tool execution can leave orphan tool_use blocks
        // that crash DeepSeek API on the next call.
        for (const tc of toolCalls) {
          if (completedToolIds.has(tc.id)) continue;
          const errMsg = signal?.aborted ? 'Interrupted by user' : 'Tool execution was skipped';
          yield {
            type: SSEEventType.ToolResult,
            toolCallId: tc.id,
            toolName: tc.function.name,
            result: errMsg,
            content: errMsg,
            success: false,
          };
          messages.push({
            role: 'tool',
            content: errMsg,
            tool_call_id: tc.id,
          });
        }
      }

      if (signal?.aborted) continue;

      agent.setSessionStatus(this.sessionId, AgentStatus.Working);
      // Bridge the dead zone: tell frontend agent is now processing results
      yield {
        type: SSEEventType.StatusInfo,
        content: `Processing results${toolNames.length > 0 ? ' from ' + toolNames.map(n => n.replace(/Tool$/, '')).join(', ') : ''}...`,
      };

      if (allDeferred && toolCalls.length > 0) {

        // so don't consume turn budget until the deferred execution completes.
        turn--;
      }

      // If any tool requires user interaction (e.g. AskUserQuestion), pause the loop

      if (anyUserInteraction) {
        const WAIT_POLL_MS = 500;
        const WAIT_TIMEOUT_MS = 5 * 60_000;
        const waitStartedAt = Date.now();
        yield { type: SSEEventType.StatusInfo, content: '(Waiting for user response...)' };

        while (true) {
          // Check for soft interrupt (user sent message via SendMessageHandler)
          if (signal?.aborted) {
            const ic = InterruptController.getInstance();
            const pending = ic.takePendingUserMessage(this.sessionId);
            if (pending) {
              messages.push({ role: 'user', content: INTERRUPT_MESSAGE_PREFIX + pending });
              signal = ic.createController(this.sessionId).signal;
              this.stallDetector.reset();
              lastKnownMsgCount = sessionManager.getMessageCount(this.sessionId);
              break;
            }
          }


          const currentCount = sessionManager.getMessageCount(this.sessionId);
          if (currentCount > lastKnownMsgCount) {
            const fullHistory = await sessionManager.getHistory(this.sessionId);
            const existingIds = new Set(messages.map(m => (m as any).__msgId).filter(Boolean));
            const newMessages = fullHistory
              .filter(m => m.role === 'user' && !existingIds.has(m.id))
              .slice(-(currentCount - lastKnownMsgCount));
            if (newMessages.length > 0) {
              for (const msg of newMessages) {
                (msg as any).__msgId = msg.id;
                messages.push({ role: 'user', content: msg.content, __msgId: msg.id } as unknown as ApiMessage);
              }
              lastKnownMsgCount = currentCount;
              this.stallDetector.reset();
              break;
            }
          }

          if (Date.now() - waitStartedAt > WAIT_TIMEOUT_MS) {
            yield { type: SSEEventType.StatusInfo, content: '(User response timeout - continuing)' };
            break;
          }

          await new Promise(resolve => setTimeout(resolve, WAIT_POLL_MS));
        }
      }

      for (let i = 0; i < toolNames.length; i++) {
        this.toolCallHistory.push({
          name: toolNames[i],
          result: (toolResults[i] || '').slice(0, 200),
          ts: Date.now(),
        });
      }
      if (this.toolCallHistory.length > 50) {
        this.toolCallHistory = this.toolCallHistory.slice(-40);
      }


      this.stallDetector.record(toolNames, toolResults);
      const stallCheck = this.stallDetector.check();
      if (stallCheck.stalled) {
        createLogger('anochat.agent').warn('Stall detected', { sid: this.sessionId, action: stallCheck.action, message: stallCheck.message, turn });
        yield {
          type: SSEEventType.StatusInfo,
          content: `(Stall detected: ${stallCheck.message})`,
        };

        if (stallCheck.action === 'hint') {
          // Level 1: inject a hint message into context, don't truncate
          messages.push({
            role: 'system',
            content: `[Note: ${stallCheck.message || 'You seem stuck. Try a different approach.'}]`,
          } as unknown as ApiMessage);
        } else if (stallCheck.action === 'compact') {
          yield { type: SSEEventType.StatusInfo, content: '(Compacting context to reorient...)' };
          const compaction = await compactAndRebuildMessages(messages, this.contextWindow, this.sessionId, 15, summarizer);
          if (compaction.wasCompacted) {
            this.stallDetector.reset();
          } else {
            truncateMessagesToTail(messages, 15);
          }
        } else if (stallCheck.action === 'yield') {
          yield {
            type: SSEEventType.Error,
            errorMessage: stallCheck.message || 'Agent stalled',
          };
          continue;
        }
        continue;
      }

      // compactCheckCounter is incremented at the top of the while loop
    } // end while

    } finally {
      // Always clean up AgentChannel subscription
      unsubChannel();
    }

    const skillsText = '';
    const breakdown = TokenCounter.breakdown(
      systemPrompt, tools, skillsText,
      messages.filter(m => m.role !== 'system') as unknown as Message[],
      this.contextWindow,
    );
    createLogger('anochat.agent').info('AgentLoop finished', {
      sid: this.sessionId, totalTurns: turn, maxTurns: this.maxTurns,
      totalTokens: breakdown.total, freeTokens: breakdown.freeSpace,
    });
    yield {
      type: SSEEventType.Done,
      tokenUsage: breakdown,
    };
  }

  private _isAutoMode(): boolean {
    try {
      const mode = this._permissionMode();
      return mode === 'Auto' || mode === 'AutoEdit';
    } catch {
      return true;
    }
  }

  private _permissionMode(): PermissionMode {
    try {
      return normalizePermissionMode(
        this.permissionMode || SettingsManager.getInstance().get<string>('ui.permissionMode', 'Auto'),
      );
    } catch {
      return 'Auto';
    }
  }

  private _toolExecutionMode(): string {
    const mode = this._permissionMode();
    if (mode === 'Plan') return 'read_only';
    if (mode === 'Ask') return 'ask';
    if (mode === 'AutoEdit') return 'auto_edit';
    return 'auto';
  }

  private _needsConfirmation(tool: { isReadOnly(): boolean; riskLevel(): string }, mode: PermissionMode): boolean {
    if (tool.isReadOnly()) return false;
    const risk = tool.riskLevel();
    if (risk === RiskLevel.Safe) return false;
    switch (mode) {
      case 'Ask':
        return risk === RiskLevel.Low || risk === RiskLevel.Medium || risk === RiskLevel.High || risk === RiskLevel.Critical;
      case 'Auto':
        return risk === RiskLevel.High || risk === RiskLevel.Critical;
      case 'AutoEdit':
      case 'Plan':
        return false;
      default:
        return risk === RiskLevel.High || risk === RiskLevel.Critical;
    }
  }

  private _compressionTriggerRatio(): number {
    try {
      const pct = SettingsManager.getInstance().get<number>('ui.compactionThreshold', COMPRESSION_TRIGGER_RATIO * 100);
      if (!Number.isFinite(pct)) return COMPRESSION_TRIGGER_RATIO;
      return Math.min(0.9, Math.max(0.3, pct / 100));
    } catch {
      return COMPRESSION_TRIGGER_RATIO;
    }
  }
}

