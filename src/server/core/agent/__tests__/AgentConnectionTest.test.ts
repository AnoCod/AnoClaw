import { afterEach, describe, expect, it, vi } from 'vitest';
import { testAgentConnection, validateAgentConnectionInput, queryOllamaModelContext } from '../AgentConnectionTest.js';

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

describe('queryOllamaModelContext', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('extracts context_length from Ollama model_info', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      model: 'qwen3:8b',
      model_info: { 'qwen3.context_length': 40960 },
    }), { status: 200 })) as unknown as typeof fetch;

    const result = await queryOllamaModelContext('http://127.0.0.1:11434', 'qwen3:8b');

    expect(result).toEqual({ ok: true, contextWindow: 40960 });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/show',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"model":"qwen3:8b"'),
      }),
    );
  });

  it('normalizes trailing slashes on the API URL', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      model: 'qwen3:8b',
      model_info: { 'qwen3.context_length': 40960 },
    }), { status: 200 })) as unknown as typeof fetch;

    await queryOllamaModelContext('http://127.0.0.1:11434/', 'qwen3:8b');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/show',
      expect.anything(),
    );
  });

  it('returns ok:false with the status when the model does not exist', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'model not found' }), { status: 404 })) as unknown as typeof fetch;

    const result = await queryOllamaModelContext('http://127.0.0.1:11434', 'nope:latest');

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/404/);
  });

  it('returns ok:false when model_info has no context_length', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      model: 'some-model',
      model_info: { 'some-model.embedding_length': 1024 },
    }), { status: 200 })) as unknown as typeof fetch;

    const result = await queryOllamaModelContext('http://127.0.0.1:11434', 'some-model');

    expect(result.ok).toBe(false);
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
