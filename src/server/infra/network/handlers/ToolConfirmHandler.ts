// ToolConfirmHandler — handles tool_confirm_response WS messages
// Receives user's approval/rejection for tool execution confirmations.

import type { WsMessageHandler } from '../WsMessageRouter.js';
import { ConfirmationRegistry } from '../../../core/agent/ConfirmationRegistry.js';

export const toolConfirmHandler: WsMessageHandler = async (ctx) => {
  const data = ctx.data;
  const toolCallId = data.toolCallId as string;
  const approved = data.approved === true;
  if (toolCallId) {
    ConfirmationRegistry.getInstance().resolve(toolCallId, approved);
  }
};
