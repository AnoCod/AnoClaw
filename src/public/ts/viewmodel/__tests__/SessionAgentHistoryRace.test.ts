import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionAgent } from '../SessionAgent.js';
import type { SessionViewModel } from '../SessionViewModel.js';
import type { Message } from '../../types.js';

function makeAgent(): SessionAgent {
  const sessionVM = {
    sessions: { getById: () => ({ id: 'session-1', agentId: 'agent-1' }) },
    getWSClient: () => ({ connected: true }),
  } as unknown as SessionViewModel;
  const agent = new SessionAgent('session-1', sessionVM);
  vi.spyOn(agent, 'loadArtifacts').mockResolvedValue();
  return agent;
}

function response(body: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SessionAgent history reconciliation', () => {
  it('does not clear or overwrite live events when a history response arrives late', async () => {
    const agent = makeAgent();
    const existing: Message = {
      id: 'existing', sessionId: 'session-1', type: 'message', role: 'user', content: 'question', timestamp: 1,
    };
    agent.state.messages.appendMessage(existing);

    let resolveFetch!: (value: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => pendingResponse));

    const loading = agent.loadHistory();
    expect(agent.state.messages.messages.map((message) => message.id)).toEqual(['existing']);

    agent.onServerEvent('text', { content: 'live token' });
    resolveFetch(response({
      messages: [{ id: 'stored', role: 'assistant', content: 'stale snapshot' }],
      isStreaming: true,
    }));

    await expect(loading).resolves.toBe(false);
    expect(agent.state.messages.messages.map((message) => message.id)).toContain('existing');
    expect(agent.state.messages.messages.some((message) => message.content === 'live token')).toBe(true);
    expect(agent.state.messages.messages.some((message) => message.id === 'stored')).toBe(false);
  });

  it('atomically replaces stale UI state and clears a stuck stream when the server is idle', async () => {
    const agent = makeAgent();
    agent.state.isStreaming = true;
    agent.state.currentStreamMessage = 'partial';
    agent.state.streamMsgId = 'partial-id';
    agent.state.messages.appendMessage({
      id: 'partial-id', sessionId: 'session-1', type: 'message', role: 'assistant', content: 'partial', timestamp: 1,
    });
    vi.stubGlobal('fetch', vi.fn(async () => response({
      messages: [{ id: 'complete-id', role: 'assistant', content: 'complete answer' }],
      isStreaming: false,
    })));

    await expect(agent.loadHistory()).resolves.toBe(true);

    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.streamMsgId).toBeNull();
    expect(agent.state.messages.messages.map((message) => message.id)).toEqual(['complete-id']);
  });

  it('restores streaming state from the server snapshot', async () => {
    const agent = makeAgent();
    const started = vi.fn();
    agent.on('streamingStarted', started);
    vi.stubGlobal('fetch', vi.fn(async () => response({
      messages: [
        { id: 'user-1', role: 'user', content: 'question' },
        { id: 'partial-id', role: 'assistant', content: 'partial answer' },
      ],
      isStreaming: true,
    })));

    await expect(agent.loadHistory()).resolves.toBe(true);

    expect(agent.state.isStreaming).toBe(true);
    expect(started).toHaveBeenCalledTimes(1);
  });

  it('retries reconnect reconciliation until the persisted snapshot becomes idle', async () => {
    vi.useFakeTimers();
    const agent = makeAgent();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ messages: [], isStreaming: true }))
      .mockResolvedValueOnce(response({
        messages: [{ id: 'complete-id', role: 'assistant', content: 'complete answer' }],
        isStreaming: false,
      }));
    vi.stubGlobal('fetch', fetchMock);

    agent.requestHistoryReconcile();
    await vi.advanceTimersByTimeAsync(100);
    expect(agent.state.isStreaming).toBe(true);

    await vi.advanceTimersByTimeAsync(250);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.messages.messages.map((message) => message.id)).toEqual(['complete-id']);
  });
});
