// MemoryDeleteTool - delete a memory entry
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
      '**When to delete:** The information is outdated, wrong, or superseded by a newer entry. Use sparingly - memories are cheap, wrong memories are expensive.\n\n' +
      'Prefer updating (MemorySave with same name+scope) over delete+recreate.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['personal', 'team', 'project', 'session_personal', 'session_team'], description: 'Scope to delete from.' },
        name: { type: 'string', description: 'Name of the memory entry to delete (must match exactly).' },
        dry_run: { type: 'boolean', description: 'Check whether the memory exists without deleting it. Default: false.' },
      },
      required: ['scope', 'name'],
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const scopeResult = normalizeEnum(params.scope, 'scope', ['personal', 'team', 'project', 'session_personal', 'session_team']);
    if (scopeResult.error) return this.makeError(scopeResult.error);
    const nameResult = normalizeString(params.name, 'name');
    if (nameResult.error) return this.makeError(nameResult.error);

    const scope = scopeResult.value!;
    const name = nameResult.value!;
    const dryRun = params.dry_run === true;

    try {
      const mm = MemoryManager.getInstance();
      const isSession = scope === 'session_personal' || scope === 'session_team';
      const sessionId = isSession ? ctx.sessionId : undefined;
      // Build scope string parseScopeParameter can parse (session:team:<id> or session:personal:<id>)
      const parsedScope = isSession && sessionId
        ? scope === 'session_team' ? `session:team:${sessionId}` : `session:personal:${sessionId}`
        : scope;
      const { scope: memScope, agentId: targetId, sessionId: parsedSessionId, subScope } = parseScopeParameter(parsedScope, ctx.agentId);

      if (dryRun) {
        const matches = await mm.search(targetId, memScope, name, parsedSessionId, subScope);
        const exact = matches.some(entry => entry.name.toLowerCase() === name.toLowerCase());
        return this.makeResult(
          exact
            ? `Memory "${name}" exists in ${scope} scope. dry_run=true; no deletion performed.`
            : `Memory "${name}" was not found in ${scope} scope. dry_run=true; no deletion performed.`,
          {
            structured: {
              scope,
              effectiveScope: memScope,
              targetId,
              name,
              status: exact ? 'found' : 'not_found',
              dryRun: true,
            },
          },
        );
      }

      const deleted = await mm.remove(targetId, memScope, name, parsedSessionId, subScope);
      if (!deleted) {
        return this.makeError(`Memory "${name}" not found in ${scope} scope.`, {
          structured: { scope, effectiveScope: memScope, targetId, name, status: 'not_found', dryRun: false },
        });
      }
      return this.makeResult(`Memory "${name}" deleted from ${scope} scope.`, {
        structured: { scope, effectiveScope: memScope, targetId, name, status: 'deleted', dryRun: false },
      });
    } catch (err) {
      return this.makeError(`Failed to delete memory: ${(err as Error).message}`);
    }
  }
}

function normalizeString(value: unknown, field: string): { value: string; error?: undefined } | { value?: undefined; error: string } {
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { error: `${field} must not be empty` };
  return { value: trimmed };
}

function normalizeEnum(
  value: unknown,
  field: string,
  allowed: string[],
): { value: string; error?: undefined } | { value?: undefined; error: string } {
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  if (!allowed.includes(value)) return { error: `${field} must be one of: ${allowed.join(', ')}` };
  return { value };
}
