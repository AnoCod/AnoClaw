/**
 * CommandRegistrar — registers all built-in slash commands into the CommandRegistry.
 * Each command is dynamically imported and instantiated, then registered.
 */

import { CommandRegistry } from '../core/commands/CommandRegistry.js';

export async function registerAllCommands(registry: CommandRegistry): Promise<void> {
  const { InitCommand } = await import('../core/commands/builtin/InitCommand.js');
  const { ClearCommand } = await import('../core/commands/builtin/ClearCommand.js');
  const { CompactCommand } = await import('../core/commands/builtin/CompactCommand.js');
  const { HelpCommand } = await import('../core/commands/builtin/HelpCommand.js');

  registry.registerCommand(new InitCommand());
  registry.registerCommand(new ClearCommand());
  registry.registerCommand(new CompactCommand());
  registry.registerCommand(new HelpCommand());
}
