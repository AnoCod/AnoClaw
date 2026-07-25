// MemoryDeleteTool - delete a memory entry
// Removes an entry using MemoryManager.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { MemoryManager } from '../../memory/MemoryManager.js';
import { parseScopeParameter } from '../../memory/MemoryEntry.js';
import { V3ScopedMemoryService } from '../../v3/memory/V3ScopedMemoryService.js';
import {
  assertNoModelSuppliedMemoryTarget,
  parseV3MemoryScope,
  resolveV3MemoryTarget,
  v3MemoryContext,
  v3MemoryFailure,
} from '../v3/V3MemoryToolSupport.js';

export class MemoryDeleteTool extends Tool {

  static category = 'Memory & Skills';
  static toolDescription = 'Deletes entries from the persistent memory system.';

  constructor(private readonly v3Memory: V3ScopedMemoryService = V3ScopedMemoryService.getInstance()) {
    super();
  }

  name(): string { return 'memory_delete'; }

  description(): string {
    return 'Delete a memory entry by name from the specified scope. Use with caution.';
  }

  prompt(): string {
    return '## MemoryDelete Usage\n' +
      'Delete a memory entry by exact name match within a scope.\n\n' +
      '**When to delete:** The information is outdated, wrong, or superseded by a newer entry. Use sparingly - memories are cheap, wrong memories are expensive.\n\n' +
      'The scope target is bound to the current server-owned execution context.\n\n' +
      'Prefer updating (MemorySave with same name+scope) over delete+recreate.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['company', 'team', 'agent', 'workspace', 'work', 'mission'], description: 'Current-context scope to delete from.' },
        name: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S', description: 'Name of the memory entry to delete (must match exactly).' },
        dry_run: { type: 'boolean', description: 'Check whether the memory exists without deleting it. Default: false.' },
        idempotency_key: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S', description: 'Optional stable key for safe retry of the same deletion.' },
      },
      required: ['scope', 'name'],
      additionalProperties: false,
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const v3Context = v3MemoryContext(ctx.sessionId);
    const scopeResult = normalizeEnum(
      params.scope,
      'scope',
      v3Context
        ? ['company', 'team', 'agent', 'workspace', 'work', 'mission']
        : ['personal', 'team', 'project', 'session_personal', 'session_team'],
    );
    if (scopeResult.error) return this.makeError(scopeResult.error);
    const nameResult = normalizeString(params.name, 'name');
    if (nameResult.error) return this.makeError(nameResult.error);
    const dryRunResult = normalizeBoolean(params.dry_run, 'dry_run', false);
    if (dryRunResult.error) return this.makeError(dryRunResult.error);

    const scope = scopeResult.value!;
    const name = nameResult.value!;
    const dryRun = dryRunResult.value!;
    let idempotencyKey: string | undefined;
    if (params.idempotency_key !== undefined && params.idempotency_key !== null) {
      const idempotencyResult = normalizeString(params.idempotency_key, 'idempotency_key', 200);
      if (idempotencyResult.error) return this.makeError(idempotencyResult.error);
      idempotencyKey = idempotencyResult.value;
    }

    try {
      if (v3Context) {
        assertNoModelSuppliedMemoryTarget(params);
        const v3Scope = parseV3MemoryScope(scope);
        if (!v3Scope) return this.makeError('scope must be a v3 memory scope');
        const target = resolveV3MemoryTarget(v3Context, v3Scope);
        if (dryRun) {
          const existing = await this.v3Memory.get(target, name);
          return this.makeResult(
            existing
              ? `Memory "${name}" exists in ${scope} scope. dry_run=true; no deletion performed.`
              : `Memory "${name}" was not found in ${scope} scope. dry_run=true; no deletion performed.`,
            {
              structured: {
                scope,
                targetId: target.targetId,
                name,
                status: existing ? 'found' : 'not_found',
                dryRun: true,
              },
            },
          );
        }
        const deleted = await this.v3Memory.delete({
          ...target,
          idOrName: name,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });
        if (!deleted) {
          return this.makeError(`Memory "${name}" not found in ${scope} scope.`, {
            structured: {
              scope,
              targetId: target.targetId,
              name,
              status: 'not_found',
              dryRun: false,
            },
          });
        }
        return this.makeResult(`Memory "${name}" deleted from ${scope} scope.`, {
          structured: {
            scope,
            targetId: target.targetId,
            name,
            status: 'deleted',
            dryRun: false,
          },
        });
      }

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
      if (v3Context) return v3MemoryFailure(err, (message) => this.makeError(message));
      return this.makeError(`Failed to delete memory: ${(err as Error).message}`);
    }
  }
}

function normalizeString(value: unknown, field: string, maxLength = 200): { value: string; error?: undefined } | { value?: undefined; error: string } {
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { error: `${field} must not be empty` };
  if (trimmed.length > maxLength) return { error: `${field} must be ${maxLength} characters or less` };
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

function normalizeBoolean(
  value: unknown,
  field: string,
  fallback: boolean,
): { value: boolean; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: fallback };
  if (typeof value !== 'boolean') return { error: `${field} must be a boolean` };
  return { value };
}
