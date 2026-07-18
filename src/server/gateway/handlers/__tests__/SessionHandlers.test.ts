import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Session } from '../../../core/session/Session.js';
import { SessionManager } from '../../../core/session/SessionManager.js';
import { SessionStatus, SessionType } from '../../../../shared/types/session.js';
import { handleListSessions } from '../SessionHandlers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleListSessions', () => {
  it('returns persisted metadata so a completed Goal is restored after cold start', () => {
    const goal = {
      goalId: 'goal-1',
      status: 'completed',
      objective: 'Keep Goal state across reloads',
      statusReason: 'Accepted by user',
    };
    const session = new Session({
      sessionId: 'session-1',
      parentSessionId: null,
      level: 0,
      agentId: 'ceo',
      type: SessionType.Main,
      status: SessionStatus.Active,
      title: 'Goal session',
      workspace: 'F:/workspace',
      createdAt: '2026-07-18T00:00:00.000Z',
      lastActiveAt: '2026-07-18T00:01:00.000Z',
      subSessionIds: [],
      metadata: { permissionMode: 'Auto', effortMode: true, goal },
    });
    vi.spyOn(SessionManager, 'getInstance').mockReturnValue({
      activeSessions: () => [session],
    } as unknown as SessionManager);

    let status = 0;
    let body: Record<string, unknown> = {};
    handleListSessions(
      { url: '/api/v1/sessions' } as IncomingMessage,
      {} as ServerResponse,
      (_res, nextStatus, nextBody) => {
        status = nextStatus;
        body = nextBody as Record<string, unknown>;
      },
      '127.0.0.1',
    );

    expect(status).toBe(200);
    expect(body.sessions).toEqual([
      expect.objectContaining({
        id: 'session-1',
        metadata: expect.objectContaining({ goal }),
      }),
    ]);
  });
});
