/**
 * SetSessionModeHandler — handles root-session permission/effort mode updates.
 *
 * Sub-sessions are intentionally immutable here: they always resolve to AutoEdit/HIGH.
 */

import type { WsMessageHandler } from '../WsMessageRouter.js';
import { WsMessageType } from '../../../../shared/types/ws-protocol.js';
import { SessionManager } from '../../../core/session/SessionManager.js';
import {
  parsePermissionMode,
  permissionModeToUi,
  resolveSessionPermissionMode,
} from '../../../core/agent/PermissionModePolicy.js';

export const setSessionModeHandler: WsMessageHandler = async (ctx) => {
  const sessionManager = SessionManager.getInstance();
  const session = sessionManager.session(ctx.sessionId);
  if (!session) {
    ctx.ws.send(ctx.sessionId, {
      type: WsMessageType.Error,
      errorMessage: `Session "${ctx.sessionId}" not found`,
      code: 'SESSION_NOT_FOUND',
    });
    return;
  }

  const requestedMode = parsePermissionMode(ctx.data.mode)
    || sessionManager.getSessionPermissionMode(ctx.sessionId);
  const effortMode = typeof ctx.data.effort === 'boolean'
    ? ctx.data.effort
    : session.metadata.effortMode !== false;

  const storedMode = await sessionManager.setSessionPermissionMode(ctx.sessionId, requestedMode);
  const effectiveMode = resolveSessionPermissionMode(sessionManager, ctx.sessionId, storedMode);
  const effectiveEffort = await sessionManager.setSessionEffortMode(ctx.sessionId, effortMode);

  ctx.ws.send(ctx.sessionId, {
    type: WsMessageType.SessionModeChanged,
    sessionId: ctx.sessionId,
    mode: permissionModeToUi(effectiveMode),
    storedMode: permissionModeToUi(storedMode),
    effort: effectiveEffort,
    locked: !session.isRoot(),
  });
};
