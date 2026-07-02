// PingHandler — handles 'ping' WS keepalive messages

import type { WsMessageHandler } from '../WsMessageRouter.js';
import { WsMessageType } from '../../../../shared/types/ws-protocol.js';

export const pingHandler: WsMessageHandler = async (ctx) => {
  ctx.ws.send(ctx.sessionId, { type: WsMessageType.Pong, content: 'pong' });
};
