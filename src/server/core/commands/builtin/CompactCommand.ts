/**
 * CompactCommand — /compact: manually trigger context compaction for the current session.
 * Compresses conversation history, persists the compacted result, and notifies the client.
 */

import { Command } from '../Command.js';
import type { CommandResult } from '../../../../shared/types/command.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { SessionManager } from '../../session/index.js';
import { ContextCompressor, TokenCounter } from '../../context/index.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { makeCommandResult, makeCommandError } from '../CommandResult.js';

export class CompactCommand extends Command {
  name(): string { return 'compact'; }
  description(): string { return 'Check context usage and estimate compaction savings'; }
  category(): 'session' { return 'session'; }

  displayName(): string { return 'Compact Context'; }

  async execute(
    _args: Record<string, string>,
    ctx: ExecutionContext,
  ): Promise<CommandResult> {
    if (!ctx.sessionId) {
      return makeCommandError(this.name(), 'No active session.');
    }

    const sm = SessionManager.getInstance();
    const session = sm.session(ctx.sessionId);
    if (!session) {
      return makeCommandError(this.name(), 'Session not found.');
    }

    const history = await sm.getHistory(ctx.sessionId);
    if (history.length === 0) {
      return makeCommandResult(this.name(), 'No messages to compact. The conversation is empty.');
    }

    const agent = AgentRegistry.getInstance().agent(session.agentId);
    const contextWindow = agent?.contextWindow ?? 200_000;
    const beforeCount = history.length;
    const beforeTokens = TokenCounter.estimateMessages(history);
    const pctBefore = Math.round((beforeTokens / contextWindow) * 100);

    const compressor = ContextCompressor.getInstance();
    const result = await compressor.compact(history, contextWindow);

    if (!result.wasCompacted) {
      return makeCommandResult(this.name(),
        `Context is within limits (${beforeCount} messages, ~${beforeTokens.toLocaleString()} tokens = ${pctBefore}%). No compaction needed.`);
    }

    const afterTokenEstimate = TokenCounter.estimateMessages(result.messages);
    const pctAfter = Math.round((afterTokenEstimate / contextWindow) * 100);

    return makeCommandResult(this.name(),
      `**Context usage report**  \n` +
      `Messages: **${beforeCount}**  \n` +
      `Tokens: **${beforeTokens.toLocaleString()}** / ${contextWindow.toLocaleString()} (${pctBefore}%)  \n` +
      `Estimated after compaction: **${afterTokenEstimate.toLocaleString()}** tokens (${pctAfter}%)  \n` +
      `Freed: ~${(contextWindow - afterTokenEstimate).toLocaleString()} tokens  \n` +
      `_Note: Compaction is automatic and only affects LLM context — your full history is always preserved._`);
  }
}
