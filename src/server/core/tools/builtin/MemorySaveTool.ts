// MemorySaveTool — save a memory entry
// Writes to the appropriate MEMORY.md file using MemoryManager.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { MemoryManager } from '../../memory/MemoryManager.js';

function scopeParam(s: string, sessionId?: string): string {
  if (s === 'session_personal' && sessionId) return `session:personal:${sessionId}`;
  if (s === 'session_team' && sessionId) return `session:team:${sessionId}`;
  return s;
}

export class MemorySaveTool extends Tool {

  static category = 'Memory & Skills';
  static toolDescription = 'Saves information to the persistent memory system.';
  name(): string { return 'memory_save'; }

  description(): string {
    return 'Save a memory entry. If an entry with the same name and scope already exists, it will be overwritten (update). Memories persist across sessions.';
  }

  prompt(): string {
    return '## MemorySave Usage\n' +
      'Save important information the team will need later. Be selective — don\'t save trivia.\n\n' +
      '**Scopes:**\n' +
      '- `personal`: Information only you need (preferences, personal notes). Stored in memory/agents/<your-id>/\n' +
      '- `team`: Information your whole team needs (architecture decisions, conventions, bug patterns). Stored in memory/team/\n' +
      '- `project`: Cross-team project-level knowledge.\n' +
      '- `session_personal` / `session_team`: Ephemeral — scoped to the current session only.\n\n' +
      '**Types:** `user` (about the user), `feedback` (lessons from mistakes), `project` (work context), `reference` (pointers to external resources).\n\n' +
      '**Naming:** Use descriptive kebab-case names. Prefer domain prefixes for team memories: `frontend-patterns`, `backend-auth-flow`, `tools-read-best-practices`.\n\n' +
      '**When to save:** A pattern you\'ll need again. A decision others should know. A bug that cost significant time. User preference they won\'t want to repeat.\n\n' +
      '**When NOT to save:** Single-use file paths. Temporary state. Conversation details that will be in session history.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['personal', 'team', 'project', 'session_personal', 'session_team'], description: 'Scope of the memory. Use session_personal or session_team for session-scoped memories.' },
        type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'], description: 'Type of memory entry.' },
        name: { type: 'string', description: 'Short descriptive name for the memory entry.' },
        content: { type: 'string', description: 'Full content of the memory entry to save.' },
      },
      required: ['scope', 'type', 'name', 'content'],
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const scope = params.scope as string;
    const type = params.type as string;
    const name = params.name as string;
    const content = params.content as string;

    try {
      const mm = MemoryManager.getInstance();
      const effectiveScope = scopeParam(scope, ctx.sessionId);
      const entry = await mm.saveFromParams(ctx.agentId, { scope: effectiveScope, type, name, content });
      return this.makeResult(
        `Memory saved: "${entry.name}" (${entry.type}) in ${scope} scope.`,
        { structured: { scope: effectiveScope, type, name: entry.name, agentId: ctx.agentId, status: 'saved', sessionId: ctx.sessionId } },
      );
    } catch (err) {
      return this.makeError(`Failed to save memory: ${(err as Error).message}`);
    }
  }
}
