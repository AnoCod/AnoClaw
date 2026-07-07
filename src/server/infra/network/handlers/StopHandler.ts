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

export const stopHandler: WsMessageHandler = async (ctx) => {
  InterruptController.getInstance().requestInterrupt(ctx.sessionId, InterruptReason.UserStop);
  ctx.ws.send(ctx.sessionId, { type: WsMessageType.Text, content: '(Stopped by user)' });
};
