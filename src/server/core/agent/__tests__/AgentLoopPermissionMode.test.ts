import { describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../AgentLoop.js';
import { SessionManager } from '../../session/SessionManager.js';
import { RiskLevel } from '../../../../shared/types/tool.js';

describe('AgentLoop permission mode', () => {
  it('treats active goal sessions as AutoEdit before showing tool confirmations', () => {
    const loop = new AgentLoop({
      agentId: 'agent-1',
      sessionId: 'session-1',
      maxTurns: 1,
      temperature: 0,
      contextWindow: 128000,
      permissionMode: 'Auto',
    });
    const sessionManager = SessionManager.getInstance();
    const getGoalSpy = vi.spyOn(sessionManager, 'getGoal').mockReturnValue({
      objective: 'keep working',
      status: 'active',
      createdAt: '2026-07-09T00:00:00.000Z',
      updatedAt: '2026-07-09T00:00:00.000Z',
    });

    try {
      const mode = (loop as unknown as { _permissionMode(): string })._permissionMode();
      const needsConfirmation = (loop as unknown as {
        _needsConfirmation(tool: { isReadOnly(): boolean; riskLevel(): string }, mode: string): boolean;
      })._needsConfirmation({
        isReadOnly: () => false,
        riskLevel: () => RiskLevel.High,
      }, mode);

      expect(mode).toBe('AutoEdit');
      expect(needsConfirmation).toBe(false);
    } finally {
      getGoalSpy.mockRestore();
    }
  });
});
