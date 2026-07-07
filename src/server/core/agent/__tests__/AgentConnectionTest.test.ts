import { afterEach, describe, expect, it, vi } from 'vitest';
import { testAgentConnection, validateAgentConnectionInput } from '../AgentConnectionTest.js';

const originalFetch = globalThis.fetch;

describe('AgentConnectionTest', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('validates required cloud provider fields', () => {
    expect(validateAgentConnectionInput({
      provider: 'openai-compatible',
      apiUrl: 'https://api.example.test',
      model: 'test-model',
      apiKey: '',
    })).toBe('API key is required for cloud providers');
  });

  it('allows Ollama without an API key', () => {
    expect(validateAgentConnectionInput({
      provider: 'ollama',
      apiUrl: 'http://localhost:11434',
      model: 'llama3.1',
      apiKey: '',
    })).toBeNull();
  });

  it('returns ok when the model streams a token', async () => {
    globalThis.fetch = vi.fn(async () => new Response(sseBody([
      'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}',
      'data: [DONE]',
    ]), { status: 200 })) as unknown as typeof fetch;

    const result = await testAgentConnection({
      provider: 'openai-compatible',
      apiUrl: 'https://api.example.test',
      apiKey: 'sk-test',
      model: 'test-model',
    });

    expect(result.ok).toBe(true);
    expect(result.message).toBe('Model connection verified');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.example.test/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns a readable failure when the provider rejects the request', async () => {
    globalThis.fetch = vi.fn(async () => new Response('bad key', { status: 401 })) as unknown as typeof fetch;

    const result = await testAgentConnection({
      provider: 'openai-compatible',
      apiUrl: 'https://api.example.test',
      apiKey: 'sk-bad',
      model: 'test-model',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('OpenAI API error 401');
    expect(result.message).toContain('bad key');
  });
});

function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${lines.join('\n')}\n\n`));
      controller.close();
    },
  });
}
