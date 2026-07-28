import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastManager } from '../../ToastManager.js';
import { SessionAgent } from '../SessionAgent.js';
import type { SessionViewModel } from '../SessionViewModel.js';
import { setLocale } from '../../i18n/index.js';

function makeAgent(sendMessage: ReturnType<typeof vi.fn>): SessionAgent {
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SessionAgent send transaction and history reconstruction', () => {
  it('does not commit a user message or streaming state when the socket rejects the send', async () => {
    const agent = makeAgent(vi.fn(() => false));
    const added = vi.fn();
    agent.on('messageAdded', added);
    vi.spyOn(ToastManager.getInstance(), 'error').mockReturnValue(1);

    await expect(agent.sendMessage('keep this draft', 'auto', true, [])).resolves.toBe(false);

    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.messages.messages.some((message) => message.role === 'user')).toBe(false);
    expect(agent.state.messages.messages.at(-1)?.type).toBe('error');
    expect(agent.state.messages.messages.at(-1)?.content).toContain('消息发送失败');
    expect(agent.state.messages.messages.at(-1)?.content).toContain('WebSocket 无法接收消息');
    expect(added).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('commits one optimistic user message only after the socket accepts it', async () => {
    const send = vi.fn(() => true);
    const agent = makeAgent(send);
    const started = vi.fn();
    agent.on('streamingStarted', started);

    await expect(agent.sendMessage('accepted', 'auto', true, [])).resolves.toBe(true);

    expect(send).toHaveBeenCalledTimes(1);
    expect(agent.state.messages.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(agent.state.isStreaming).toBe(true);
    expect(started).toHaveBeenCalledTimes(1);
  });

  it('preserves numeric timestamps and resolves a stored AskUserQuestion with the following user message', async () => {
    const agent = makeAgent(vi.fn(() => true));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        messages: [
          { id: 'user-1', role: 'user', content: 'Choose a color', timestamp: 111 },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: '',
            timestamp: 222,
            toolCalls: [{
              id: 'ask-1',
              toolName: 'AskUserQuestion',
              params: { questions: [{ header: 'Color', question: 'Which color?', options: ['Blue', 'Green'] }] },
            }],
          },
          { id: 'user-2', role: 'user', content: 'Blue', timestamp: 333 },
        ],
        isStreaming: false,
      }),
    } as Response)));

    await expect(agent.loadHistory()).resolves.toBe(true);

    const messages = agent.state.messages.messages;
    expect(messages.find((message) => message.id === 'user-1')?.timestamp).toBe(111);
    const ask = messages.find((message) => message.toolName === 'AskUserQuestion');
    expect(ask).toMatchObject({
      id: 'ask-1',
      timestamp: 222,
      status: 'success',
      content: 'Blue',
    });
  });

  it('keeps the latest stored AskUserQuestion pending when no user answer follows', async () => {
    const agent = makeAgent(vi.fn(() => true));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        messages: [{
          role: 'assistant',
          timestamp: 444,
          toolCalls: [{
            id: 'ask-pending',
            toolName: 'AskUserQuestion',
            params: { questions: [{ question: 'Continue?', options: ['Yes', 'No'] }] },
          }],
        }],
        isStreaming: false,
      }),
    } as Response)));

    await agent.loadHistory();

    expect(agent.state.messages.messages.find((message) => message.id === 'ask-pending')).toMatchObject({
      status: 'pending',
      timestamp: 444,
    });
  });
});
