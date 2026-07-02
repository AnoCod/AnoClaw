// EditorContextHandler — handles 'editor_context' WS messages
// Stores editor state (open files, cursor, selection) into session metadata
// so EditorContextSection can inject it into the system prompt.

import type { WsMessageHandler } from '../WsMessageRouter.js';
import { SessionManager } from '../../../core/session/SessionManager.js';

export const editorContextHandler: WsMessageHandler = (ctx) => {
  const msg = ctx.data;
  const session = SessionManager.getInstance().session(ctx.sessionId);
  if (!session) return;

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
