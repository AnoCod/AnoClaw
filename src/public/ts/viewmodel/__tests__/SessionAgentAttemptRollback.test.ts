import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../types.js';
import { SessionAgent } from '../SessionAgent.js';
import type { SessionViewModel } from '../SessionViewModel.js';

function makeAgent(): SessionAgent {
  return new SessionAgent('session-1', {
    sessions: { getById: () => ({ id: 'session-1', agentId: 'agent-1' }) },
    getWSClient: () => ({ connected: true }),
  } as unknown as SessionViewModel);
}

describe('SessionAgent LLM attempt rollback', () => {
  it('removes provisional text, thinking, and tool UI while preserving prior state', () => {
    const agent = makeAgent();
    const baseline: Message = {
      id: 'user-1', sessionId: 'session-1', type: 'message', role: 'user', content: 'question', timestamp: 1,
    };
    agent.state.messages.appendMessage(baseline);
    agent.state.isStreaming = true;
    const rolledBack = vi.fn();
    agent.on('attemptRolledBack', rolledBack);

    agent.onServerEvent('llm_attempt_start', { attemptId: 'attempt-1' });
    agent.onServerEvent('think', { content: 'partial thought', attemptId: 'attempt-1' });
    agent.onServerEvent('text', { content: 'partial answer', attemptId: 'attempt-1' });
    agent.onServerEvent('tool_call', {
      id: 'tool-1', name: 'Read', input: {}, attemptId: 'attempt-1',
    });
    expect(agent.state.messages.messages.length).toBeGreaterThan(1);

    agent.onServerEvent('llm_attempt_rollback', { attemptId: 'attempt-1' });

    expect(agent.state.messages.messages).toEqual([baseline]);
    expect(agent.state.isStreaming).toBe(true);
    expect(agent.state.streamMsgId).toBeNull();
    expect(agent.state.currentStreamMessage).toBe('');
    expect(agent.state.currentThinkMsg).toBeNull();
    expect(rolledBack).toHaveBeenCalledWith({ attemptId: 'attempt-1' });
  });

  it('keeps a committed live response and ignores a late rollback', () => {
    const agent = makeAgent();
    agent.state.isStreaming = true;

    agent.onServerEvent('llm_attempt_start', { attemptId: 'attempt-1' });
    agent.onServerEvent('text', { content: 'complete', attemptId: 'attempt-1' });
    agent.onServerEvent('llm_attempt_commit', { attemptId: 'attempt-1' });
    agent.onServerEvent('llm_attempt_rollback', { attemptId: 'attempt-1' });

    expect(agent.state.messages.messages.some(message => message.content === 'complete')).toBe(true);
    expect(agent.state.llmAttemptSnapshot).toBeNull();
  });

  it('restores provisional state when a fatal transport error bypasses rollback', () => {
    const agent = makeAgent();
    agent.state.isStreaming = true;
    const rolledBack = vi.fn();
    agent.on('attemptRolledBack', rolledBack);
    agent.state.messages.appendMessage({
      id: 'user-1', sessionId: 'session-1', type: 'message', role: 'user', content: 'question', timestamp: 1,
    });

    agent.onServerEvent('llm_attempt_start', { attemptId: 'attempt-1' });
    agent.onServerEvent('text', { content: 'failed-partial', attemptId: 'attempt-1' });
    agent.onServerEvent('error', { errorMessage: 'transport failed' });

    expect(agent.state.messages.messages.some(message => message.content === 'failed-partial')).toBe(false);
    expect(agent.state.messages.messages.at(-1)).toEqual(expect.objectContaining({
      type: 'error',
      content: 'transport failed',
    }));
    expect(agent.state.llmAttemptSnapshot).toBeNull();
    expect(rolledBack).toHaveBeenCalledWith({ attemptId: 'attempt-1' });
  });
});
