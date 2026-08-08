import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionAgent } from '../SessionAgent.js';
import type { SessionViewModel } from '../SessionViewModel.js';
import { setLocale } from '../../i18n/index.js';

function makeAgent(sendMessage: ReturnType<typeof vi.fn> = vi.fn(() => true)): SessionAgent {
  const sessionVM = {
    sessions: {
      getById: () => ({ id: 'session-1', agentId: 'agent-1', title: 'Existing session' }),
    },
    ensureRunnableAgentForSession: vi.fn(async () => {}),
    getWSClient: () => ({ connected: true, sendMessage }),
    renameSession: vi.fn(async () => true),
  } as unknown as SessionViewModel;
  return new SessionAgent('session-1', sessionVM);
}

beforeEach(() => setLocale('zh-CN'));

afterEach(() => {
  setLocale('zh-CN');
  vi.restoreAllMocks();
});

describe('SessionAgent replace_text', () => {
  it('discards the partial streaming segment and restarts cleanly', () => {
    const agent = makeAgent();
    const stopped = vi.fn();
    const replaced = vi.fn();
    agent.on('streamingStopped', stopped);
    agent.on('textReplaced', replaced);

    agent.onServerEvent('text', { content: 'partial-' });
    expect(agent.state.isStreaming).toBe(true);
    expect(agent.state.messages.messages.some((m) => m.content === 'partial-')).toBe(true);

    agent.onServerEvent('replace_text', {});
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.streamMsgId).toBeNull();
    expect(agent.state.currentStreamMessage).toBe('');
    expect(agent.state.messages.messages.some((m) => m.content === 'partial-')).toBe(false);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(replaced).toHaveBeenCalledTimes(1);

    agent.onServerEvent('text', { content: 'complete' });
    expect(agent.state.isStreaming).toBe(true);
    const textMessages = agent.state.messages.messages.filter((m) => m.role === 'assistant');
    expect(textMessages).toHaveLength(1);
    expect(textMessages[0].content).toBe('complete');
  });

  it('also discards the partial think block', () => {
    const agent = makeAgent();
    agent.onServerEvent('think', { content: 'reasoning-' });
    agent.onServerEvent('replace_text', {});
    expect(agent.state.currentThinkMsg).toBeNull();
    expect(agent.state.messages.messages.some((m) => m.type === 'think')).toBe(false);
  });
});
