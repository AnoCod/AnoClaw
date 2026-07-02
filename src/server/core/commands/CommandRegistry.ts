/**
 * CommandRegistry — singleton registry for all slash commands.
 * Mirrors ToolRegistry pattern: register, lookup, list, execute with role check.
 */

import { EventEmitter } from 'events';
import { Command } from './Command.js';
import type { CommandDefinition, CommandResult } from '../../../shared/types/command.js';
import type { ExecutionContext } from '../../../shared/types/session.js';
import { createLogger } from '../logger.js';
import { makeCommandError } from './CommandResult.js';

interface CommandEntry {
  command: Command;
}

export class CommandRegistry extends EventEmitter {
  private static _instance: CommandRegistry;

  private _commands: Map<string, CommandEntry> = new Map();

  static getInstance(): CommandRegistry {
    if (!CommandRegistry._instance) {
      CommandRegistry._instance = new CommandRegistry();
    }
    return CommandRegistry._instance;
  }

  static resetInstance(): void {
    if (CommandRegistry._instance) {
      CommandRegistry._instance.removeAllListeners();
      CommandRegistry._instance._commands.clear();
      CommandRegistry._instance = undefined as unknown as CommandRegistry;
    }
  }

  private constructor() {
    super();
  }

  // ── Registration ──

  registerCommand(cmd: Command): void {
    const name = cmd.name();
    if (this._commands.has(name)) {
      createLogger('anochat.command').warn('Duplicate command registration', { commandName: name });
    }
    this._commands.set(name, { command: cmd });
    this.emit('commandRegistered', name);
  }

  // ── Lookup ──

  command(name: string): Command | undefined {
    return this._commands.get(name)?.command;
  }

  hasCommand(name: string): boolean {
    return this._commands.has(name);
  }

  // ── Listing ──

  allCommands(): Command[] {
    return Array.from(this._commands.values()).map((e) => e.command);
  }

  allCommandNames(): string[] {
    return Array.from(this._commands.keys());
  }

  /** Full definitions for frontend sync (GET /api/v1/commands). */
  allCommandDefinitions(): CommandDefinition[] {
    return this.allCommands().map((c) => c.definition());
  }

  // ── Execution ──

  async execute(
    name: string,
    args: Record<string, string>,
    ctx: ExecutionContext,
  ): Promise<CommandResult> {
    const cmd = this.command(name);
    if (!cmd) {
      return makeCommandError(name, `Unknown command: /${name}. Type /help to see available commands.`);
    }

    return cmd._executeWithTiming(args, ctx);
  }
}
