import { describe, expect, it, vi } from 'vitest';
import { ConversationViewModel } from '../ConversationViewModel.js';

describe('ConversationViewModel Goal permissions', () => {
  it('restores a persisted completed Goal when a cold-loaded session becomes active', () => {
    const goal = {
      goalId: 'goal-1',
      status: 'completed',
      objective: 'Keep Goal state across reloads',
      statusReason: 'Accepted by user',
    };
    const root = {
      id: 'session-1',
      level: 0,
      workspace: 'F:/workspace',
      metadata: { permissionMode: 'Auto', effortMode: true, goal },
    };
    const conversation = new ConversationViewModel();
    (conversation as unknown as { _sessionVM: unknown })._sessionVM = {
      activeSession: root,
      sessions: { getById: vi.fn((id: string) => id === root.id ? root : undefined) },
    };

    conversation.setActiveSession(root.id);

    expect(conversation.goal).toEqual(goal);
  });

  it('does not silently promote an active Goal when the user changes the session mode', () => {
    const sent: Array<Record<string, unknown>> = [];
    const root = {
      id: 'session-1',
      level: 0,
      workspace: 'F:/workspace',
      metadata: {
        permissionMode: 'Auto',
        goal: { status: 'active', permissionMode: 'Ask' },
      },
    };
    const conversation = new ConversationViewModel();
    (conversation as unknown as { _sessionVM: unknown })._sessionVM = {
      activeSession: root,
      sessions: { updateSession: vi.fn() },
      getWSClient: () => ({ send: (message: Record<string, unknown>) => sent.push(message) }),
    };

    conversation.setPermissionMode('ask');

    expect(conversation.permissionMode).toBe('ask');
    expect(root.metadata.permissionMode).toBe('Ask');
    expect(sent.at(-1)).toMatchObject({ type: 'set_session_mode', mode: 'ask' });
  });
});
