/**
 * HelpCommand — /help: list all available slash commands grouped by category.
 */

import { Command } from '../Command.js';
import type { CommandResult } from '../../../../shared/types/command.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { CommandRegistry } from '../CommandRegistry.js';
import { makeCommandResult } from '../CommandResult.js';

const CATEGORY_LABELS: Record<string, string> = {
  session: 'Session',
  project: 'Project',
  workspace: 'Workspace',
  help: 'Help',
};

export class HelpCommand extends Command {
  name(): string { return 'help'; }
  description(): string { return 'Show all available slash commands'; }
  category(): 'help' { return 'help'; }

  displayName(): string { return 'Help'; }

  async execute(
    _args: Record<string, string>,
    _ctx: ExecutionContext,
  ): Promise<CommandResult> {
    const all = CommandRegistry.getInstance().allCommands();

    // Group by category
    const grouped: Map<string, Command[]> = new Map();
    for (const cmd of all) {
      const cat = cmd.category();
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat)!.push(cmd);
    }

    const lines: string[] = ['## Available Commands', ''];

    for (const [cat, cmds] of grouped) {
      const label = CATEGORY_LABELS[cat] || cat;
      lines.push(`### ${label}`);
      for (const c of cmds) {
        lines.push(`- **/${c.name()}** — ${c.description()}`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push(`_${all.length} commands available. Type \`/\` to open the command palette._`);

    return makeCommandResult(this.name(), lines.join('\n'));
  }
}
