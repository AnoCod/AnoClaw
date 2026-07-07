/**
 * AgentLoopHelpers — AgentLoop helper functions
 *
 * Standalone helper functions extracted from AgentLoop.ts, stateless and side-effect free:
 *   - messageToApiMessage: Internal Message → LLM API format conversion
 *   - estimateTokens:      Token estimation (CJK-aware)
 *   - interruptibleSleep:  AbortSignal-interruptible sleep
 */

import type { Message } from '../../../shared/types/session.js';
import { DEFAULT_CONTEXT_WINDOW } from '../../../shared/constants.js';
import { AgentRegistry } from './AgentRegistry.js';
import { TokenCounter } from '../context/TokenCounter.js';

const DEFAULT_HISTORY_CONTEXT_RATIO = 0.58;
const DEFAULT_RESPONSE_RESERVE_RATIO = 0.18;
const COMPRESSED_SUMMARY_BUDGET_RATIO = 0.25;

/** Internal API message format (provider-neutral), for LLM calls */
export interface ApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  reasoning_content?: string;
}

/**
 * Convert internal Message to LLM API message format.
 * - User messages from other Agents get a "[Name says]:" prefix
 * - toolCalls are converted to the API's expected tool_calls structure
 */
export function messageToApiMessage(msg: Message): ApiMessage {
  const result: ApiMessage = {
    role: msg.role as ApiMessage['role'],
    content: msg.content || '',
  };

  if (msg.agentId && msg.role === 'user') {
    const senderAgent = AgentRegistry.getInstance().agent(msg.agentId);
    const senderName = senderAgent?.name || msg.agentId;
    result.content = '[' + senderName + ' says]: ' + (msg.content || '');
  }

  if (msg.toolCalls && msg.toolCalls.length > 0) {
    result.tool_calls = msg.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.toolName,
        arguments: JSON.stringify(tc.params),
      },
    }));
  }

  return result;
}

/**
 * Estimate token count for a message array (CJK-aware).
 * Uses TokenCounter.estimate on each message's content and tool_calls separately.
 */
export function estimateTokens(messages: ApiMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += TokenCounter.estimate(msg.content || '');
    if (msg.tool_calls) {
      total += TokenCounter.estimate(JSON.stringify(msg.tool_calls));
    }
  }
  return total;
}

/**
 * Fallback truncation: keep system message + tail N messages, drop everything in between.
 * Used when compactAndRebuildMessages() fails to compact, as a last resort to reduce
 * context size before retrying an API call. Modifies the array in place.
 *
 * Returns the array (same reference, mutated).
 */
export function truncateMessagesToTail(messages: ApiMessage[], keepTail: number): ApiMessage[] {
  const sysMsg = messages[0];
  const tail = messages.slice(-keepTail);
  messages.length = 0;
  messages.push(sysMsg, ...tail);
  return messages;
}

export interface HistorySelectionOptions {
  contextWindow: number;
  reservedTokens?: number;
  excludeMessageIds?: string[];
  historyContextRatio?: number;
  responseReserveRatio?: number;
}

function clampRatio(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(0.9, Math.max(0.05, value as number));
}

function estimateMessageTokens(msg: Message): number {
  return Math.max(1, TokenCounter.estimateMessages([msg]) + 8);
}

function isOriginalTaskCandidate(msg: Message): boolean {
  if (msg.role !== 'user') return false;
  const content = (msg.content || '').trim();
  if (!content) return false;
  if (content.startsWith('<task-notification>')) return false;
  if (content.startsWith('[System notification]')) return false;
  return true;
}

/**
 * Select conversation history according to the active agent context window.
 *
 * This replaces fixed message-count truncation (for example, "last 200") with a
 * token-budgeted history window. It preserves compacted summaries and the first
 * user task when they fit, then fills the remaining budget from the recent tail.
 */
