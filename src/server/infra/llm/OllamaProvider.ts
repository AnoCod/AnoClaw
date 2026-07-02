// OllamaProvider — Ollama local API provider with SSE streaming
// POST to {apiUrl}/api/chat, parse Ollama's native SSE format

import { LLMProvider } from './LLMProvider.js';
import type { LLMOptions, LLMStreamEvent } from '../../../shared/types/llm.js';

interface OllamaMessage {
  role: string;
  content: string;
  images?: string[];
  tool_calls?: Array<{
    function: {
      name: string;
      arguments: Record<string, unknown>;
    };
  }>;
}

interface OllamaChunk {
  model: string;
  created_at: string;
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export class OllamaProvider extends LLMProvider {
  private _activeControllers = new Set<AbortController>();
  private _chunkTimeoutMs = 60_000;  // 1 min — abort if between-chunk pause exceeds this

  providerName(): string {
    return 'ollama';
  }

  cancel(): void {
    for (const c of this._activeControllers) { c.abort(); }
    this._activeControllers.clear();
  }

  async *chat(
    messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }>,
    tools: unknown[],
    systemPrompt: string,
    options: LLMOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<LLMStreamEvent> {
    const controller = new AbortController(); this._activeControllers.add(controller);
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    const url = `${options.apiUrl}/api/chat`;

    // Build Ollama-format messages
    const ollamaMessages = this._buildOllamaMessages(messages, systemPrompt);

    // Convert tools to Ollama format
    const ollamaTools = tools.length > 0
      ? tools.map((t: unknown) => {
          const tool = t as Record<string, unknown>;
          // Ollama uses the same tool format as OpenAI
          if (tool.type === 'function' && tool.function) return tool;
          return {
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.input_schema || tool.parameters,
            },
          };
        })
      : undefined;

    const body: Record<string, unknown> = {
      model: options.model,
      messages: ollamaMessages,
      stream: true,
      options: {
        temperature: options.temperature,
        num_predict: options.maxTokens,
      },
    };

    if (ollamaTools) {
      body.tools = ollamaTools;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        const err = new Error(`Ollama API error ${response.status}: ${errorText}`);
        this.emitStreamError(err);
        yield { type: 'error', errorMessage: err.message };
        return;
      }

      if (!response.body) {
        const err = new Error('Ollama API returned empty response body');
        this.emitStreamError(err);
        yield { type: 'error', errorMessage: err.message };
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const readPromise = reader.read();
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
          timeoutId = setTimeout(() => {
            reader.cancel('stream timeout').catch(() => {});
            reject(new Error(`Ollama stream timed out: no data in ${this._chunkTimeoutMs / 1000}s`));
          }, this._chunkTimeoutMs);
        });
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await Promise.race([readPromise, timeoutPromise]);
        } catch (err) {
          if (timeoutId) clearTimeout(timeoutId);
          throw err;
        }
        if (timeoutId) clearTimeout(timeoutId);
        const { done, value } = result;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let chunk: OllamaChunk;
          try {
            chunk = JSON.parse(trimmed) as OllamaChunk;
          } catch {
            // Skip unparseable lines
            continue;
          }

          // Handle content in message
          if (chunk.message?.content && !chunk.done) {
            yield {
              type: 'text_delta',
              content: chunk.message.content,
            };
          }

          // On completion, emit tool calls if present
          if (chunk.done) {
            const msg = chunk.message;

            if (msg?.tool_calls && msg.tool_calls.length > 0) {
              for (const tc of msg.tool_calls) {
                yield {
                  type: 'tool_use',
                  toolId: `${tc.function.name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                  toolName: tc.function.name,
                  toolInput: tc.function.arguments,
                };
              }
            }

            yield { type: 'done' };
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        yield { type: 'done' };
      } else {
        const error = err instanceof Error ? err : new Error(String(err));
        this.emitStreamError(error);
        yield { type: 'error', errorMessage: error.message };
      }
    } finally {
      signal?.removeEventListener('abort', onExternalAbort);
      this._activeControllers.delete(controller);
    }
  }

  /**
   * Build Ollama-format messages from internal format + system prompt.
   * Ollama supports system role natively at the top of the messages array.
   */
  private _buildOllamaMessages(
    messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }>,
    systemPrompt: string,
  ): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      switch (msg.role) {
        case 'system':
          // System messages are handled at the top — skip duplicates
          break;

        case 'assistant': {
          const assistantMsg: Record<string, unknown> = {
            role: 'assistant',
            content: msg.content || '',
          };

          if (msg.tool_calls && msg.tool_calls.length > 0) {
            assistantMsg.tool_calls = (msg.tool_calls as Array<Record<string, unknown>>).map((tc) => {
              if (tc.function) return tc;
              return {
                function: {
                  name: tc.name,
                  arguments: tc.input || {},
                },
              };
            });
          }

          result.push(assistantMsg);
          break;
        }

        case 'tool': {
          // Ollama uses role "tool" like OpenAI
          result.push({
            role: 'tool',
            content: msg.content,
            tool_call_id: msg.tool_call_id,
          });
          break;
        }

        default:
          result.push({
            role: msg.role,
            content: msg.content || '',
          });
          break;
      }
    }

    return result;
  }
}
