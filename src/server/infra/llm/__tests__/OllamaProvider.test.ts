import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from '../OllamaProvider.js';

const originalFetch = globalThis.fetch;

/** Ollama streams raw JSON objects, one per line (not `data:` SSE prefix). */
function ollamaLines(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${lines.join('\n')}\n`));
      controller.close();
    },
  });
}

const baseOptions = {
  model: 'qwen3:8b',
  maxTokens: 2048,
  temperature: 0.7,
  contextWindow: 4096,
  apiUrl: 'http://127.0.0.1:11434',
  apiKey: '',
};

describe('OllamaProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('streams content deltas as text_delta and emits done', async () => {
    globalThis.fetch = vi.fn(async () => new Response(ollamaLines([
      '{"model":"qwen3:8b","message":{"role":"assistant","content":"你好"},"done":false}',
      '{"model":"qwen3:8b","message":{"role":"assistant","content":"世界"},"done":false}',
      '{"model":"qwen3:8b","message":{"role":"assistant","content":""},"done":true}',
    ]), { status: 200 })) as unknown as typeof fetch;

    const provider = new OllamaProvider();
    const events: any[] = [];
    for await (const event of provider.chat(
      [{ role: 'user', content: 'hi' }],
      [],
      'system',
      baseOptions,
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: 'text_delta', content: '你好' });
    expect(events).toContainEqual({ type: 'text_delta', content: '世界' });
    expect(events).toContainEqual({ type: 'done' });
  });

  it('streams thinking field as think_delta (qwen3-style thinking models)', async () => {
    globalThis.fetch = vi.fn(async () => new Response(ollamaLines([
      '{"message":{"role":"assistant","content":"","thinking":"嗯"},"done":false}',
      '{"message":{"role":"assistant","content":"","thinking":"，让我想想"},"done":false}',
      '{"message":{"role":"assistant","content":"答案是2"},"done":false}',
      '{"message":{"role":"assistant","content":""},"done":true}',
    ]), { status: 200 })) as unknown as typeof fetch;

    const provider = new OllamaProvider();
    const events: any[] = [];
    for await (const event of provider.chat(
      [{ role: 'user', content: '1+1?' }],
      [],
      'system',
      baseOptions,
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: 'think_delta', content: '嗯' });
    expect(events).toContainEqual({ type: 'think_delta', content: '，让我想想' });
    expect(events).toContainEqual({ type: 'text_delta', content: '答案是2' });
  });

  it('yields tool_use when tool_calls arrive in a non-done chunk', async () => {
    globalThis.fetch = vi.fn(async () => new Response(ollamaLines([
      '{"message":{"role":"assistant","content":"","tool_calls":[{"id":"call_1","function":{"name":"calculator","arguments":{"a":123,"b":456}}}]},"done":false}',
      '{"message":{"role":"assistant","content":""},"done":true}',
    ]), { status: 200 })) as unknown as typeof fetch;

    const provider = new OllamaProvider();
    const events: any[] = [];
    for await (const event of provider.chat(
      [{ role: 'user', content: 'compute 123*456' }],
      [{ name: 'calculator', description: 'multiply', input_schema: { type: 'object' } }],
      'system',
      baseOptions,
    )) {
      events.push(event);
    }

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_use',
      toolName: 'calculator',
      toolInput: { a: 123, b: 456 },
    }));
    expect(events).toContainEqual({ type: 'done' });
  });

  it('also yields tool_use when tool_calls arrive on the done chunk', async () => {
    globalThis.fetch = vi.fn(async () => new Response(ollamaLines([
      '{"message":{"role":"assistant","content":"","tool_calls":[{"id":"call_9","function":{"name":"Read","arguments":{"path":"a.txt"}}}]},"done":true}',
    ]), { status: 200 })) as unknown as typeof fetch;

    const provider = new OllamaProvider();
    const events: any[] = [];
    for await (const event of provider.chat(
      [{ role: 'user', content: 'read a.txt' }],
      [{ name: 'Read', description: 'read file', input_schema: { type: 'object' } }],
      'system',
      baseOptions,
    )) {
      events.push(event);
    }

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_use',
      toolName: 'Read',
      toolInput: { path: 'a.txt' },
    }));
  });

  it('builds the request body in Ollama format (system first, tool messages with tool_call_id)', async () => {
    let requestBody: any;
    globalThis.fetch = vi.fn(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body || '{}'));
      return new Response(ollamaLines([
        '{"message":{"role":"assistant","content":"ok"},"done":false}',
        '{"message":{"role":"assistant","content":""},"done":true}',
      ]), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new OllamaProvider();
    const history = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'tc-1-abc',
          type: 'function' as const,
          function: { name: 'calculator', arguments: '{"a":1,"b":2}' },
        }],
      },
      { role: 'tool', content: '3', tool_call_id: 'tc-1-abc' },
      { role: 'user', content: 'then?' },
    ];
    for await (const _event of provider.chat(
      history as any,
      [{ name: 'calculator', description: 'multiply', input_schema: { type: 'object' } }],
      'You are a helper',
      baseOptions,
    )) { /* drain */ }

    expect(requestBody.model).toBe('qwen3:8b');
    expect(requestBody.stream).toBe(true);
    expect(requestBody.messages[0]).toEqual({ role: 'system', content: 'You are a helper' });
    expect(requestBody.messages[1].tool_calls[0]).toEqual({
      id: 'tc-1-abc',
      function: { name: 'calculator', arguments: { a: 1, b: 2 } },
    });
    expect(requestBody.messages[2]).toEqual({ role: 'tool', content: '3', tool_call_id: 'tc-1-abc' });
    expect(requestBody.messages[3]).toEqual({ role: 'user', content: 'then?' });
    expect(requestBody.tools[0]).toEqual({
      type: 'function',
      function: { name: 'calculator', description: 'multiply', parameters: { type: 'object' } },
    });
  });

  it('yields error event when Ollama returns a non-200 status', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"error":"model not found"}', { status: 404 })) as unknown as typeof fetch;

    const provider = new OllamaProvider();
    const events: any[] = [];
    for await (const event of provider.chat(
      [{ role: 'user', content: 'hi' }],
      [],
      'system',
      baseOptions,
    )) {
      events.push(event);
    }

    expect(events).toContainEqual(expect.objectContaining({ type: 'error' }));
    expect(events[0].errorMessage).toMatch(/404/);
  });
});
