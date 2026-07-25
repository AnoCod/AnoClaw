import { beforeEach, describe, expect, it } from 'vitest';
import { ContextCompressor } from '../ContextCompressor.js';
import type { Message } from '../../../../shared/types/session.js';
import { MessageRole } from '../../../../shared/types/session.js';
import { prepareMessagesForLLM } from '../../agent/AgentLoopLLM.js';
import type { ApiMessage } from '../../agent/AgentLoopHelpers.js';

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

  it('prioritizes L4 summarization over duplicate-result cleanup', async () => {
    const compressor = ContextCompressor.getInstance();
    const messages = largeConversation();
    const duplicate = {
      toolCallId: 'call-a',
      success: true,
      content: 'duplicate result payload',
      tokensUsed: 0,
      startedAt: 0,
      finishedAt: 0,
      durationMs: 0,
      wasTruncated: false,
    };
    messages[2].toolResults = [duplicate];
    messages[4].toolResults = [{ ...duplicate, toolCallId: 'call-b' }];
    let summarizerCalls = 0;

    const result = await compressor.compact(
      messages,
      100,
      0.1,
      async () => {
        summarizerCalls++;
        return 'L4 SUMMARY WAS USED '.repeat(4);
      },
    );

    expect(summarizerCalls).toBe(1);
    expect(result.wasCompacted).toBe(true);
  });

  it('keeps the latest user request when a long tail follows it', async () => {
    const compressor = ContextCompressor.getInstance();
    const messages = largeConversation();
    messages.push(message('latest-request', MessageRole.User, 'LATEST USER REQUEST MUST SURVIVE'));
    for (let i = 0; i < 12; i++) {
      messages.push(message(`after-${i}`, MessageRole.Assistant, `Tool follow-up ${i}. ${'tail '.repeat(80)}`));
    }

    const result = await compressor.compact(
      messages,
      200,
      0.1,
      async () => 'SUMMARY WITH ENOUGH CONTENT '.repeat(4),
    );

    expect(result.wasCompacted).toBe(true);
    expect(result.messages.some(msg => msg.id === 'latest-request')).toBe(true);
  });

  it('delivers deterministic fallback content when the summarizer fails', async () => {
    const compressor = ContextCompressor.getInstance();
    const result = await compressor.compact(
      largeConversation(),
      100,
      0.1,
      async () => {
        throw new Error('summary provider unavailable');
      },
    );

    const summaryMessage = result.messages.find(msg => msg.id.startsWith('compact-summary-'));
    expect(result.wasCompacted).toBe(true);
    expect(summaryMessage?.content).toContain('## Recent requests');
    const providerMessages = prepareMessagesForLLM(result.messages.map(msg => ({
      id: msg.id,
      role: msg.role,
      content: msg.content,
    })) as ApiMessage[]);
    expect(providerMessages.some(msg =>
      msg.role === 'user'
      && msg.id?.startsWith('compact-summary-')
      && msg.content?.includes('## Recent requests'))).toBe(true);
  });
});
