import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SSEEvent } from '../../../../shared/types/events.js';
import { SSEEventType } from '../../../../shared/types/events.js';
import type { LLMOptions, LLMStreamEvent } from '../../../../shared/types/llm.js';
import { APIScheduler } from '../../../infra/llm/APIScheduler.js';
import { extensionPoints } from '../../plugin-host/ExtensionPoints.js';
import {
  calculateMaxOutputTokens,
  callLLMWithRetry,
  type LLMCallConfig,
  type LLMCallResult,
} from '../AgentLoopLLM.js';
import type { ApiMessage } from '../AgentLoopHelpers.js';

const OWNER = 'agent-loop-llm-reliability-test';

afterEach(() => {
  extensionPoints.unregisterAll(OWNER);
  APIScheduler.resetInstance();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeConfig(overrides: Partial<LLMCallConfig> = {}): LLMCallConfig {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    modelName: 'test-model',
    provider: 'test',
    apiUrl: '',
    apiKey: 'test-key',
    agentContextWindow: 8000,
    temperature: 0,
    contextWindow: 8000,
    turn: 1,
    postWait: false,
    ...overrides,
  };
}

async function collect(
  generator: AsyncGenerator<SSEEvent, LLMCallResult>,
): Promise<{ events: SSEEvent[]; result: LLMCallResult }> {
  const events: SSEEvent[] = [];
  while (true) {
    const step = await generator.next();
    if (step.done) return { events, result: step.value };
    events.push(step.value);
  }
}

describe('callLLMWithRetry reliability', () => {
  it('streams deltas immediately and replaces partial text before retrying', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    extensionPoints.register('llmProvider', OWNER, () => ({
      async *chat(): AsyncGenerator<LLMStreamEvent> {
        attempts++;
        if (attempts === 1) {
          yield { type: 'text_delta', content: 'partial-' };
          throw new Error('ECONNRESET while streaming');
        }
        yield { type: 'text_delta', content: 'complete' };
        yield { type: 'done' };
      },
      cancel(): void {},
      providerName(): string { return 'test'; },
    }));

    const running = collect(callLLMWithRetry(
      makeConfig(),
      [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
      'system',
      [],
      undefined,
    ));
    await vi.advanceTimersByTimeAsync(30_000);
    const { events, result } = await running;

    expect(attempts).toBe(2);
    expect(events.filter(event => event.type === SSEEventType.Text).map(event => event.content))
      .toEqual(['partial-', 'complete']);
    expect(events.filter(event => event.type === SSEEventType.ReplaceText)).toHaveLength(1);
    expect(events.some(event => event.type === SSEEventType.Error)).toBe(false);
    expect(result.assistantMessage?.content).toBe('complete');
    expect(result.fatalError).toBe(false);
  });

  it('keeps streamed text and never retries when the user aborts', async () => {
    let attempts = 0;
    const controller = new AbortController();
    extensionPoints.register('llmProvider', OWNER, () => ({
      async *chat(): AsyncGenerator<LLMStreamEvent> {
        attempts++;
        yield { type: 'text_delta', content: 'kept-' };
        controller.abort();
        throw new Error('The operation was aborted');
      },
      cancel(): void {},
      providerName(): string { return 'test'; },
    }));

    const { events, result } = await collect(callLLMWithRetry(
      makeConfig(),
      [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
      'system',
      [],
      controller.signal,
    ));

    expect(attempts).toBe(1);
    expect(events.filter(event => event.type === SSEEventType.Text).map(event => event.content)).toEqual(['kept-']);
    expect(events.some(event => event.type === SSEEventType.ReplaceText)).toBe(false);
    expect(result.assistantMessage).toBeNull();
    expect(result.fatalError).toBe(false);
  });

  it('defers tool events until an attempt completes', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    extensionPoints.register('llmProvider', OWNER, () => ({
      async *chat(): AsyncGenerator<LLMStreamEvent> {
        attempts++;
        if (attempts === 1) {
          yield { type: 'text_delta', content: 'intro-' };
          yield { type: 'tool_use', toolName: 'search', toolId: 't1', toolInput: { q: 'x' } };
          throw new Error('ECONNRESET while streaming');
        }
        yield { type: 'text_delta', content: 'final' };
        yield { type: 'tool_use', toolName: 'search', toolId: 't1', toolInput: { q: 'x' } };
        yield { type: 'done' };
      },
      cancel(): void {},
      providerName(): string { return 'test'; },
    }));

    const running = collect(callLLMWithRetry(
      makeConfig(),
      [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
      'system',
      [],
      undefined,
    ));
    await vi.advanceTimersByTimeAsync(30_000);
    const { events, result } = await running;

    expect(attempts).toBe(2);
    const texts = events.filter(event => event.type === SSEEventType.Text).map(event => event.content);
    expect(texts).toEqual(['intro-', 'final']);
    const replaceIndex = events.findIndex(event => event.type === SSEEventType.ReplaceText);
    const toolIndex = events.findIndex(event => event.type === SSEEventType.ToolCall);
    // Attempt 1's tool call must not leak; the only ToolCall arrives after the replace.
    expect(replaceIndex).toBeGreaterThan(-1);
    expect(toolIndex).toBeGreaterThan(replaceIndex);
    expect(result.assistantMessage?.tool_calls).toHaveLength(1);
  });

  it('passes a completion budget bounded by the configured context window', async () => {
    let capturedOptions: LLMOptions | undefined;
    extensionPoints.register('llmProvider', OWNER, () => ({
      async *chat(
        _messages: unknown[],
        _tools: unknown[],
        _systemPrompt: string,
        options: LLMOptions,
      ): AsyncGenerator<LLMStreamEvent> {
        capturedOptions = options;
        yield { type: 'text_delta', content: 'ok' };
        yield { type: 'done' };
      },
      cancel(): void {},
      providerName(): string { return 'test'; },
    }));

    await collect(callLLMWithRetry(
      makeConfig({ agentContextWindow: 1000, contextWindow: 1000, postWait: true }),
      [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
      'system',
      [],
      undefined,
    ));

    expect(capturedOptions?.maxTokens).toBeGreaterThan(0);
    expect(capturedOptions?.maxTokens).toBeLessThan(1000);
    expect(capturedOptions?.maxTokens).not.toBe(16384);
    expect(calculateMaxOutputTokens(1000, 250)).toBeLessThanOrEqual(750);
  });
});
