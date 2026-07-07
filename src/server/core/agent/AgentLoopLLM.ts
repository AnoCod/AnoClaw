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
  role: string;
  content?: string;
  tool_call_id?: string;
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

    try {
      apiStartMs = Date.now();
      createLogger('anochat.llm').debug('LLM API call starting', {
        sid: config.sessionId, model: config.modelName, attempt: attempt + 1, messageCount: messages.length,
      });

      const provider = createLLMProvider(config.provider, extensionPoints);
      const llmOptions: LLMOptions = {
        model: config.modelName,
        maxTokens: 16384,
        temperature: config.temperature,
        contextWindow: config.agentContextWindow,
        apiUrl: config.apiUrl || '',
        apiKey: config.apiKey || '',
      };

      const estimatedInputTokens = estimateTokens(messages);
      const estimatedTotalTokens = estimatedInputTokens + tools.length * 50 + llmOptions.maxTokens;
      await APIScheduler.getInstance().acquireSlot(config.apiKey || '', estimatedTotalTokens);

      const chatMessages = sanitizeOrphanedMessages(
        messages.filter((m) => m.role !== 'system') as SanitizableMsg[],
      ) as Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }>;

      const stream = provider.chat(
        chatMessages,
        tools,
        systemPrompt,
        llmOptions,
        signal,
      );

      let assistantText = '';
      const toolCallMap = new Map<string, { toolName: string; toolInput: Record<string, unknown> }>();
      let hadThink = false;

      for await (const event of stream) {
        switch (event.type) {
          case 'text_delta':
            assistantText += event.content || '';
            yield { type: SSEEventType.Text, content: event.content || '' };
            break;
          case 'think_delta':
            hadThink = true;
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
              yield { type: SSEEventType.ToolCall, id: key, name: merged.toolName, input: merged.toolInput };
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

      return { assistantMessage, hadThinkContent: hadThink, fatalError: false };
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      const errMsg = err.message || '';
      lastErr = err;

      const errLog = createLogger('anochat.llm');
      errLog.error('API attempt failed', {
        sid: config.sessionId, aid: config.agentId, model: config.modelName,
        error: errMsg.slice(0, 200), attempt: attempt + 1, turn: config.turn,
      });

      yield { type: SSEEventType.Error, errorMessage: `[Attempt ${attempt + 1}] ${errMsg.slice(0, 200)}`, code: 'API_ERROR' };

      // 413 / context too long → compact and retry
      if (errMsg.includes('413') || errMsg.includes('too long') || errMsg.includes('context')) {
        yield { type: SSEEventType.Think, content: '(Context too long, compressing and retrying...)' };
        const compaction = await compactAndRebuildMessages(messages, config.contextWindow, config.sessionId, 15, config.summarizer);
        if (!compaction.wasCompacted) {
          truncateMessagesToTail(messages, 2);
        }
        continue;
      }

      // Permanent errors — don't retry
      if (UNRETRYABLE.some((r) => r.test(errMsg))) {
        yield { type: SSEEventType.Error, errorMessage: `API Error: ${errMsg.slice(0, 200)}` };
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

      createLogger('anochat.llm').warn('Unknown API error', {
        sid: config.sessionId, aid: config.agentId, model: config.modelName,
        error: errMsg.slice(0, 200), attempt: attempt + 1,
      });
    }
  }

  // All retries exhausted without producing a message
  return { assistantMessage: null, hadThinkContent: false, fatalError: true, errorMessage: lastErr?.message };
}
