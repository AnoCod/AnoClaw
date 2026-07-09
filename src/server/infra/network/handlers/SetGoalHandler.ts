/**
 * SetGoalHandler — manages root-session goal lifecycle.
 *
 * Actions:
 *   start/edit: require objective, activate the goal
 *   pause/resume/delete: change status
 */

import type { WsMessageHandler } from '../WsMessageRouter.js';
import { WsMessageType } from '../../../../shared/types/ws-protocol.js';
import { SessionManager } from '../../../core/session/SessionManager.js';
import {
  goalContinuationPermissionMode,
  permissionModeToUi,
  type PermissionMode,
} from '../../../core/agent/PermissionModePolicy.js';

export const setGoalHandler: WsMessageHandler = async (ctx) => {
  const action = String(ctx.data.action || '').toLowerCase();
  const objective = typeof ctx.data.objective === 'string' ? ctx.data.objective.trim() : '';
  const sessionManager = SessionManager.getInstance();

  try {
    let goal = null;
    let goalMode: { rootId: string; mode: PermissionMode; effort: boolean } | null = null;
    if (action === 'start' || action === 'edit') {
      if (!objective) {
        ctx.ws.send(ctx.sessionId, {
          type: WsMessageType.Error,
          errorMessage: 'Goal objective is required',
          code: 'GOAL_OBJECTIVE_REQUIRED',
        });
        return;
      }
      goal = await sessionManager.setGoal(ctx.sessionId, objective);
      goalMode = await applyGoalAutoEditMode(sessionManager, ctx.sessionId);
    } else if (action === 'pause') {
      goal = await sessionManager.updateGoalStatus(ctx.sessionId, 'paused');
    } else if (action === 'resume') {
      goal = await sessionManager.updateGoalStatus(ctx.sessionId, 'active');
      if (goal?.status === 'active') {
        goalMode = await applyGoalAutoEditMode(sessionManager, ctx.sessionId);
      }
    } else if (action === 'delete') {
      goal = await sessionManager.updateGoalStatus(ctx.sessionId, 'deleted');
    } else {
      ctx.ws.send(ctx.sessionId, {
        type: WsMessageType.Error,
        errorMessage: `Invalid goal action: "${action}"`,
        code: 'INVALID_GOAL_ACTION',
      });
      return;
    }

    if (goalMode) {
      ctx.ws.send(goalMode.rootId, {
        type: WsMessageType.SessionModeChanged,
        sessionId: goalMode.rootId,
        mode: permissionModeToUi(goalMode.mode),
        effort: goalMode.effort,
        locked: false,
      });
    }

    ctx.ws.send(ctx.sessionId, {
      type: WsMessageType.GoalChanged,
      sessionId: ctx.sessionId,
      action,
      goal,
    });
  } catch (err) {
    ctx.ws.send(ctx.sessionId, {
      type: WsMessageType.Error,
      errorMessage: `Failed to update goal: ${(err as Error).message}`,
      code: 'GOAL_UPDATE_FAILED',
    });
  }
};

async function applyGoalAutoEditMode(
  sessionManager: SessionManager,
  sessionId: string,
): Promise<{ rootId: string; mode: PermissionMode; effort: boolean }> {
  const root = sessionManager.getRootSession(sessionId);
  const mode = await sessionManager.setSessionPermissionMode(root.id, goalContinuationPermissionMode());
  return {
    rootId: root.id,
    mode,
    effort: root.metadata.effortMode !== false,
  };
}
