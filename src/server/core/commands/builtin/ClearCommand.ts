/**
 * ClearCommand — /clear: clear the current session's prompt cache.
 * Busts the dynamic zone cache so the next turn rebuilds all sections fresh.
 */

import { Command } from '../Command.js';
import type { CommandResult } from '../../../../shared/types/command.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { PromptAssembler } from '../../prompt/PromptAssembler.js';
import { makeCommandResult, makeCommandError } from '../CommandResult.js';

export class ClearCommand extends Command {
  name(): string { return 'clear'; }
  description(): string { return 'Clear the current conversation context (prompt cache)'; }
  category(): 'session' { return 'session'; }

  async execute(
    _args: Record<string, string>,
    ctx: ExecutionContext,
  ): Promise<CommandResult> {
    if (!ctx.sessionId || !ctx.agentId) {
      return makeCommandError(this.name(), 'No active session.');
    }

    PromptAssembler.getInstance().onClear(ctx.agentId, ctx.sessionId);

    return makeCommandResult(this.name(),
      'Context cleared. The next message will use a fresh system prompt with current workspace state.');
  }
}
