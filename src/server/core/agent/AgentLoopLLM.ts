// AgentLoopLLM — LLM API call with retry, streaming, and message assembly
// Extracted from AgentLoop.ts to keep the run() method under 500 lines.

import type { SSEEvent } from '../../../shared/types/events.js';
import { SSEEventType } from '../../../shared/types/events.js';
import type { LLMOptions } from '../../../shared/types/llm.js';
import { createLLMProvider } from '../../infra/llm/provider-factory.js';
import { APIScheduler } from '../../infra/llm/APIScheduler.js';
import { createLogger } from '../logger.js';
import {
  MAX_API_RETRIES,
  API_BACKOFF_BASE_MS,
  API_BACKOFF_MAX_MS,
} from '../../../shared/constants.js';
import { estimateTokens, interruptibleSleep, truncateMessagesToTail } from './AgentLoopHelpers.js';
import type { ApiMessage } from './AgentLoopHelpers.js';
import { pickFunMessage } from './StatusMessages.js';
import { extensionPoints } from '../plugin-host/ExtensionPoints.js';
import { compactAndRebuildMessages } from '../context/index.js';
import { TypedEventBus } from '../events/index.js';
import type { SummarizerFn } from '../context/ContextCompressor.js';

export interface LLMCallResult {
  assistantMessage: ApiMessage | null;
  hadThinkContent: boolean;
  fatalError: boolean;
  /** Last error message if retries were exhausted */
  errorMessage?: string;
}

interface SanitizableMsg {
  id?: string;
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_success?: boolean;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}

/**
 * Remove orphaned tool messages that have no matching tool_call in a prior assistant message,
 * and remove orphaned tool_calls from assistant messages whose tool results are missing.
 *
 * DeepSeek and other OpenAI-compatible APIs reject messages where a 'tool' role message
 * doesn't follow an assistant message containing the corresponding tool_call.
 */
function sanitizeOrphanedMessages(messages: SanitizableMsg[]): SanitizableMsg[] {
  // Pass 1: collect all tool_call IDs referenced by tool result messages
  const toolResultIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool' && m.tool_call_id) {
      toolResultIds.add(m.tool_call_id);
    }
  }

  // Pass 2: remove orphan tool messages (tool result with no matching tool_call)
  // and trim orphan tool_calls from assistant messages (tool_call with no matching result)
  const cleaned: SanitizableMsg[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      // Keep only if the tool_call_id exists in some assistant message's tool_calls
      if (!m.tool_call_id) continue; // malformed — skip
      // Check if any assistant message has this tool_call
      const hasCall = messages.some(
        x => x.role === 'assistant' && x.tool_calls?.some(tc => tc.id === m.tool_call_id),
      );
      if (!hasCall) continue; // orphan — skip
    }

    if (m.role === 'assistant' && m.tool_calls?.length) {
      // Keep only tool_calls that have a corresponding tool result
      const validCalls = m.tool_calls.filter(tc => tc.id && toolResultIds.has(tc.id));
      if (validCalls.length === 0) {
        // All tool_calls are orphaned — skip the message entirely if no text content either
        if (!m.content || m.content.trim() === '') continue;
        cleaned.push({ ...m, tool_calls: undefined });
      } else {
        cleaned.push({ ...m, tool_calls: validCalls });
      }
      continue;
    }

    cleaned.push(m);
  }

  return cleaned;
}

/**
 * Build the provider-visible conversation.
 *
 * The primary system prompt is supplied separately to provider.chat(). Other
 * The primary system prompt is removed because it is supplied separately.
 * Later internal notices (compaction, recovery, stall hints, AgentChannel)
 * are mapped to user messages so providers actually receive them.
 */
export function prepareMessagesForLLM(
  messages: readonly ApiMessage[],
  primarySystemPrompt?: string,
): ApiMessage[] {
  const visible: ApiMessage[] = [];
  let skippedPrimary = false;
  for (const message of messages) {
    if (message.role !== 'system') {
      visible.push(message);
      continue;
    }
    if (
      !skippedPrimary
      && (primarySystemPrompt === undefined || message.content === primarySystemPrompt)
    ) {
      skippedPrimary = true;
      continue;
    }
    visible.push({ ...message, role: 'user' });
  }
  return sanitizeOrphanedMessages(visible) as ApiMessage[];
}

export interface LLMCallConfig {
  agentId: string;
  sessionId: string;
  modelName: string;
  provider: string;
  apiUrl?: string;
  apiKey?: string;
  agentContextWindow: number;
  temperature: number;
  contextWindow: number;
  turn: number;
  postWait: boolean;
  summarizer?: SummarizerFn;
}

const MAX_OUTPUT_TOKENS = 16384;

/** Keep the requested completion inside the active model context window. */
export function calculateMaxOutputTokens(contextWindow: number, promptTokens: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return MAX_OUTPUT_TOKENS;

  const normalizedWindow = Math.floor(contextWindow);
  const normalizedPrompt = Number.isFinite(promptTokens)
    ? Math.max(0, Math.ceil(promptTokens))
    : 0;
  const safetyMargin = Math.max(64, Math.min(1024, Math.floor(normalizedWindow * 0.02)));
  const available = normalizedWindow - normalizedPrompt - safetyMargin;

  return Math.max(1, Math.min(MAX_OUTPUT_TOKENS, available));
}

