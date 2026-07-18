import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider, toOpenAIToolName } from '../OpenAICompatibleProvider.js';

const originalFetch = globalThis.fetch;

describe('OpenAICompatibleProvider tool names', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('keeps portable names and deterministically aliases namespaced plugin tools', () => {
    expect(toOpenAIToolName('Read')).toBe('Read');
    expect(toOpenAIToolName('office.create_pptx')).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(toOpenAIToolName('office.create_pptx')).toBe(toOpenAIToolName('office.create_pptx'));
    expect(toOpenAIToolName('office.create_pptx')).not.toContain('.');
  });

  it('aliases request definitions and history, then restores the original streamed tool name', async () => {
    const alias = toOpenAIToolName('web.research');
    let requestBody: any;
    globalThis.fetch = vi.fn(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body || '{}'));
      return new Response(sseBody([
        `data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"${alias}","arguments":"{\\"query\\":\\"AnoClaw\\"}"}}]},"finish_reason":"tool_calls"}]}`,
        'data: [DONE]',
      ]), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider();
    const events = [];
    for await (const event of provider.chat(
      [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'old-call',
            type: 'function',
            function: { name: 'web.research', arguments: '{"query":"old"}' },
          }],
        },
        { role: 'tool', content: 'old result', tool_call_id: 'old-call' },
      ],
      [{ name: 'web.research', description: 'Research the web', input_schema: { type: 'object' } }],
      'Test prompt',
      {
        model: 'test-model',
        maxTokens: 128,
        temperature: 0,
        contextWindow: 4096,
        apiUrl: 'https://api.example.test',
        apiKey: 'sk-test',
      },
    )) {
      events.push(event);
    }

    expect(requestBody.tools[0].function.name).toBe(alias);
    expect(requestBody.messages[1].tool_calls[0].function.name).toBe(alias);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_use',
      toolName: 'web.research',
      toolId: 'call-1',
      toolInput: { query: 'AnoClaw' },
    }));
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
