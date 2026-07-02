// OpenAICompatibleProvider — works with ANY OpenAI-compatible API
//   Just provide url + apiKey + modelName to use
//   Compatible with: OpenAI, DeepSeek, Qwen, Moonshot, Zhipu, OpenRouter, OneAPI, etc.
//   No vendor preselection, no model binding

import { LLMProvider } from './LLMProvider.js';
import type { LLMOptions, LLMStreamEvent } from '../../../shared/types/llm.js';

interface OpenAIDeltaToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIDelta {
  content?: string | null;
  tool_calls?: OpenAIDeltaToolCall[];
  reasoning_content?: string | null; // DeepSeek/Qwen extended field
}

interface OpenAIChoice {
  index: number;
  delta: OpenAIDelta;
  finish_reason: string | null;
}

interface OpenAIChunk {
  id: string;
  object: string;
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class OpenAICompatibleProvider extends LLMProvider {
  private _activeControllers = new Set<AbortController>();
  private _streamTimeoutMs = 120_000; // 2 min — abort if stream produces no data
  private _chunkTimeoutMs = 60_000;  // 1 min — abort if between-chunk pause exceeds this

  providerName(): string {
    return 'openai-compatible';
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

    const url = `${options.apiUrl}/v1/chat/completions`;

    // Build OpenAI-format messages
    const openaiMessages = this._buildOpenAIMessages(messages, systemPrompt);

    // Convert tools to OpenAI format if needed
    const openaiTools = tools.length > 0
      ? tools.map((t: unknown) => {
          const tool = t as Record<string, unknown>;
          // If already in OpenAI format {type: "function", function: {...}}, pass through
          if (tool.type === 'function' && tool.function) return tool;
          // If in Anthropic format {name, description, input_schema}, convert
          return {
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.input_schema,
            },
          };
        })
      : undefined;

    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      messages: openaiMessages,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (openaiTools) {
      body.tools = openaiTools;
      body.tool_choice = 'auto';
    }

    let overallTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        const err = new Error(`OpenAI API error ${response.status}: ${errorText}`);
        this.emitStreamError(err);
        yield { type: 'error', errorMessage: err.message };
        return;
      }

      if (!response.body) {
        const err = new Error('OpenAI API returned empty response body');
        this.emitStreamError(err);
        yield { type: 'error', errorMessage: err.message };
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Track streaming tool calls across chunks
      // Keyed by tool call index; each accumulates id, name, arguments
      const toolCallAccumulators = new Map<number, {
        id: string;
        name: string;
        argumentsStr: string;
      }>();

      let lastChunkTime = Date.now();

      // Overall stream timeout — abort if stream produces no data for _streamTimeoutMs.
      // Reset on every chunk so flowing data renews the deadline.
      const resetOverallTimer = () => {
        if (overallTimer) clearTimeout(overallTimer);
        overallTimer = setTimeout(() => { controller.abort(); }, this._streamTimeoutMs);
      };
      resetOverallTimer();

      while (true) {
        // Wrap reader.read() with a chunk-level timeout
        const readPromise: Promise<ReadableStreamReadResult<Uint8Array>> = reader.read();
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
          timeoutId = setTimeout(() => {
            reader.cancel('stream timeout').catch(() => {});
            reject(new Error(`LLM stream timed out: no data received in ${this._chunkTimeoutMs / 1000}s`));
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
        lastChunkTime = Date.now();
        resetOverallTimer();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // SSE data line
          if (!trimmed.startsWith('data:')) continue;
          const jsonStr = trimmed.slice(5).trim();

          // Stream end marker
          if (jsonStr === '[DONE]') {
            yield { type: 'done' };
            continue;
          }

          let chunk: OpenAIChunk;
          try {
            chunk = JSON.parse(jsonStr) as OpenAIChunk;
          } catch {
            continue;
          }

          // Some providers wrap in {error: ...}
          if ((chunk as unknown as Record<string, unknown>).error) {
            const errData = (chunk as unknown as Record<string, unknown>).error as Record<string, unknown>;
            const errMsg = (errData?.message as string) || 'Unknown OpenAI streaming error';
            const err = new Error(errMsg);
            this.emitStreamError(err);
            yield { type: 'error', errorMessage: errMsg };
            continue;
          }

          if (!chunk.choices || chunk.choices.length === 0) {
            // Final usage chunk from stream_options: { include_usage: true }
            if (chunk.usage) {
              yield {
                type: 'token_usage',
                tokenUsage: {
                  inputTokens: chunk.usage.prompt_tokens,
                  outputTokens: chunk.usage.completion_tokens,
                  totalTokens: chunk.usage.total_tokens,
                },
              };
            }
            continue;
          }

          const choice = chunk.choices[0];
          const delta = choice.delta;
          const finishReason = choice.finish_reason;

          // Handle text content
          if (delta.content) {
            yield {
              type: 'text_delta',
              content: delta.content,
            };
          }

          // Handle reasoning_content (DeepSeek/Qwen extended field)
          if (delta.reasoning_content) {
            yield {
              type: 'think_delta',
              content: delta.reasoning_content,
            };
          }

          // Handle tool calls in delta
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;

              let acc = toolCallAccumulators.get(idx);
              if (!acc) {
                acc = { id: '', name: '', argumentsStr: '' };
                toolCallAccumulators.set(idx, acc);
              }

              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) acc.argumentsStr += tc.function.arguments;
            }
          }

          // Handle finish_reason
          if (finishReason) {
            if (finishReason === 'tool_calls' || finishReason === 'function_call') {
              // Emit accumulated tool calls
              for (const [, acc] of toolCallAccumulators) {
                if (!acc.name) continue; // skip empty accumulators

                let toolInput: Record<string, unknown> = {};
                try {
                  toolInput = JSON.parse(acc.argumentsStr || '{}');
                } catch {
                  toolInput = { _raw: acc.argumentsStr };
                }

                yield {
                  type: 'tool_use',
                  toolId: acc.id,
                  toolName: acc.name,
                  toolInput,
                };
              }
            }

            if (finishReason === 'stop' || finishReason === 'tool_calls' || finishReason === 'function_call') {
              // The [DONE] marker or final chunk should also trigger done
            }
          }
        }
      }

      // End of stream
      yield { type: 'done' };
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        yield { type: 'done' };
      } else {
        const error = err instanceof Error ? err : new Error(String(err));
        this.emitStreamError(error);
        yield { type: 'error', errorMessage: error.message };
      }
    } finally {
      if (overallTimer) clearTimeout(overallTimer);
      signal?.removeEventListener('abort', onExternalAbort);
      this._activeControllers.delete(controller);
    }
  }

  /**
   * Convert internal messages + system prompt to OpenAI ChatML format.
   */
  private _buildOpenAIMessages(
    messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }>,
    systemPrompt: string,
  ): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      const openaiMsg: Record<string, unknown> = {
        role: msg.role,
        content: msg.content || '',
      };

      // Handle tool_calls on assistant messages
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        openaiMsg.tool_calls = (msg.tool_calls as Array<Record<string, unknown>>).map((tc) => {
          // Normalize to OpenAI tool_calls format
          if (tc.function) return tc;
          return {
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
            },
          };
        });
        // Keep content as '' (never null — DeepSeek requires string)
      }

      // Handle tool_call_id for tool result messages
      if (msg.role === 'tool' && msg.tool_call_id) {
        openaiMsg.tool_call_id = msg.tool_call_id;
      }

      // System role only at top level — skip system messages in the array
      if (msg.role === 'system') continue;

      result.push(openaiMsg);
    }

    return result;
  }
}
