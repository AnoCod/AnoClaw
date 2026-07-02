/**
 * AgentLoopHelpers — AgentLoop helper functions
 *
 * Standalone helper functions extracted from AgentLoop.ts, stateless and side-effect free:
 *   - messageToApiMessage: Internal Message → LLM API format conversion
 *   - estimateTokens:      Token estimation (CJK-aware)
 *   - interruptibleSleep:  AbortSignal-interruptible sleep
 */

import type { Message } from '../../../shared/types/session.js';
import { AgentRegistry } from './AgentRegistry.js';
import { TokenCounter } from '../context/TokenCounter.js';

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
