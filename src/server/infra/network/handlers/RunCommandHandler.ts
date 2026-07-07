/**
 * RunCommandHandler — handles 'run_command' WS messages for slash commands.
 *
 * Input:  `{ type: 'run_command', command: string, args?: Record<string,string>, sessionId }`
 * Output: `{ type: WsMessageType.CommandResult, success, command, output, errorMessage?, code? }`
 */
import type { WsMessageHandler } from '../WsMessageRouter.js';
import { SessionManager } from '../../../core/session/SessionManager.js';
import { CommandRegistry } from '../../../core/commands/CommandRegistry.js';
import { WsMessageType } from '../../../../shared/types/ws-protocol.js';

export const runCommandHandler: WsMessageHandler = async (ctx) => {
  const msg = ctx.data;
  const cmdName = msg.command as string | undefined;

  if (!cmdName) {
    ctx.ws.send(ctx.sessionId, {
      type: WsMessageType.CommandResult,
      success: false,
      command: '',
      output: '',
      errorMessage: 'Missing command name',
      code: 'MISSING_COMMAND',
    });
    return;
  }

  const session = SessionManager.getInstance().session(ctx.sessionId);
  if (!session) {
    ctx.ws.send(ctx.sessionId, {
      type: WsMessageType.CommandResult,
      success: false,
      command: cmdName,
      output: '',
      errorMessage: 'No active session',
      code: 'NO_SESSION',
    });
    return;
  }

  const execCtx = {
    sessionId: ctx.sessionId,
    agentId: session.agentId,
    workspace: session.workspace,
    userConfirmed: true,
  };

  const result = await CommandRegistry.getInstance().execute(cmdName, (msg.args as Record<string, string>) || {}, execCtx);
  ctx.ws.send(ctx.sessionId, {
    type: WsMessageType.CommandResult,
    ...result,
  });
};
