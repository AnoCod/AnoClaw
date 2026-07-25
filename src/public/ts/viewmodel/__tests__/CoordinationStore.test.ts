import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationStore } from '../CoordinationStore.js';

const task = {
  id: 'task-1',
  rootSessionId: 'root-1',
  sourceSessionId: 'root-1',
  mode: 'hierarchy',
  subject: 'Test task',
  description: 'Exercise projection replay',
  acceptanceCriteria: ['Done'],
  priority: 'normal',
  creatorAgentId: 'ceo',
  assigneeAgentId: 'worker',
  dependsOn: [],
  readOnly: true,
  writeScope: [],
  status: 'pending',
  version: 1,
  attempt: 0,
  maxAttempts: 3,
  createdAt: '2026-07-25T00:00:00.000Z',
  updatedAt: '2026-07-25T00:00:00.000Z',
} as const;

describe('CoordinationStore', () => {
  beforeEach(() => CoordinationStore.resetInstance());
  afterEach(() => {
    CoordinationStore.resetInstance();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('replays events that arrive after the REST snapshot revision', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        rootSessionId: 'root-1',
        revision: 1,
        teams: [],
        tasks: [task],
        messages: [],
        leases: [],
      }))
      .mockResolvedValueOnce(jsonResponse({
        rootSessionId: 'root-1',
        revision: 2,
        events: [{
          eventId: 'event-2',
          rootSessionId: 'root-1',
          revision: 2,
          type: 'task_updated',
          timestamp: '2026-07-25T00:00:01.000Z',
          payload: {
            task: {
              ...task,
              status: 'running',
              version: 2,
              updatedAt: '2026-07-25T00:00:01.000Z',
            },
          },
        }],
      }));
    vi.stubGlobal('fetch', fetchMock);

    const state = await CoordinationStore.getInstance().loadRoot('root-1');

    expect(state.revision).toBe(2);
    expect(state.tasks[0].status).toBe('running');
    expect(state.events).toHaveLength(1);
  });

  it('applies the next WebSocket revision once and reloads on a revision gap', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        rootSessionId: 'root-1',
        revision: 1,
        teams: [],
        tasks: [task],
        messages: [],
        leases: [],
      }))
      .mockResolvedValueOnce(jsonResponse({ rootSessionId: 'root-1', revision: 1, events: [] })));
    const store = CoordinationStore.getInstance();
    await store.loadRoot('root-1');
    store.applyWs({
      type: 'task_changed',
      rootSessionId: 'root-1',
      revision: 2,
      task: { ...task, status: 'completed', version: 2 },
    });
    store.applyWs({
      type: 'task_changed',
      rootSessionId: 'root-1',
      revision: 2,
      task: { ...task, status: 'failed', version: 2 },
    });
    expect(store.stateForSession('root-1')?.tasks[0].status).toBe('completed');

    const reload = vi.spyOn(store, 'loadRoot').mockResolvedValue(store.stateForSession('root-1')!);
    store.applyWs({
      type: 'task_changed',
      rootSessionId: 'root-1',
      revision: 4,
      task: { ...task, status: 'failed', version: 3 },
    });
    expect(reload).toHaveBeenCalledWith('root-1');
  });
});

function jsonResponse(value: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => value,
  } as Response;
}
