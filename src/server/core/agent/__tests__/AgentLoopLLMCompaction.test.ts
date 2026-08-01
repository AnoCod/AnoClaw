import { describe, expect, it } from 'vitest';
import { SUMMARY_PREFIX } from '../../context/CompactionConstants.js';
import { prepareMessagesForLLM } from '../AgentLoopLLM.js';
import type { ApiMessage } from '../AgentLoopHelpers.js';

describe('prepareMessagesForLLM compaction handoff', () => {
  it('maps recovery notices and compaction summaries to user messages while preserving tool pairs', () => {
    const messages: ApiMessage[] = [
      { id: 'system', role: 'system', content: 'primary system prompt' },
      { id: 'internal-note', role: 'system', content: 'internal recovery note' },
      {
        id: 'compact-summary-1',
        role: 'system',
        content: 'Summary recognized by stable id.',
      },
      {
        id: 'legacy-summary',
        role: 'system',
        content: `${SUMMARY_PREFIX}\n\n## Active Task\nContinue the fix.`,
      },
      {
        id: 'assistant-call',
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'Read', arguments: '{"path":"a.ts"}' },
        }],
      },
      {
        id: 'tool-result',
        role: 'tool',
        content: 'file contents',
        tool_call_id: 'call-1',
        tool_success: true,
      },
      { id: 'latest', role: 'user', content: 'Apply the remaining change.' },
    ];

    const prepared = prepareMessagesForLLM(messages);

    expect(prepared.some(message => message.content === 'primary system prompt')).toBe(false);
    expect(prepared[0]).toMatchObject({
      id: 'internal-note',
      role: 'user',
    });
    expect(prepared[1]).toMatchObject({
      id: 'compact-summary-1',
      role: 'user',
    });
    expect(prepared[2]).toMatchObject({
      id: 'legacy-summary',
      role: 'user',
    });
    expect(prepared.some(message => message.tool_calls?.[0]?.id === 'call-1')).toBe(true);
    expect(prepared.some(message => message.tool_call_id === 'call-1')).toBe(true);
    expect(prepared.at(-1)).toMatchObject({ id: 'latest', role: 'user' });
  });
});
