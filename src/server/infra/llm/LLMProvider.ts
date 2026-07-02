// LLMProvider — abstract base class for all LLM providers
// All providers emit streamError events and extend EventEmitter for lifecycle hooks

import { EventEmitter } from 'events';
import type { LLMOptions, LLMStreamEvent, LLMResponse } from '../../../shared/types/llm.js';

export abstract class LLMProvider extends EventEmitter {
  /**
   * Core chat method: sends messages + tools + system prompt to the LLM
   * and yields SSE-style stream events. Subclasses implement the actual HTTP/SSE logic.
   *
   * @param messages  - conversation history (role, content, optional tool_calls / tool_call_id)
   * @param tools     - tool definitions in provider-native format
   * @param systemPrompt - system-level instructions
   * @param options   - provider config (model, maxTokens, temperature, apiUrl, apiKey, contextWindow)
   * @param signal    - optional AbortSignal for cancellation
   */
  abstract chat(
    messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }>,
    tools: unknown[],
    systemPrompt: string,
    options: LLMOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<LLMStreamEvent>;

  /**
   * Cancel any in-flight request. Subclasses should abort the underlying HTTP request.
   */
  abstract cancel(): void;

  /**
   * Human-readable provider name used in logs and metrics.
   */
  abstract providerName(): string;

  /**
   * Rough token-count heuristic: ~4 characters per token.
   * Subclasses may override with a more accurate tokenizer.
   */
  protected estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Build a ChatML-style messages array from the internal message format.
   * Subclasses may override for provider-specific formatting.
   */
  protected buildMessages(
    messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }>,
    systemPrompt: string,
  ): Array<{ role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }> {
    const result: Array<{ role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }> = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      result.push({
        role: msg.role,
        content: msg.content || null,
        tool_calls: msg.tool_calls,
        tool_call_id: msg.tool_call_id,
      });
    }

    return result;
  }

  /**
   * Emit a streamError event. Callers (e.g., AgentLoop) listen on this to handle errors.
   */
  protected emitStreamError(error: Error): void {
    this.emit('streamError', error);
  }
}
