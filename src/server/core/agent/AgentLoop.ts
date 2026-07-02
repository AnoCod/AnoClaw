// AgentLoop — ReAct loop, the core execution engine
// Replicates patterns from anochat/agent.js runAgent() — the reference Claude Code implementation.
//
// KEY PATTERNS FROM REFERENCE:
// 1. Generator-based loop: yield SSE events, consumer iterates
// 2. SSE event types: 'think', 'text', 'tool_call', 'tool_result', 'done', 'sleep', 'wake'
// 3. Retry: 429/503/529 → exponential backoff (1s,2s,4s,8s, max 60s), max 10 retries
// 4. Context overflow detection: >70% of context window → trigger compaction
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
} from './AgentLoopHelpers.js';
import type { ApiMessage } from './AgentLoopHelpers.js';
import { extensionPoints } from '../plugin-host/ExtensionPoints.js';
import { compactAndRebuildMessages, shouldCompact } from '../context/index.js';
import { ContextCompressor } from '../context/ContextCompressor.js';
import { callLLMWithRetry } from './AgentLoopLLM.js';
import { createLLMProvider } from '../../infra/llm/provider-factory.js';
import { AgentChannel } from './AgentChannel.js';
import { TypedEventBus } from '../events/TypedEventBus.js';
import { BackgroundTaskManager } from './supervision/BackgroundTaskManager.js';

// ── AgentLoopConfig ──

export interface AgentLoopConfig {
  maxTurns: number;
  temperature: number;
  contextWindow: number;
  agentId: string;
  sessionId: string;
}

// ── AgentLoop ──

/**
 * AgentLoop — ReAct loop execution engine
 *
 * Each AgentLoop instance is bound to a single (agentId, sessionId) pair.
 * run() returns an AsyncGenerator that yields SSE events one by one:
 * think / text / tool_call / tool_result / done / error.
 *
 * Core flow:
 *   1. Assemble system prompt + history messages + user message
 *   2. Load the agent's allowed tool list
 *   3. ReAct loop: LLM call → tool execution → append results → next turn
 *   4. Built-in: retry (exponential backoff), context compression, stall detection, memory extraction
 */

export class AgentLoop {
  readonly agentId: string;
  readonly sessionId: string;
  readonly maxTurns: number;
  readonly temperature: number;
  readonly contextWindow: number;

  private stallDetector: StallDetector;
  private toolCallHistory: Array<{ name: string; result: string; ts: number }> = [];

  constructor(config: AgentLoopConfig) {
    this.agentId = config.agentId;
    this.sessionId = config.sessionId;
    this.maxTurns = config.maxTurns ?? MAX_TURNS_DEFAULT;
    this.temperature = config.temperature;
    this.contextWindow = config.contextWindow;
    this.stallDetector = new StallDetector();
  }

