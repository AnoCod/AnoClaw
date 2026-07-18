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
import { InterruptController, InterruptReason } from '../../../core/agent/supervision/InterruptController.js';

export const setGoalHandler: WsMessageHandler = async (ctx) => {
  const action = String(ctx.data.action || '').toLowerCase();
  const objective = typeof ctx.data.objective === 'string' ? ctx.data.objective.trim() : '';
  const sessionManager = SessionManager.getInstance();

  try {
    let goal = null;
    const root = sessionManager.getRootSession(ctx.sessionId);
    const previous = sessionManager.getGoal(ctx.sessionId);
    if (['pause', 'resume', 'complete', 'delete'].includes(action) && !previous) {
      ctx.ws.send(ctx.sessionId, {
        type: WsMessageType.Error,
        messageId: typeof ctx.data.messageId === 'string' ? ctx.data.messageId : undefined,
        errorMessage: 'Goal not found',
        code: 'GOAL_NOT_FOUND',
      });
      return;
    }
    if (action === 'complete' && previous?.status !== 'waiting_review') {
      ctx.ws.send(ctx.sessionId, {
        type: WsMessageType.Error,
        messageId: typeof ctx.data.messageId === 'string' ? ctx.data.messageId : undefined,
        errorMessage: 'Goal must be ready for review before it can be completed',
        code: 'GOAL_REVIEW_REQUIRED',
      });
      return;
    }
    if (action === 'start' || action === 'edit') {
      if (!objective) {
        ctx.ws.send(ctx.sessionId, {
          type: WsMessageType.Error,
          messageId: typeof ctx.data.messageId === 'string' ? ctx.data.messageId : undefined,
          errorMessage: 'Goal objective is required',
          code: 'GOAL_OBJECTIVE_REQUIRED',
        });
        return;
      }
      const acceptanceCriteria = typeof ctx.data.acceptanceCriteria === 'string'
        ? ctx.data.acceptanceCriteria.trim()
        : previous?.acceptanceCriteria || '';
      if (!acceptanceCriteria) {
        ctx.ws.send(ctx.sessionId, {
          type: WsMessageType.Error,
          messageId: typeof ctx.data.messageId === 'string' ? ctx.data.messageId : undefined,
          errorMessage: 'Goal completion criteria are required',
          code: 'GOAL_ACCEPTANCE_REQUIRED',
        });
        return;
      }
      goal = await sessionManager.setGoal(ctx.sessionId, {
        objective,
        acceptanceCriteria,
        // A Goal is pinned to the session's bound Workspace. Workspace changes
        // must go through the normal bind flow instead of a raw WS payload.
        workspace: root.workspace,
        permissionMode: typeof ctx.data.permissionMode === 'string' ? ctx.data.permissionMode : undefined,
        maxRuns: typeof ctx.data.maxRuns === 'number' ? ctx.data.maxRuns : undefined,
        maxConsecutiveFailures: typeof ctx.data.maxConsecutiveFailures === 'number'
          ? ctx.data.maxConsecutiveFailures
          : undefined,
        wakeIntervalMs: typeof ctx.data.wakeIntervalMs === 'number' ? ctx.data.wakeIntervalMs : undefined,
        completionMode: ctx.data.completionMode === 'automatic' ? 'automatic' : 'review',
      });
      if (action === 'edit' && previous && previous.status !== 'active' && previous.status !== 'completed') {
        const waitsOnStaleInteraction = previous.status === 'waiting_confirmation' || previous.status === 'waiting_user';
        const budgetStillExhausted = previous.status === 'budget_exhausted' && goal.runCount >= goal.maxRuns;
        const shouldRestore = waitsOnStaleInteraction
          || budgetStillExhausted
          || previous.status === 'paused'
          || previous.status === 'blocked'
          || previous.status === 'failed';
        if (shouldRestore) {
          const restoredStatus = waitsOnStaleInteraction ? 'paused' : previous.status;
          const restoredReason = waitsOnStaleInteraction
            ? 'Goal contract changed; resume to continue with the new contract'
            : previous.statusReason;
          goal = await sessionManager.updateGoalStatus(ctx.sessionId, restoredStatus, restoredReason);
        }
      }
    } else if (action === 'pause') {
      goal = await sessionManager.updateGoalStatus(ctx.sessionId, 'paused', 'Paused by user');
    } else if (action === 'resume') {
      goal = await sessionManager.updateGoalStatus(ctx.sessionId, 'active');
    } else if (action === 'complete') {
      goal = await sessionManager.updateGoalStatus(ctx.sessionId, 'completed', 'Accepted by user');
    } else if (action === 'delete') {
      goal = await sessionManager.updateGoalStatus(ctx.sessionId, 'deleted', 'Deleted by user');
    } else {
      ctx.ws.send(ctx.sessionId, {
        type: WsMessageType.Error,
        messageId: typeof ctx.data.messageId === 'string' ? ctx.data.messageId : undefined,
        errorMessage: `Invalid goal action: "${action}"`,
        code: 'INVALID_GOAL_ACTION',
      });
      return;
    }

    if (action === 'pause' || action === 'delete' || action === 'complete' || action === 'edit') {
      InterruptController.getInstance().requestInterrupt(root.id, InterruptReason.UserStop);
    }

    ctx.ws.send(root.id, {
      type: WsMessageType.GoalChanged,
      messageId: typeof ctx.data.messageId === 'string' ? ctx.data.messageId : undefined,
      sessionId: root.id,
      action,
      goal,
    });
  } catch (err) {
    ctx.ws.send(ctx.sessionId, {
      type: WsMessageType.Error,
      messageId: typeof ctx.data.messageId === 'string' ? ctx.data.messageId : undefined,
      errorMessage: `Failed to update goal: ${(err as Error).message}`,
      code: 'GOAL_UPDATE_FAILED',
    });
  }
};
