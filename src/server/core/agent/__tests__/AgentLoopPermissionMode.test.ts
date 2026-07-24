import { describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../AgentLoop.js';
import { SessionManager } from '../../session/SessionManager.js';
import { RiskLevel } from '../../../../shared/types/tool.js';
import type { PermissionMode, SessionGoal } from '../../../../shared/types/session.js';

function activeGoal(permissionMode: PermissionMode = 'Auto'): SessionGoal {
  return {
    goalId: 'goal-1',
    version: 1,
    objective: 'keep working',
    acceptanceCriteria: 'verified result',
    workspace: 'F:/workspace',
    permissionMode,
    maxRuns: 20,
    maxConsecutiveFailures: 3,
    wakeIntervalMs: 15000,
    completionMode: 'review',
    status: 'active',
    createdAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
    runCount: 0,
    consecutiveFailures: 0,
  };
}

describe('AgentLoop permission mode', () => {
  it('runs an active Goal in Auto Edit without high-risk confirmation gates', () => {
    const loop = new AgentLoop({
      agentId: 'agent-1',
      sessionId: 'session-1',
      maxTurns: 1,
      temperature: 0,
      contextWindow: 128000,
      permissionMode: 'Auto',
    });
    const sessionManager = SessionManager.getInstance();
    const getGoalSpy = vi.spyOn(sessionManager, 'getGoal').mockReturnValue(activeGoal());

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

  it('ignores legacy Goal permission values and uses Auto Edit', () => {
    const loop = new AgentLoop({
      agentId: 'agent-1',
      sessionId: 'session-1',
      maxTurns: 1,
      temperature: 0,
      contextWindow: 128000,
      permissionMode: 'Auto',
    });
    const getGoalSpy = vi.spyOn(SessionManager.getInstance(), 'getGoal').mockReturnValue(activeGoal('Ask'));

    try {
      expect((loop as unknown as { _permissionMode(): string })._permissionMode()).toBe('AutoEdit');
    } finally {
      getGoalSpy.mockRestore();
    }
  });

});