  async *run(
    userMessage: Message,
    history: Message[],
    _signal?: AbortSignal,
  ): AsyncGenerator<SSEEvent> {
    // Mutable copy — soft interrupts create fresh AbortControllers mid-loop
    let signal = _signal;
    // ExtensionPoints: agentLoop override — plugin replaces the entire ReAct loop
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

    // Wire L4 LLM summarizer for context compression (set once per provider)
    ContextCompressor.getInstance().setSummarizer(async (msgs, budget) => {
      const provider = createLLMProvider(agent.provider, extensionPoints);
      const sysPrompt = ContextCompressor.getInstance().structuredSummaryPrompt;
      const transcript = msgs.slice(-60).map(m => {
        const prefix = m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'ASSISTANT' : 'SYSTEM';
        return `[${prefix}] ${(m.content || '').slice(0, 500)}`;
      }).join('\n\n');

      const stream = provider.chat(
        [{ role: 'user', content: transcript.slice(0, 50000) }],
        [],
        sysPrompt,
        {
          model: agent.modelName,
          maxTokens: Math.min(budget, 4096),
          temperature: 0.3,
          contextWindow: agent.contextWindow,
          apiUrl: agent.apiUrl || '',
          apiKey: agent.apiKey || '',
        },
      );

      let summary = '';
      for await (const event of stream) {
        if (event.type === 'text_delta') {
          summary += event.content || '';
        }
      }
      return summary;
    });

    const systemPrompt = PromptAssembler.getInstance().buildEffectivePrompt(this.agentId, this.sessionId);

    const messages: ApiMessage[] = [
      { role: 'system', content: systemPrompt },
    ];

    createLogger('anochat.agent').debug('AgentLoop system prompt built', { sid: this.sessionId, promptLen: systemPrompt.length });

    // Load conversation history (last 200 messages)
    for (const h of history.slice(-200)) {
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

    createLogger('anochat.agent').debug('AgentLoop messages built', { sid: this.sessionId, messageCount: messages.length });

    const toolRegistry = ToolRegistry.getInstance();
    let allowedNames = agent.allowedTools();
    let agentTools = toolRegistry.toolsForAgent(allowedNames);
    // In auto mode, hide tools that require user interaction — user chose
    // to be hands-off; the agent should work autonomously without asking.
    if (this._isAutoMode()) {
      agentTools = agentTools.filter(t => !t.requiresUserInteraction());
    }
    const tools = agentTools.map((t) => t.toAnthropicTool());
    createLogger('anochat.agent').debug('AgentLoop tools loaded', { sid: this.sessionId, toolCount: tools.length, toolNames: agentTools.map(t => t.name()), autoMode: this._isAutoMode() });

    const sessionManager = SessionManager.getInstance();
    let lastKnownMsgCount = sessionManager.getMessageCount(this.sessionId);

    // ── AgentChannel subscription: real-time agent-to-agent messages ──
    // Messages arrive via TypedEventBus (no polling delay). Checked every turn.
    const channelMsgs: Array<{ role: 'system' | 'user'; content: string }> = [];
    const unsubChannel = AgentChannel.getInstance().subscribe(
      this.agentId, this.sessionId,
      (msg) => {
        channelMsgs.push({ role: msg.role, content: msg.content });
      },
    );

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
      // Re-read agent from registry every turn — config may have been updated
      // via Agents page while the loop is running (infinite mode).
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
        agentTools = toolRegistry.toolsForAgent(allowedNames);
        if (this._isAutoMode()) {
          agentTools = agentTools.filter(t => !t.requiresUserInteraction());
        }
        tools.length = 0;
        tools.push(...agentTools.map((t) => t.toAnthropicTool()));
      }

      /** Interrupt check — soft interrupt (user message queued) continues the loop */
      if (signal?.aborted) {
        const ic = InterruptController.getInstance();
        const pending = ic.takePendingUserMessage(this.sessionId);
        if (pending) {
          yield { type: SSEEventType.StatusInfo, content: '(Processing your new message...)' };
          messages.push({ role: 'user', content: INTERRUPT_MESSAGE_PREFIX + pending });
          // Create a fresh controller for this continuation turn
          signal = ic.createController(this.sessionId).signal;
          this.stallDetector.reset();
          // Sync message count — pending message was also appended to session store
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

      createLogger('anochat.agent').debug('AgentLoop turn start', { sid: this.sessionId, turn, messageCount: messages.length });

      /** Context compaction check — runs every 8 turns or when token growth > 50% since last compaction */
      if (compactCheckCounter > 7) {
        compactCheckCounter = 0;
        // Quick token estimate on conversation messages (skip expensive tool def re-count)
        const convEstimate = TokenCounter.estimateMessages(
          messages.filter(m => m.role !== 'system') as unknown as Message[]
        );
        const shouldCheck = lastCompactionTokenCount === 0
          || convEstimate > lastCompactionTokenCount * 1.5;

        if (!shouldCheck) continue; // not enough growth to warrant a check

        if (consecutiveCompactFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) {
          createLogger('anochat.agent').debug('Compaction circuit breaker open — skipping', { sid: this.sessionId, consecutiveCompactFailures });
        } else {
          const breakdown = TokenCounter.breakdown(
            systemPrompt, tools, '', messages.filter(m => m.role !== 'system') as unknown as Message[],
            this.contextWindow,
          );
          const estimatedTokens = breakdown.total;
          const threshold = Math.floor(this.contextWindow * COMPRESSION_TRIGGER_RATIO);

          if (estimatedTokens > threshold) {
            createLogger('anochat.agent').info('Context compaction triggered', { sid: this.sessionId, estimatedTokens, threshold, turn });
            yield { type: SSEEventType.StatusInfo, content: 'Compacting context...' };
            const compaction = await compactAndRebuildMessages(messages, this.contextWindow, this.sessionId, 15);
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

      /** Inter-turn message injection — AgentChannel (real-time) + polling (fallback) */
      // 1. Drain AgentChannel queue first (sub-millisecond delivery, no JSONL read)
      while (channelMsgs.length > 0) {
        const chMsg = channelMsgs.shift()!;
        messages.push({ role: chMsg.role, content: chMsg.content } as unknown as ApiMessage);
        yield {
          type: SSEEventType.Think,
          content: `(Received via channel: ${chMsg.content.slice(0, 100)}${chMsg.content.length > 100 ? '...' : ''})`,
        };
      }

      // 2. Fallback: polling-based detection for externally-appended session messages
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

      /** API call with retry — delegated to AgentLoopLLM */
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

        // Retries exhausted — final compression attempt
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
          const compaction = await compactAndRebuildMessages(messages, this.contextWindow, this.sessionId, 8);
          if (!compaction.wasCompacted) {
            const sysMsg = messages[0];
            const tail = messages.slice(-8);
            messages.length = 0;
            messages.push(sysMsg, ...tail);
          }
          continue;
        }
      }

      // LLM call succeeded — reset fatal error counter
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
          // Non-critical — keyword extraction is best-effort
        }
      }

      /** Autonomous skill nudge (every 20 turns) */
      skillNudgeTurn++;
      if (skillNudgeTurn >= 20 && turn >= 10) {
        skillNudgeTurn = 0;
        yield { type: SSEEventType.Think, content: '(Skill nudge — not yet integrated)' };
      }

      /** Tool execution gate */
      if (!assistantMessage.tool_calls?.length) {
        const textContent = assistantMessage.content || '';
        const hasNoContent = textContent.trim().length === 0;

        // P0: LLM returned empty content — trigger stall detection + context reduction
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
              const compaction = await compactAndRebuildMessages(messages, this.contextWindow, this.sessionId, 15);
              if (compaction.wasCompacted) {
                this.stallDetector.reset();
                consecutiveEmptyResponses = 0;
              } else {
                const sysMsg = messages[0];
                const tail = messages.slice(-15);
                messages.length = 0;
                messages.push(sysMsg, ...tail);
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

          // Not at stall threshold yet — reduce context and retry
          yield {
            type: SSEEventType.Think,
            content: `(LLM returned empty response (${consecutiveEmptyResponses}/${MAX_CONSECUTIVE_EMPTY}), reducing context and retrying...)`,
          };

          const sysMsg = messages[0];
          const tail = messages.slice(-4);
          messages.length = 0;
          messages.push(sysMsg, ...tail);
          continue;
        }

        createLogger('anochat.agent').debug('AgentLoop: no tool calls, finishing', { sid: this.sessionId, turn, textLen: assistantMessage.content?.length || 0 });
        if (hadThinkContent && !assistantMessage.content && turn < this.maxTurns - 1) {
          yield { type: SSEEventType.Think, content: '(Reasoning complete — requesting final answer)' };
          messages.push({
            role: 'user',
            content: 'Please provide your final answer based on your reasoning above. Do not repeat the reasoning.',
          });
          hadThinkContent = false;
          continue;
        }

        // ── Wait for background tasks (event-driven) ──
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
                // Hard abort — exit wait
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
      // Tell frontend what's happening — avoids dead silence during tool execution
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

        const isAutoMode = this._isAutoMode();
        if (!isAutoMode && tool?.requiresConfirmation({ sessionId: this.sessionId, agentId: this.agentId, workspace: sessionWorkspace, userConfirmed: false })) {
          yield {
            type: SSEEventType.Think,
            content: `(Tool '${toolName}' requires user confirmation. Waiting for approval...)`,
          };
        }

        if (tool && !tool.shouldDefer()) {
          allDeferred = false;
        }
        if (tool?.requiresUserInteraction()) {
          anyUserInteraction = true;
        }

        const t0 = Date.now();
        let result: { success: boolean; content: string; errorMessage?: string; structured?: unknown };
        try {
          result = await toolRegistry.execute(toolName, args, {
            sessionId: this.sessionId,
            agentId: this.agentId,
            workspace: sessionWorkspace,
            userConfirmed: isAutoMode,
            callerRole: agent.role,
            signal: signal,
          });
        } catch (err) {
          result = { success: false, content: '', errorMessage: `Tool crash: ${(err as Error).message}` };
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
        // Always backfill missing tool_result messages — signal abort or
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
        turn--;
      }

      // If any tool requires user interaction (e.g. AskUserQuestion), pause the loop
      // until the user responds — don't keep calling the LLM while waiting.
      if (anyUserInteraction) {
        const WAIT_POLL_MS = 500;
        const WAIT_TIMEOUT_MS = 5 * 60_000; // 5 min — same as delegation timeout
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

          // Polling fallback — user message appended outside interrupt path
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
            yield { type: SSEEventType.StatusInfo, content: '(User response timeout — continuing)' };
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

      /** Stall detection — escalate through hint → compact → yield */
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
          const compaction = await compactAndRebuildMessages(messages, this.contextWindow, this.sessionId, 15);
          if (compaction.wasCompacted) {
            this.stallDetector.reset();
          } else {
            const sysMsg = messages[0];
            const tail = messages.slice(-15);
            messages.length = 0;
            messages.push(sysMsg, ...tail);
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

      compactCheckCounter++;
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
      const mode = SettingsManager.getInstance().get<string>('ui.permissionMode', 'Auto');
      return mode === 'Auto' || mode === 'AutoEdit';
    } catch {
      return true;
    }
  }
}
