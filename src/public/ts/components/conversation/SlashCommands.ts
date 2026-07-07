/**
 * SlashCommands — Frontend command registry.
 * Static command definitions used by the slash popup panel.
 * Mirrors backend commands; fetched fresh from API on init.
 */

import type { CommandDefinition } from '../../types.js';

/**
 * Protocol prompt for /init — injected as a user message so the agent analyzes
 * the workspace and writes anoclaw.md. The file is then auto-injected every turn.
 */
export const INIT_PROTOCOL_PROMPT = [
  '## /init — Project Initialization Protocol',
  '',
  'You MUST analyze the current workspace and create an `anoclaw.md` file at the workspace root.',
  'This file will be automatically injected into every future conversation turn.',
  '',
  '### Step 1: Explore',
  '- List the top-level directory structure (Glob or Bash `ls -la`)',
  '- Read package.json if present (dependencies, scripts, project metadata)',
  '- Read tsconfig.json / jsconfig.json if present',
  '- Read any existing AGENTS.md, anoclaw.md, README.md, or .gitignore for conventions',
  '- Identify the project type, tech stack, build system, and coding patterns',
  '',
  '### Step 2: Generate anoclaw.md',
  'Write the file to `<workspace>/anoclaw.md` using the Write tool. Follow this structure:',
  '',
  '```',
  '# <Project Name>',
  '',
  '## Tech Stack',
  '- Language: <detected>',
  '- Runtime/Framework: <detected>',
  '- Build tool: <detected>',
  '- Test framework: <detected>',
  '- Key dependencies: <list>',
  '',
  '## Build Commands',
  '- `npm run build` — <what it does>',
  '- `npm test` — <what it does>',
  '- `npm run dev` — <what it does>',
  '',
  '## Architecture',
  '```',
  '<directory tree, 2-3 levels>',
  '```',
  '- `src/server/` — <purpose>',
  '- `src/public/` — <purpose>',
  '- `src/shared/` — <purpose>',
  '',
  '## Conventions',
  '- <coding standards, naming patterns, import style, etc.>',
  '- <anything you observe from reading existing code>',
  '',
  '## Quick Task Routing',
  '| Task | Key Files |',
  '|------|-----------|',
  '| <common task> | <file paths> |',
  '```',
  '',
  '### Rules',
  '- Use actual file paths and observed facts. Never invent generic content.',
  '- If you cannot determine something, write "TODO: <question>" instead of guessing.',
  '- Keep it between 80-200 lines. Be specific, not verbose.',
  '- After writing, confirm the file exists and report what you created.',
  '',
  '### Important',
  'This is a ONE-TIME setup task. After creating anoclaw.md, do NOT mention',
  'or suggest running /init again. The file will be auto-injected from now on.',
].join('\n');

/** Default command definitions (used before API fetch completes). */
export const DEFAULT_COMMANDS: CommandDefinition[] = [
  {
    name: 'init',
    displayName: 'Init Project',
    description: 'Generate an anoclaw.md file for the current project workspace',
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
