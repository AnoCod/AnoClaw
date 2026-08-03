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
  it('discards streamed deltas from a failed attempt before retrying', async () => {
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
      .toEqual(['complete']);
    expect(events.some(event => event.type === SSEEventType.Error)).toBe(false);
    expect(result.assistantMessage?.content).toBe('complete');
    expect(result.fatalError).toBe(false);
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
