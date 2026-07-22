// OpenAICompatibleProvider — works with ANY OpenAI-compatible API
//   Just provide url + apiKey + modelName to use
//   Compatible with: OpenAI, DeepSeek, Qwen, Moonshot, Zhipu, OpenRouter, OneAPI, etc.
//   No vendor preselection, no model binding

import { LLMProvider } from './LLMProvider.js';
import type { LLMOptions, LLMStreamEvent } from '../../../shared/types/llm.js';
import { PROVIDER_OPENAI_COMPATIBLE } from '../../../shared/constants.js';

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

const OPENAI_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function stableToolNameHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Convert an internal AnoClaw tool name to the portable subset accepted by
 * OpenAI-compatible APIs. Plugin names intentionally use namespaces such as
 * `vendor.create_asset`; those names stay unchanged inside AnoClaw and are only
 * aliased at the provider boundary.
 */
export function toOpenAIToolName(name: string): string {
  if (OPENAI_TOOL_NAME_RE.test(name)) return name;

  const slug = name
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 44) || 'tool';
  const alias = `anoclaw_${stableToolNameHash(name)}_${slug}`;
  return alias.slice(0, 64);
}

export class OpenAICompatibleProvider extends LLMProvider {
  private _activeControllers = new Set<AbortController>();
  private _streamTimeoutMs = 120_000; // 2 min — abort if stream produces no data
  private _chunkTimeoutMs = 60_000;  // 1 min — abort if between-chunk pause exceeds this

  providerName(): string {
    return PROVIDER_OPENAI_COMPATIBLE;
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

    const originalToProvider = new Map<string, string>();
    const providerToOriginal = new Map<string, string>();
    const providerNameFor = (originalName: string): string => {
      const existing = originalToProvider.get(originalName);
      if (existing) return existing;

      const base = toOpenAIToolName(originalName);
      let candidate = base;
      let collision = 1;
      while (providerToOriginal.has(candidate) && providerToOriginal.get(candidate) !== originalName) {
        const suffix = `_${collision++}`;
        candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
      }
      originalToProvider.set(originalName, candidate);
      providerToOriginal.set(candidate, originalName);
      return candidate;
    };

    // Reserve already-valid names first so a generated alias can never shadow
    // a real tool with the same name.
    const toolNames = tools.map((raw) => {
      const tool = raw as Record<string, unknown>;
      const fn = tool.function as Record<string, unknown> | undefined;
      return typeof fn?.name === 'string'
        ? fn.name
        : typeof tool.name === 'string' ? tool.name : '';
    }).filter(Boolean);
    for (const name of toolNames.filter((name) => OPENAI_TOOL_NAME_RE.test(name))) {
      providerNameFor(name);
    }
    for (const name of toolNames.filter((name) => !OPENAI_TOOL_NAME_RE.test(name))) {
      providerNameFor(name);
    }

    // Build OpenAI-format messages, including historical tool calls, with the
    // same aliases advertised in the current tool definitions.
    const openaiMessages = this._buildOpenAIMessages(messages, systemPrompt, providerNameFor);

    // Convert tools to OpenAI format if needed
    const openaiTools = tools.length > 0
      ? tools.map((t: unknown) => {
          const tool = t as Record<string, unknown>;
          // If already in OpenAI format {type: "function", function: {...}},
          // clone it so the registry-owned descriptor is never mutated.
          if (tool.type === 'function' && tool.function) {
            const fn = tool.function as Record<string, unknown>;
            return {
              ...tool,
              function: {
                ...fn,
                name: typeof fn.name === 'string' ? providerNameFor(fn.name) : fn.name,
              },
            };
          }
          // If in Anthropic format {name, description, input_schema}, convert
          return {
            type: 'function',
            function: {
              name: typeof tool.name === 'string' ? providerNameFor(tool.name) : tool.name,
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
                  toolName: providerToOriginal.get(acc.name) || acc.name,
                  toolInput,
                };
              }
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
    providerNameFor: (name: string) => string = toOpenAIToolName,
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
          if (tc.function) {
            const fn = tc.function as Record<string, unknown>;
            return {
              ...tc,
              function: {
                ...fn,
                name: typeof fn.name === 'string' ? providerNameFor(fn.name) : fn.name,
              },
            };
          }
          return {
            id: tc.id,
            type: 'function',
            function: {
              name: typeof tc.name === 'string' ? providerNameFor(tc.name) : tc.name,
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
