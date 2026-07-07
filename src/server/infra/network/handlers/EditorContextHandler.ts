/**
 * EditorContextHandler — handles 'editor_context' WS messages.
 *
 * Input:  `{ type: 'editor_context', openFiles?, activeFile?, cursorLine?, cursorColumn?,
 *           selectedText?, selectedStartLine?, selectedEndLine?, sessionId }`
 * Output: Stores editor state on session metadata for EditorContextSection to inject
 *         into the system prompt. Returns error if no session exists.
 */
import type { WsMessageHandler } from '../WsMessageRouter.js';
import { SessionManager } from '../../../core/session/SessionManager.js';
import { LogManager } from '../../logging/LogManager.js';
import { WsMessageType } from '../../../../shared/types/ws-protocol.js';

const log = LogManager.getInstance().logger('anochat.ws');

export const editorContextHandler: WsMessageHandler = (ctx) => {
  const msg = ctx.data;
  const session = SessionManager.getInstance().session(ctx.sessionId);
  if (!session) {
    log.warn('Editor context update for non-existent session', { sid: ctx.sessionId });
    ctx.ws.send(ctx.sessionId, {
      type: WsMessageType.Error,
      errorMessage: 'No active session for editor context update',
      code: 'NO_SESSION',
    });
    return;
  }

  const ec: Record<string, unknown> = {};
  if (msg.openFiles) ec.openFiles = msg.openFiles;
  if (msg.activeFile) ec.activeFile = msg.activeFile;
  if (msg.cursorLine !== undefined) ec.cursorLine = msg.cursorLine;
  if (msg.cursorColumn !== undefined) ec.cursorColumn = msg.cursorColumn;
  if (msg.selectedText) ec.selectedText = msg.selectedText;
  if (msg.selectedStartLine !== undefined) ec.selectedStartLine = msg.selectedStartLine;
  if (msg.selectedEndLine !== undefined) ec.selectedEndLine = msg.selectedEndLine;

  // Only store if there's actual data
  if (Object.keys(ec).length > 0) {
    session.metadata.editorContext = ec;
  }
};
