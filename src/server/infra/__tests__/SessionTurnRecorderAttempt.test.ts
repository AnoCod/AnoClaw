import { afterEach, describe, expect, it, vi } from 'vitest';
import { SSEEventType } from '../../../shared/types/events.js';
import { SessionStore } from '../../core/session/SessionStore.js';
import { SessionTurnRecorder } from '../SessionTurnRecorder.js';

function textFromEvent(event: Record<string, unknown>): string {
  const message = event.message as { content?: Array<{ text?: string }> } | undefined;
  return message?.content?.[0]?.text || '';
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SessionTurnRecorder LLM attempts', () => {
  it('persists only the committed retry and increments the turn once', async () => {
    const persisted: Record<string, unknown>[] = [];
    const store = {
      loadHeadEventUuid: vi.fn(async () => null),
      persistEvent: vi.fn(async (_sessionId: string, event: Record<string, unknown>) => {
        persisted.push(event);
        return event.uuid as string;
      }),
      incrementMessageCount: vi.fn(async () => {}),
    } as unknown as SessionStore;
    vi.spyOn(SessionStore, 'getInstance').mockReturnValue(store);

    const recorder = new SessionTurnRecorder('session-1', 'agent-1', 'turn-1');
    await recorder.record({ type: SSEEventType.LlmAttemptStart, attemptId: 'attempt-1' });
    recorder.bufferDelta('text', 'failed-partial');
    await recorder.record({
      type: SSEEventType.ToolCall,
      attemptId: 'attempt-1',
      id: 'failed-tool',
      name: 'Read',
      input: {},
    });
    await recorder.record({ type: SSEEventType.LlmAttemptRollback, attemptId: 'attempt-1' });

    await recorder.record({ type: SSEEventType.LlmAttemptStart, attemptId: 'attempt-2' });
    recorder.bufferDelta('text', 'complete');
    await recorder.record({ type: SSEEventType.LlmAttemptCommit, attemptId: 'attempt-2' });
    await recorder.finalize();

    expect(persisted.map(textFromEvent).filter(Boolean)).toEqual(['complete']);
    expect(JSON.stringify(persisted)).not.toContain('failed-partial');
    expect(JSON.stringify(persisted)).not.toContain('failed-tool');
    expect(store.incrementMessageCount).toHaveBeenCalledTimes(1);
  });
});