/**
 * Call the LLM provider with exponential-backoff retry.
 * Streams deltas (text, think, tool_use) as SSE events.
 * Handles 413 compaction, timeout compaction, retryable/transient errors.
 * Returns the assembled assistant message or null on failure.
 */
export async function* callLLMWithRetry(
  config: LLMCallConfig,
  messages: ApiMessage[],
  systemPrompt: string,
  tools: Record<string, unknown>[],
  signal: AbortSignal | undefined,
): AsyncGenerator<SSEEvent, LLMCallResult> {
  const RETRY_MAX = config.postWait ? 0 : MAX_API_RETRIES;
  const RETRY_BASE_MS = API_BACKOFF_BASE_MS;
  const RETRY_MAX_MS = API_BACKOFF_MAX_MS;

  const RETRYABLE = [
    /429|rate.?limit|too many requests|busy|overloaded|throttled/i,
    /5\d\d|server.*error|internal.*error|bad gateway|service.*unavailable|temporarily.*unavailable|maintenance/i,
    /network|ECONN|ETIMEDOUT|ENOTFOUND|EPIPE|socket|timeout|fetch.*failed|abort|connection|timeout/i,
    /overloaded|capacity|busy|congestion/i,
  ];
  const UNRETRYABLE = [
    /40[0-9]|bad.?request|invalid|tool.*must|message.*role|not.?found|unauthorized|forbidden|payment|quota|billing/i,
  ];

  let lastErr: Error | null = null;
  let apiStartMs = 0;

  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    if (signal?.aborted) {
      yield { type: SSEEventType.Text, content: '(Cancelled during retry)' };
      break;
    }

    if (attempt > 0) {
      const delay = Math.min(
        RETRY_BASE_MS * Math.pow(2, attempt - 1) + Math.random() * 500,
        RETRY_MAX_MS,
      );
      yield { type: SSEEventType.Think, content: `(API retry ${attempt}/${RETRY_MAX} after ${delay}ms...)` };
      yield { type: SSEEventType.StatusInfo, content: pickFunMessage() };
      await interruptibleSleep(delay, signal);
      if (signal?.aborted) break;
    }

    // Tracks whether this attempt already streamed text/think to the client.
    // When true, a failed attempt must emit replace_text before retrying.
    let yieldedContent = false;

    try {
      apiStartMs = Date.now();
      createLogger('anochat.llm').debug('LLM API call starting', {
        sid: config.sessionId, model: config.modelName, attempt: attempt + 1, messageCount: messages.length,
      });

      const provider = createLLMProvider(config.provider, extensionPoints);
      const chatMessages = prepareMessagesForLLM(messages, systemPrompt) as Array<{
        role: string;
        content: string;
        tool_calls?: unknown[];
        tool_call_id?: string;
      }>;
      const estimatedInputTokens = estimateTokens([
        { role: 'system', content: systemPrompt },
        ...chatMessages as ApiMessage[],
        { role: 'user', content: JSON.stringify(tools) },
      ]);
      const llmOptions: LLMOptions = {
        model: config.modelName,
        maxTokens: calculateMaxOutputTokens(config.agentContextWindow, estimatedInputTokens),
        temperature: config.temperature,
        contextWindow: config.agentContextWindow,
        apiUrl: config.apiUrl || '',
        apiKey: config.apiKey || '',
      };

      const estimatedTotalTokens = estimatedInputTokens + llmOptions.maxTokens;
      await APIScheduler.getInstance().acquireSlot(config.apiKey || '', estimatedTotalTokens);

      const stream = provider.chat(
        chatMessages,
        tools,
        systemPrompt,
        llmOptions,
        signal,
      );

      let assistantText = '';
      const toolCallMap = new Map<string, { toolName: string; toolInput: Record<string, unknown> }>();
      const attemptToolEvents: SSEEvent[] = [];
      let hadThink = false;

      for await (const event of stream) {
        switch (event.type) {
          case 'text_delta':
            assistantText += event.content || '';
            yieldedContent = true;
            // True token-by-token streaming: forward each delta immediately.
            yield { type: SSEEventType.Text, content: event.content || '' };
            break;
          case 'think_delta':
            hadThink = true;
            yieldedContent = true;
            yield { type: SSEEventType.Think, content: event.content || '' };
            break;
          case 'token_usage':
            // Real token usage from API — emit to TypedEventBus for monitoring/audit
            if (event.tokenUsage) {
              TypedEventBus.emit('llm:token_usage', {
                sessionId: config.sessionId,
                inputTokens: event.tokenUsage.inputTokens,
                outputTokens: event.tokenUsage.outputTokens,
                totalTokens: event.tokenUsage.totalTokens,
              });
            }
            break;
          case 'tool_use': {
            const key = event.toolId && event.toolName ? event.toolId :
              event.toolId || event.toolName || `pending-${toolCallMap.size}`;
            const existing = toolCallMap.get(key);
            const merged = {
              toolName: event.toolName || existing?.toolName || '',
              toolInput: { ...(existing?.toolInput || {}), ...(event.toolInput as Record<string, unknown> || {}) },
            };
            toolCallMap.set(key, merged);
            if (merged.toolName) {
              // Tool calls stay deferred until the attempt completes so a
              // mid-stream failure cannot leak half-built tool cards.
              attemptToolEvents.push({ type: SSEEventType.ToolCall, id: key, name: merged.toolName, input: merged.toolInput });
            }
            break;
          }
          case 'error':
            throw new Error(event.errorMessage || 'LLM stream error');
          case 'done':
            break;
        }
      }

      // Build assistant message
      const validTools = Array.from(toolCallMap.entries())
        .filter(([, v]) => v.toolName)
        .map(([k, v]) => ({
          id: k.startsWith('pending-') ? `tc-${config.turn}-${Math.random().toString(36).slice(2, 6)}` : k,
          toolName: v.toolName,
          toolInput: v.toolInput,
        }));

      let assistantMessage: ApiMessage;
      if (validTools.length > 0) {
        assistantMessage = {
          role: 'assistant',
          content: assistantText || '',
          tool_calls: validTools.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.toolName, arguments: JSON.stringify(tc.toolInput) },
          })),
        };
      } else {
        assistantMessage = { role: 'assistant', content: assistantText || '' };
      }

      createLogger('anochat.llm').info('API call completed', {
        sid: config.sessionId, aid: config.agentId, model: config.modelName, provider: config.provider,
        duration_ms: Date.now() - apiStartMs, tokens_in: estimatedInputTokens,
        tokens_out: Math.ceil(assistantText.length / 4), turn: config.turn, attempt,
      });

      // P0: Log empty responses (no text, no tools) for observability
      if (!assistantText && validTools.length === 0) {
        createLogger('anochat.llm').warn('LLM returned empty response (no text, no tools)', {
          sid: config.sessionId, aid: config.agentId, model: config.modelName,
          turn: config.turn, attempt, duration_ms: Date.now() - apiStartMs,
        });
      }

      // Tool events replay after a successful attempt (order: text/think
      // already streamed, then tool call cards).
      for (const event of attemptToolEvents) yield event;

      return { assistantMessage, hadThinkContent: hadThink, fatalError: false };
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      const errMsg = err.message || '';
      lastErr = err;

      // User aborted: keep whatever text already streamed, never retry.
      if (signal?.aborted) {
        return { assistantMessage: null, hadThinkContent: false, fatalError: false, errorMessage: 'aborted' };
      }

      // The client may already be showing partial text from this attempt.
      // Tell it to discard the segment before any silent retry (or the final
      // error) so a successful retry starts from a clean card.
      if (yieldedContent) {
        yield { type: SSEEventType.ReplaceText };
      }

      const errLog = createLogger('anochat.llm');
      errLog.error('API attempt failed', {
        sid: config.sessionId, aid: config.agentId, model: config.modelName,
        error: errMsg.slice(0, 200), attempt: attempt + 1, turn: config.turn,
      });

      // 413 / context too long → compact and retry
      if (/413|too long|context/i.test(errMsg) && attempt < RETRY_MAX) {
        yield { type: SSEEventType.Think, content: '(Context too long, compressing and retrying...)' };
        const compaction = await compactAndRebuildMessages(messages, config.contextWindow, config.sessionId, 15, config.summarizer);
        if (!compaction.wasCompacted) {
          truncateMessagesToTail(messages, 2);
        }
        continue;
      }

      // Permanent errors — don't retry
      if (UNRETRYABLE.some((r) => r.test(errMsg))) {
        return { assistantMessage: null, hadThinkContent: false, fatalError: true, errorMessage: errMsg };
      }

      // Retryable — compress before retrying on timeout
      if (attempt < RETRY_MAX && RETRYABLE.some((r) => r.test(errMsg))) {
        if (/timeout|ETIMEDOUT|ECONN|socket|fetch.*failed/i.test(errMsg) && messages.length > 10) {
          yield { type: SSEEventType.Think, content: '(Timeout detected, compressing context before retry...)' };
          const compaction = await compactAndRebuildMessages(messages, config.contextWindow, config.sessionId, 8, config.summarizer);
          if (!compaction.wasCompacted) {
            truncateMessagesToTail(messages, 8);
          }
          yield { type: SSEEventType.Think, content: '(Context compressed, retrying...)' };
        }
        continue;
      }

      // Preserve the existing best-effort retry for unknown transient errors.
      if (attempt < RETRY_MAX) continue;

      createLogger('anochat.llm').warn('Unknown API error', {
        sid: config.sessionId, aid: config.agentId, model: config.modelName,
        error: errMsg.slice(0, 200), attempt: attempt + 1,
      });
    }
  }

  // All retries exhausted without producing a message
  return { assistantMessage: null, hadThinkContent: false, fatalError: true, errorMessage: lastErr?.message };
}
