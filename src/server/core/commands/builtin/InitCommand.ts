/**
 * InitCommand — /init: kick off project initialization via the agent.
 *
 * The agent (not this command) analyzes the workspace and writes anoclaw.md.
 * This command just appends the init protocol prompt as a user message.
 * The agent picks it up on the next turn.
 *
 * Once anoclaw.md exists, AnoclawMdSection auto-injects it every turn.
 */

import { Command } from '../Command.js';
import type { CommandResult } from '../../../../shared/types/command.js';
import type { ExecutionContext, Message } from '../../../../shared/types/session.js';
import { MessageRole } from '../../../../shared/types/session.js';
import { SessionManager } from '../../session/index.js';
import { makeCommandResult, makeCommandError } from '../CommandResult.js';

const INIT_PROTOCOL = [
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
  '- `<cmd>` — <what it does>',
  '',
  '## Architecture',
  '<directory tree, 2-3 levels, with purpose annotations>',
  '',
  '## Conventions',
  '- <coding standards, naming patterns, import style>',
  '',
  '## Quick Task Routing',
  '| Task | Key Files |',
  '|------|-----------|',
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

export class InitCommand extends Command {
  name(): string { return 'init'; }
  description(): string { return 'Analyze the workspace and create anoclaw.md with project rules'; }
  category(): 'project' { return 'project'; }

  displayName(): string { return 'Init Project'; }

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
    if (!session.workspace) {
      return makeCommandError(this.name(), 'No workspace bound. Bind a workspace first.');
    }

    // Append the init protocol as a user message so the agent processes it
    const msg: Message = {
      id: `init-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId: ctx.sessionId,
      role: MessageRole.User,
      content: INIT_PROTOCOL,
      tokenCount: 0,
      compressed: false,
      timestamp: new Date().toISOString(),
    };
    await sm.appendMessage(ctx.sessionId, msg, { notify: false });

    return makeCommandResult(this.name(),
      'Init protocol injected. The agent will analyze the workspace and create anoclaw.md.\n' +
      'Send any message to start the analysis, or the agent will pick it up on the next turn.');
  }
}
