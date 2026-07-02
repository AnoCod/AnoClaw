// SetRunningModeHandler — handles 'set_running_mode' WS messages
// Stores the running mode (normal/infinite) on the session for AgentRuntime to read.

import type { WsMessageHandler } from '../WsMessageRouter.js';
import { SessionManager } from '../../../core/session/SessionManager.js';

export const setRunningModeHandler: WsMessageHandler = async (ctx) => {
  const runningMode = ctx.data.runningMode as string;
  if (runningMode !== 'normal' && runningMode !== 'infinite') return;

  SessionManager.getInstance().setRunningMode(ctx.sessionId, runningMode);
};