export function selectHistoryForContext(
  history: readonly Message[],
  options: HistorySelectionOptions,
): Message[] {
  if (!history.length) return [];

  const contextWindow = Number.isFinite(options.contextWindow) && options.contextWindow > 0
    ? options.contextWindow
    : DEFAULT_CONTEXT_WINDOW;
  const reservedTokens = Math.max(0, options.reservedTokens || 0);
  const historyRatio = clampRatio(options.historyContextRatio, DEFAULT_HISTORY_CONTEXT_RATIO);
  const responseReserveRatio = clampRatio(options.responseReserveRatio, DEFAULT_RESPONSE_RESERVE_RATIO);
  const availableAfterReserved = Math.max(0, contextWindow - reservedTokens);
  const responseReserve = Math.floor(contextWindow * responseReserveRatio);
  const historyBudget = Math.max(
    0,
    Math.min(
      Math.floor(contextWindow * historyRatio),
      availableAfterReserved - responseReserve,
    ),
  );

  if (historyBudget <= 0) return [];

  const excluded = new Set(options.excludeMessageIds || []);
  const entries = history
    .map((message, index) => ({ message, index, tokens: estimateMessageTokens(message) }))
    .filter(entry => !excluded.has(entry.message.id));

  const selected = new Set<number>();
  let usedTokens = 0;

  const trySelect = (entry: { message: Message; index: number; tokens: number }, cap = historyBudget): boolean => {
    if (selected.has(entry.index)) return true;
    if (usedTokens + entry.tokens > cap) return false;
    selected.add(entry.index);
    usedTokens += entry.tokens;
    return true;
  };

  const summaryBudget = Math.floor(historyBudget * COMPRESSED_SUMMARY_BUDGET_RATIO);
  for (const entry of entries) {
    if (!entry.message.compressed) continue;
    trySelect(entry, Math.min(historyBudget, Math.max(summaryBudget, entry.tokens)));
  }

  const firstTask = entries.find(entry => isOriginalTaskCandidate(entry.message));
  if (firstTask && firstTask.tokens <= Math.floor(historyBudget * 0.2)) {
    trySelect(firstTask);
  }

  for (let i = entries.length - 1; i >= 0; i--) {
    if (!trySelect(entries[i])) break;
  }

  return entries
    .filter(entry => selected.has(entry.index))
    .sort((a, b) => a.index - b.index)
    .map(entry => entry.message);
}

function isUserTaskMessage(msg: ApiMessage | undefined): msg is ApiMessage {
  if (!msg || msg.role !== 'user') return false;
  const content = (msg.content || '').trim();
  if (!content) return false;
  if (content.startsWith('<task-notification>')) return false;
  if (content.includes('tool_result')) return false;
  return true;
}

/**
 * Recovery truncation: keep the system prompt, the original user task, and the
 * recent tail. This prevents empty-response retries from losing the task and
 * causing the model to behave as if the conversation just started.
 */
export function truncateMessagesPreservingTask(messages: ApiMessage[], keepTail: number): ApiMessage[] {
  const sysMsg = messages[0]?.role === 'system' ? messages[0] : undefined;
  const firstUserTask = messages.find((msg, index) => index > 0 && isUserTaskMessage(msg));
  const tail = messages.slice(-keepTail);
  const preserved: ApiMessage[] = [];
  const seen = new Set<ApiMessage>();

  for (const msg of [sysMsg, firstUserTask, ...tail]) {
    if (!msg || seen.has(msg)) continue;
    preserved.push(msg);
    seen.add(msg);
  }

  messages.length = 0;
  messages.push(...preserved);
  return messages;
}

/**
 * Interruptible sleep.
 * Checks AbortSignal every 100ms, returns early when triggered.
 */
export async function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (signal?.aborted) return;
    const chunk = Math.min(100, deadline - Date.now());
    if (chunk <= 0) break;
    await new Promise((r) => setTimeout(r, chunk));
  }
}
