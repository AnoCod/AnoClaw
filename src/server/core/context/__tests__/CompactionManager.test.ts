import { beforeEach, describe, expect, it } from 'vitest';
import { ContextCompressor } from '../ContextCompressor.js';
import {
  compactAndRebuildMessages,
  type ApiMsgLite,
} from '../CompactionManager.js';
import { prepareMessagesForLLM } from '../../agent/AgentLoopLLM.js';
import type { ApiMessage } from '../../agent/AgentLoopHelpers.js';

describe('compactAndRebuildMessages', () => {
  beforeEach(() => {
    ContextCompressor.resetInstance();
  });

  it('assigns unique ids, compresses tool output, and preserves complete tool pairs', async () => {
    const messages: ApiMsgLite[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: `Original goal. ${'goal '.repeat(100)}` },
      { role: 'assistant', content: `Decision: preserve message structure. ${'decision '.repeat(100)}` },
    ];
    for (let i = 0; i < 11; i++) {
      messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Middle message ${i}. ${'context '.repeat(80)}`,
      });
    }
    messages.push({
      role: 'assistant',
      content: '',
      reasoning_content: 'The tool call is required for verification.',
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'Bash', arguments: '{"command":"npm test"}' },
      }],
    });
    const originalToolOutput = Array.from(
      { length: 80 },
      (_, i) => `2026-07-26 10:00:${String(i).padStart(2, '0')} INFO completed unit ${i}`,
    ).join('\n');
    messages.push({
      role: 'tool',
      content: originalToolOutput,
      tool_call_id: 'call-1',
      tool_success: true,
    });
    messages.push({ role: 'user', content: 'Latest request: finish the compression fix.' });
    messages.push({ role: 'assistant', content: 'Recent response one.' });
    messages.push({ role: 'user', content: 'Recent user follow-up.' });
    messages.push({ role: 'assistant', content: 'Recent response two.' });
    messages.push({ role: 'user', content: 'Most recent user message.' });

    let summarizedIds: string[] = [];
    let capturedDecision = false;
    const result = await compactAndRebuildMessages(
      messages,
      500,
      'session-1',
      6,
      async summarized => {
        summarizedIds = summarized.map(message => message.id);
        capturedDecision = summarized.some(message => message.content.includes('Decision:'));
        return '## Active Task\nFinish the compression repair.\n\n## Decisions Made\nPreserve tool pairs.';
      },
    );

    expect(result.wasCompacted).toBe(true);
    expect(summarizedIds.length).toBeGreaterThan(1);
    expect(new Set(summarizedIds).size).toBe(summarizedIds.length);
    expect(summarizedIds.every(Boolean)).toBe(true);
    expect(capturedDecision).toBe(true);

    const assistantCall = result.messages.find(message =>
      message.role === 'assistant' && message.tool_calls?.some(call => call.id === 'call-1'));
    const toolResult = result.messages.find(message =>
      message.role === 'tool' && message.tool_call_id === 'call-1');
    expect(assistantCall).toBeDefined();
    expect(assistantCall?.reasoning_content).toBe('The tool call is required for verification.');
    expect(toolResult).toBeDefined();
    expect(toolResult?.tool_success).toBe(true);
    expect((toolResult?.content || '').length).toBeLessThan(originalToolOutput.length);
    expect(result.messages.some(message =>
      message.content === 'Latest request: finish the compression fix.')).toBe(true);
    expect(result.messages.some(message =>
      message.content === 'Most recent user message.')).toBe(true);
    expect(result.messages.some(message =>
      message.id?.startsWith('compact-summary-'))).toBe(true);

    const providerMessages = prepareMessagesForLLM(result.messages as ApiMessage[]);
    expect(providerMessages.some(message =>
      message.role === 'user' && message.id?.startsWith('compact-summary-'))).toBe(true);
    expect(providerMessages.some(message =>
      message.role === 'assistant' && message.tool_calls?.some(call => call.id === 'call-1'))).toBe(true);
    expect(providerMessages.some(message =>
      message.role === 'tool' && message.tool_call_id === 'call-1')).toBe(true);
  });
});
