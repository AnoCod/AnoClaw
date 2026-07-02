// MemoryDeleteTool — delete a memory entry
// Removes an entry using MemoryManager.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { MemoryManager } from '../../memory/MemoryManager.js';
import { parseScopeParameter } from '../../memory/MemoryEntry.js';

export class MemoryDeleteTool extends Tool {

  static category = 'Memory & Skills';
  static toolDescription = 'Deletes entries from the persistent memory system.';
  name(): string { return 'memory_delete'; }

  description(): string {
    return 'Delete a memory entry by name from the specified scope. Use with caution.';
  }

  prompt(): string {
    return '## MemoryDelete Usage\n' +
      'Delete a memory entry by exact name match within a scope.\n\n' +
      '**When to delete:** The information is outdated, wrong, or superseded by a newer entry. Use sparingly — memories are cheap, wrong memories are expensive.\n\n' +
      'Prefer updating (MemorySave with same name+scope) over delete+recreate.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['personal', 'team', 'project', 'session_personal', 'session_team'], description: 'Scope to delete from.' },
        name: { type: 'string', description: 'Name of the memory entry to delete (must match exactly).' },
      },
      required: ['scope', 'name'],
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const scope = params.scope as string;
    const name = params.name as string;

    if (!scope || !name) {
      return this.makeError('Both scope and name are required.');
    }

    try {
      const mm = MemoryManager.getInstance();
      const isSession = scope === 'session_personal' || scope === 'session_team';
      const sessionId = isSession ? ctx.sessionId : undefined;
      // Build scope string parseScopeParameter can parse (session:team:<id> or session:personal:<id>)
      const parsedScope = isSession && sessionId
        ? scope === 'session_team' ? `session:team:${sessionId}` : `session:personal:${sessionId}`
        : scope;
      const { scope: memScope, agentId: targetId, sessionId: parsedSessionId, subScope } = parseScopeParameter(parsedScope, ctx.agentId);
      const deleted = await mm.remove(targetId, memScope, name, parsedSessionId, subScope);
      if (!deleted) {
        return this.makeError(`Memory "${name}" not found in ${scope} scope.`);
      }
      return this.makeResult(`Memory "${name}" deleted from ${scope} scope.`);
    } catch (err) {
      return this.makeError(`Failed to delete memory: ${(err as Error).message}`);
    }
  }
}
