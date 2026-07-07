import { describe, expect, it } from 'vitest';
import { MessageRole, type Message, type ToolResultData } from '../../../../shared/types/session.js';
import { buildFocusedSummarizerTranscript } from '../AgentLoopSummarizer.js';
import { TokenCounter } from '../../context/TokenCounter.js';

function toolResult(overrides: Partial<ToolResultData> = {}): ToolResultData {
  return {
    toolCallId: overrides.toolCallId ?? 'call-1',
    success: overrides.success ?? true,
    content: overrides.content ?? 'ok',
    structured: overrides.structured,
    errorMessage: overrides.errorMessage,
    tokensUsed: overrides.tokensUsed ?? 0,
    startedAt: overrides.startedAt ?? 0,
    finishedAt: overrides.finishedAt ?? 0,
    durationMs: overrides.durationMs ?? 0,
    wasTruncated: overrides.wasTruncated ?? false,
  };
}

function message(overrides: Partial<Message> & { id: string; role: Message['role']; content: string }): Message {
  return {
    id: overrides.id,
    sessionId: overrides.sessionId ?? 'session-1',
    role: overrides.role,
    content: overrides.content,
    toolCalls: overrides.toolCalls,
    toolResults: overrides.toolResults,
    tokenCount: overrides.tokenCount ?? 0,
    compressed: overrides.compressed ?? false,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
  };
}

describe('buildFocusedSummarizerTranscript', () => {
  it('keeps the original goal and middle decisions when recent history is noisy', () => {
    const messages: Message[] = [
      message({
        id: 'goal',
        role: MessageRole.User,
        content: 'Original user goal: optimize AnoClaw context compression for long-running goals.',
      }),
      ...Array.from({ length: 20 }, (_, i) => message({
        id: `early-noise-${i}`,
        role: i % 2 === 0 ? MessageRole.Assistant : MessageRole.User,
        content: `Early filler ${i}. ${'background '.repeat(100)}`,
      })),
      message({
        id: 'decision',
        role: MessageRole.Assistant,
        content: 'Decision: use token-budgeted summarizer anchors and preserve F:\\QoderSoft\\AnoClaw\\src\\server\\core\\agent\\AgentLoopSummarizer.ts.',
      }),
      ...Array.from({ length: 30 }, (_, i) => message({
        id: `recent-noise-${i}`,
        role: i % 2 === 0 ? MessageRole.Assistant : MessageRole.User,
        content: `Recent filler ${i}. ${'tail '.repeat(100)}`,
      })),
      message({
        id: 'latest',
        role: MessageRole.User,
        content: 'Recent tail: continue the compression milestone.',
      }),
    ];

    const result = buildFocusedSummarizerTranscript(messages, 3200, 400);

    expect(result.anchorMessageIds).toContain('goal');
    expect(result.anchorMessageIds).toContain('decision');
    expect(result.selectedMessageIds).toContain('latest');
    expect(result.transcript).toContain('Original user goal');
    expect(result.transcript).toContain('Decision: use token-budgeted summarizer anchors');
    expect(result.transcript).toContain('Recent tail');
  });

  it('scales transcript capacity with the active context window', () => {
    const messages = Array.from({ length: 40 }, (_, i) => message({
      id: `msg-${i}`,
      role: i % 2 === 0 ? MessageRole.User : MessageRole.Assistant,
      content: `Message ${i}. ${'context '.repeat(80)}`,
    }));

    const small = buildFocusedSummarizerTranscript(messages, 1500, 300);
    const large = buildFocusedSummarizerTranscript(messages, 12000, 300);

    expect(large.tokenBudget).toBeGreaterThan(small.tokenBudget);
    expect(TokenCounter.estimate(large.transcript)).toBeGreaterThan(TokenCounter.estimate(small.transcript));
  });

  it('treats tool calls and failed tool results as anchors', () => {
    const messages: Message[] = [
      message({
        id: 'task',
        role: MessageRole.User,
        content: 'Inspect failing build.',
      }),
      message({
        id: 'tool-call',
        role: MessageRole.Assistant,
        content: 'Running verification.',
        toolCalls: [{ id: 'call-1', toolName: 'bash', params: { command: 'npm run build:all' } }],
      }),
      message({
        id: 'tool-result',
        role: MessageRole.Tool,
        content: '',
        toolResults: [toolResult({
          success: false,
          errorMessage: 'TypeScript failed in AgentLoopSummarizer.ts',
        })],
      }),
    ];

    const result = buildFocusedSummarizerTranscript(messages, 4000, 500);

    expect(result.anchorMessageIds).toContain('tool-call');
    expect(result.anchorMessageIds).toContain('tool-result');
    expect(result.transcript).toContain('npm run build:all');
    expect(result.transcript).toContain('TypeScript failed');
  });
});
