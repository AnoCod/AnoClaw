/**
 * PingHandler — handles 'ping' WS keepalive messages.
 *
 * Input:  `{ type: 'ping' }`
 * Output: `{ type: WsMessageType.Pong, content: 'pong' }` to the same session
 */
import type { WsMessageHandler } from '../WsMessageRouter.js';
import { WsMessageType } from '../../../../shared/types/ws-protocol.js';

export const pingHandler: WsMessageHandler = async (ctx) => {
  ctx.ws.send(ctx.sessionId, { type: WsMessageType.Pong, content: 'pong' });
};
