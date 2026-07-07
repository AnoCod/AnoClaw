import { beforeEach, describe, expect, it } from 'vitest';
import { ContextCompressor } from '../ContextCompressor.js';
import type { Message } from '../../../../shared/types/session.js';
import { MessageRole } from '../../../../shared/types/session.js';

function message(id: string, role: Message['role'], content: string): Message {
  return {
    id,
    sessionId: 'session-1',
    role,
    content,
    toolCalls: [],
    toolResults: [],
    tokenCount: 0,
    compressed: false,
    timestamp: new Date().toISOString(),
  };
}

function largeConversation(): Message[] {
  const messages: Message[] = [
    message('system-1', MessageRole.System, 'System prompt'),
  ];

  for (let i = 0; i < 30; i++) {
    messages.push(message(
      `msg-${i}`,
      i % 2 === 0 ? MessageRole.User : MessageRole.Assistant,
      `Long context message ${i}. ${'x '.repeat(120)}`,
    ));
  }

  return messages;
}

describe('ContextCompressor summarizer selection', () => {
  beforeEach(() => {
    ContextCompressor.resetInstance();
  });

  it('prefers the per-call summarizer over the singleton summarizer', async () => {
    const compressor = ContextCompressor.getInstance();
    compressor.setSummarizer(async () => 'GLOBAL SUMMARY SHOULD NOT BE USED '.repeat(3));

    const result = await compressor.generateSummary(
      largeConversation(),
      100,
      0.1,
      async () => 'PER CALL SUMMARY SHOULD BE USED '.repeat(3),
    );

    const summaryMessage = result.messages.find(m => m.id.startsWith('compact-summary-'));
    expect(result.wasCompacted).toBe(true);
    expect(summaryMessage?.content).toContain('PER CALL SUMMARY SHOULD BE USED');
    expect(summaryMessage?.content).not.toContain('GLOBAL SUMMARY SHOULD NOT BE USED');
  });
});
