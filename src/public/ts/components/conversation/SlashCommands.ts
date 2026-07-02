/**
 * SlashCommands — Frontend command registry.
 * Static command definitions used by the slash popup panel.
 * Mirrors backend commands; fetched fresh from API on init.
 */

import type { CommandDefinition } from '../../types.js';

/** Default command definitions (used before API fetch completes). */
export const DEFAULT_COMMANDS: CommandDefinition[] = [
  {
    name: 'init',
    displayName: 'Init Project',
    description: 'Generate a CLAUDE.md file for the current project workspace',
    category: 'project',
  },
  {
    name: 'clear',
    displayName: 'Clear Context',
    description: 'Clear the current conversation context (prompt cache)',
    category: 'session',
  },
  {
    name: 'compact',
    displayName: 'Compact Context',
    description: 'Manually compact conversation history to free context space',
    category: 'session',
  },
  {
    name: 'help',
    displayName: 'Help',
    description: 'Show all available slash commands',
    category: 'help',
  },
];

let _commands: CommandDefinition[] = [...DEFAULT_COMMANDS];

export function setCommands(cmds: CommandDefinition[]): void {
  _commands = cmds;
}

export function getCommands(): CommandDefinition[] {
  return _commands;
}

export function getCommand(name: string): CommandDefinition | undefined {
  return _commands.find((c) => c.name === name);
}

/**
 * Filter commands by a query string.
 * Matches against name (exact prefix) and description (substring).
 * Returns all commands when query is empty.
 */
export function filterCommands(query: string, commands?: CommandDefinition[]): CommandDefinition[] {
  const source = commands || _commands;
  if (!query) return source;
  const q = query.toLowerCase();
  return source.filter(
    (c) => c.name.startsWith(q) || c.description.toLowerCase().includes(q),
  );
}

/** Fetch command definitions from the API and update the local registry. */
export async function loadCommandsFromApi(): Promise<CommandDefinition[]> {
  try {
    const resp = await fetch('/api/v1/commands');
    if (!resp.ok) return _commands;
    const data = await resp.json();
    if (data.commands && Array.isArray(data.commands)) {
      _commands = data.commands;
    }
  } catch {
    // Keep defaults on network error
  }
  return _commands;
}
