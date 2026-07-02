/**
 * Command — abstract base class for all slash commands.
 * Mirrors Tool.ts pattern: name + description + execute, extending EventEmitter.
 * Simpler than Tool — no LLM metadata, risk levels, or JSON schemas for the model.
 */

import { EventEmitter } from 'events';
import type { CommandArg, CommandDefinition, CommandResult } from '../../../shared/types/command.js';
import type { ExecutionContext } from '../../../shared/types/session.js';
import { createLogger } from '../logger.js';

export abstract class Command extends EventEmitter {
  abstract name(): string;
  abstract description(): string;
  abstract category(): CommandDefinition['category'];
  abstract execute(
    args: Record<string, string>,
    ctx: ExecutionContext,
  ): Promise<CommandResult>;

  /** User-facing display name. Override for multi-word names like "Init Project". */
  displayName(): string {
    return this.name().charAt(0).toUpperCase() + this.name().slice(1);
  }

  /** Arguments this command accepts. Override if the command takes arguments. */
  args(): CommandArg[] {
    return [];
  }

  /** Full definition object for frontend sync. */
  definition(): CommandDefinition {
    return {
      name: this.name(),
      displayName: this.displayName(),
      description: this.description(),
      category: this.category(),
      args: this.args().length > 0 ? this.args() : undefined,
    };
  }

  /** Lifecycle wrapper — records timing and ensures errors are returned, not thrown. */
  async _executeWithTiming(
    args: Record<string, string>,
    ctx: ExecutionContext,
  ): Promise<CommandResult> {
    const startedAt = Date.now();
    const logger = createLogger('anochat.command');
    logger.debug('Command executing', { command: this.name(), sid: ctx.sessionId });

    try {
      const result = await this.execute(args, ctx);
      const durationMs = Date.now() - startedAt;
      result.durationMs = durationMs;
      logger.debug('Command completed', { command: this.name(), durationMs, success: result.success });
      return result;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      logger.warn('Command failed', { command: this.name(), error: (err as Error).message, durationMs });
      return {
        success: false,
        command: this.name(),
        output: '',
        errorMessage: (err as Error).message,
        durationMs,
      };
    }
  }
}
