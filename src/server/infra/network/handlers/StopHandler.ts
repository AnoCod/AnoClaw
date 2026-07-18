/**
 * StopHandler — handles 'stop' WS message to interrupt agent execution.
 *
 * Input:  `{ type: 'stop', sessionId: string }`
 * Output: Request interrupt via InterruptController, then sends
 *         `{ type: WsMessageType.Text, content: '(Stopped by user)' }`
 */
import type { WsMessageHandler } from '../WsMessageRouter.js';
import { InterruptController, InterruptReason } from '../../../core/agent/supervision/InterruptController.js';
import { WsMessageType } from '../../../../shared/types/ws-protocol.js';
import { SessionManager } from '../../../core/session/SessionManager.js';

export const stopHandler: WsMessageHandler = async (ctx) => {
  const sessionManager = SessionManager.getInstance();
  const goal = sessionManager.getGoal(ctx.sessionId);
  if (goal?.status === 'active' || goal?.status === 'waiting_confirmation' || goal?.status === 'waiting_user') {
    const paused = await sessionManager.updateGoalStatus(ctx.sessionId, 'paused', 'Stopped by user');
    const root = sessionManager.getRootSession(ctx.sessionId);
    ctx.ws.send(root.id, {
      type: WsMessageType.GoalChanged,
      sessionId: root.id,
      action: 'pause',
      goal: paused,
    });
  }
  InterruptController.getInstance().requestInterrupt(ctx.sessionId, InterruptReason.UserStop);
  ctx.ws.send(ctx.sessionId, { type: WsMessageType.Text, content: '(Stopped by user)' });
};
