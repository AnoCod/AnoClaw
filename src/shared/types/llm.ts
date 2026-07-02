/**
 * AnoClaw -- LLM Types
 * Core types for LLM provider interaction: request options,
 * streaming events, and the final response shape.
 */

/** Options passed to the LLM provider for a completion request. */
export interface LLMOptions {
  model: string;
  maxTokens: number;
  temperature: number;
  contextWindow: number;
  apiUrl: string;
  apiKey: string;
}

/** Individual event emitted during a streaming LLM response. */
export interface LLMStreamEvent {
  type: 'text_delta' | 'think_delta' | 'tool_use' | 'done' | 'error' | 'token_usage';
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolId?: string;
  errorMessage?: string;
  /** Token usage from the API (token_usage event only) */
  tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

/** Complete LLM response after streaming finishes. */
export interface LLMResponse {
  text: string;
  toolCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  tokenUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  finishReason: string;
}
