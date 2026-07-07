// MemorySearchTool - search agent memories
// Searches personal and team memories using MemoryManager.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { MemoryManager } from '../../memory/MemoryManager.js';
import { MemoryScope } from '../../memory/MemoryEntry.js';

export class MemorySearchTool extends Tool {

  static category = 'Memory & Skills';
  static toolDescription = 'Searches durable memory for relevant project, user, team, or session knowledge.';
  name(): string { return 'memory_search'; }

  description(): string {
    return 'Search memory across personal, team, session, or all scopes. Use before unfamiliar work or when past decisions may matter.';
  }

  prompt(): string {
    return [
      '## memory_search Usage',
      'Search memory when previous context could improve accuracy: project conventions, past bugs, user preferences, or prior decisions.',
      '',
      'Use broad all-scope search for unfamiliar work, team scope for shared project rules, and personal scope for your own lessons.',
      'After finding a relevant entry, use memory_recall for full content only when the summary is insufficient.',
    ].join('\n');
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query - keywords or phrases to find in memories. Supports fuzzy matching (typo-tolerant) and cross-language synonyms (e.g. "logging" matches "logging").' },
        scope: { type: 'string', enum: ['team', 'personal', 'session_personal', 'session_team', 'all'], description: 'Scope to search. Default: "all". session_personal/session_team search session-scoped.' },
        fuzzy: { type: 'boolean', description: 'Enable fuzzy/semantic matching with typo tolerance. Default: true (always on).' },
      },
      required: ['query'],
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }

  isReadOnly(): boolean { return true; }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const query = params.query as string;
    const scope = (params.scope as string) || 'all';
    const fuzzy = params.fuzzy !== false; // default true

    try {
      const mm = MemoryManager.getInstance();
      let entries;
      if (scope === 'personal') {
        entries = await mm.search(ctx.agentId, MemoryScope.Agent, query, undefined, undefined, fuzzy);
      } else if (scope === 'team') {
        entries = await mm.search(ctx.agentId, MemoryScope.Team, query, undefined, undefined, fuzzy);
      } else if (scope === 'session_personal') {
        entries = await mm.search(ctx.agentId, MemoryScope.Session, query, ctx.sessionId, 'personal', fuzzy);
      } else if (scope === 'session_team') {
        entries = await mm.search(ctx.agentId, MemoryScope.Session, query, ctx.sessionId, 'team', fuzzy);
      } else {
        entries = await mm.searchAllScopes(ctx.agentId, query, ctx.sessionId);
      }

      if (entries.length === 0) {
        return this.makeResult(`No memories found for query "${query}" in ${scope} scope.`);
      }

      const lines = [`Found ${entries.length} memories for "${query}" in ${scope} scope:`, ''];
      for (const e of entries) {
        lines.push(`- [${e.type}] **${e.name}** (${e.scope}): ${e.content.slice(0, 200)}`);
      }
      return this.makeResult(lines.join('\n'), {
        structured: { query, scope, count: entries.length, entries: entries.map(e => ({ name: e.name, type: e.type, scope: e.scope })) },
      });
    } catch (err) {
      return this.makeError(`Failed to search memories: ${(err as Error).message}`);
    }
  }
}
