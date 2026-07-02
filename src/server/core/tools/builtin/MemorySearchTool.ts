// MemorySearchTool — search agent memories
// Searches personal and team memories using MemoryManager.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { MemoryManager } from '../../memory/MemoryManager.js';
import { MemoryScope } from '../../memory/MemoryEntry.js';

export class MemorySearchTool extends Tool {

  static category = 'Memory & Skills';
  static toolDescription = 'Searches the persistent memory system for relevant entries.';
  name(): string { return 'memory_search'; }

  description(): string {
    return 'Search memories across personal, team, or all scopes. Returns matching memory entries with metadata.';
  }

  prompt(): string {
    return '## MemorySearch Usage\n' +
      'Search the persistent memory system before starting unfamiliar work. Past agents may have left relevant knowledge.\n\n' +
      '**When to search:**\n' +
      '- Before modifying a subsystem you haven\'t touched — check for conventions and gotchas.\n' +
      '- When a user references past work ("like we did last time").\n' +
      '- After hitting an error — someone may have documented the fix.\n\n' +
      '**Scope strategy:**\n' +
      '- Default to `all` for broad lookups.\n' +
      '- Use `team` for project conventions and shared decisions.\n' +
      '- Use `personal` for your own past notes.\n' +
      '- `session_personal` / `session_team` for current-session ephemeral data.\n\n' +
      'Fuzzy matching is on by default — typo-tolerant, cross-language synonyms work (e.g. "日志" matches "logging").';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query — keywords or phrases to find in memories. Supports fuzzy matching (typo-tolerant) and cross-language synonyms (e.g. "日志" matches "logging").' },
        scope: { type: 'string', enum: ['team', 'personal', 'session_personal', 'session_team', 'all'], description: 'Scope to search. Default: "all". session_personal/session_team search session-scoped.' },
        fuzzy: { type: 'boolean', description: 'Enable fuzzy/semantic matching with typo tolerance. Default: true (always on).' },
      },
      required: ['query'],
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }

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
