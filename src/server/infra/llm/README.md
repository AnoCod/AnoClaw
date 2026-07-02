# src/server/infra/llm — LLM Provider Layer

## Overview

Provides a unified streaming LLM interface across OpenAI-compatible APIs (DeepSeek, Qwen, Claude via proxy, OneAPI, OpenRouter, etc.) and Ollama local models. Includes rate-limit scheduling, token batching for WebSocket streaming, and a provider factory with plugin extension-point overrides.

## Public Interface

### LLMProvider (abstract base)

Base class for all LLM providers. Extends `EventEmitter`.

```ts
abstract class LLMProvider extends EventEmitter {
  // Core streaming method — yields SSEEvent objects
  abstract chat(
    messages: Message[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
    options: LLMOptions,
    signal?: AbortSignal
  ): AsyncGenerator<LLMStreamEvent>;

  abstract cancel(): void;
  abstract providerName(): string;

  // Protected utilities (overridable)
  protected estimateTokens(text: string): number;       // chars / 4 heuristic
  protected buildMessages(messages, systemPrompt): Array<Record<string, unknown>>;
  protected emitStreamError(error: Error): void;
}
```

**Stream events yielded:**
| Event | Payload | Description |
|-------|---------|-------------|
| `text_delta` | `{ content: string }` | Streaming text token |
| `think_delta` | `{ content: string }` | Reasoning content (DeepSeek/Qwen) |
| `tool_use` | `{ id, name, input }` | Completed tool call |
| `token_usage` | `{ inputTokens, outputTokens, totalTokens }` | Usage stats |
| `done` | `{ finishReason }` | Stream complete |
| `error` | `{ errorMessage }` | Stream error |

**Events:** emits `'streamError'` (Error) via EventEmitter.

---

### OpenAICompatibleProvider extends LLMProvider

Works with any OpenAI-format chat completions API.

```ts
class OpenAICompatibleProvider extends LLMProvider {
  providerName(): string;  // 'openai-compatible'

  // Posts to {apiUrl}/v1/chat/completions with Bearer auth
  // Handles streaming tool_call deltas, reasoning_content, usage chunks
  // Timeouts: 2min overall, 1min between chunks

  cancel(): void;  // Aborts all in-flight fetch requests
}
```

**DeepSeek constraints handled:**
- `role` always present (including tool results)
- Empty content coerced to `""` (not `null`)
- Orphaned tool results sanitized
- `image_url` not included (DeepSeek V3 doesn't support it)

---

### OllamaProvider extends LLMProvider

Works with local Ollama instances.

```ts
class OllamaProvider extends LLMProvider {
  providerName(): string;  // 'ollama'

  // Posts to {apiUrl}/api/chat
  // Tool calls arrive in batch on final done:true chunk
  // Client-side tool ID generation: {name}_{timestamp}_{random6}

  cancel(): void;
}
```

---

### Provider Factory

```ts
function createLLMProvider(
  provider: string,                   // 'ollama' | 'openai-compatible' | ...
  extPoints?: ExtensionPoints | null  // Plugin extension points
): LLMProvider;
```

| config.provider value | Constructs |
|----------------------|------------|
| `'ollama'` | `new OllamaProvider()` |
| anything else | `new OpenAICompatibleProvider()` |
| Plugin override | Uses `extPoints.get('llmProvider')` if registered |

---

### APIScheduler (Singleton)

Rate-limit gating using a sliding-window algorithm. Prevents HTTP 429.

```ts
class APIScheduler extends EventEmitter {
  static getInstance(): APIScheduler;

  // Wait until a request slot is available (max 2s wait)
  async acquireSlot(apiKey: string, estimatedTokens: number): Promise<void>;

  // Update rate-limit state from response headers
  updateFromHeaders(apiKey: string, headers: Record<string, string>): void;

  remainingRequests(apiKey: string): number;
  remainingTokens(apiKey: string): number;
}
```

**Constants:** `DEFAULT_RPM` (from shared RATE_LIMIT_PER_MINUTE), `DEFAULT_TPM = 50_000_000`, 1-minute sliding window, 50ms poll interval.

**Events:** `'waiting'` (when throttled), `'headersUpdated'` (after parsing rate-limit headers).

---

### TokenBatcher

Accumulates streaming tokens within one event-loop tick, flushing as a batch for WebSocket.

```ts
class TokenBatcher extends EventEmitter {
  constructor(flushIntervalMs?: number);  // default 16ms (~60fps)

  addToken(token: string): void;
  flush(): void;          // Force immediate flush, emits 'flush'(tokens[])
  bufferSize: number;     // Read-only
  clear(): void;          // Discard without emitting
}
```

**Events:** `'flush'` (`tokens: string[]`).

---

## Dependencies

```
LLMProvider        → events (EventEmitter), shared/types/llm
OpenAICompatible   → LLMProvider, shared/types/llm
OllamaProvider     → LLMProvider, shared/types/llm
provider-factory   → LLMProvider, OpenAICompatible, OllamaProvider
APIScheduler       → events, shared/constants (RATE_LIMIT_PER_MINUTE)
TokenBatcher       → events
```

## Usage

```ts
import { createLLMProvider } from './infra/llm/provider-factory.js';

const provider = createLLMProvider('openai-compatible');

const options = {
  apiUrl: 'https://api.deepseek.com',
  apiKey: 'sk-...',
  model: 'deepseek-chat',
  maxTokens: 200000,
  temperature: 1.0,
  contextWindow: 128000,
};

const messages = [
  { role: 'user', content: 'Hello!' },
];

for await (const event of provider.chat(messages, [], 'You are helpful.', options)) {
  switch (event.type) {
    case 'text_delta':
      process.stdout.write(event.content);
      break;
    case 'done':
      console.log('\nDone:', event.finishReason);
      break;
  }
}
```
