import type { ToolResult } from '../../../../shared/types/tool.js';
import {
  V3ToolExecutionRegistry,
  type V3ToolExecutionContext,
} from '../../v3/runtime/V3ToolExecutionRegistry.js';
import {
  V3_MEMORY_SCOPES,
  type V3MemoryScope,
  type V3MemoryTarget,
} from '../../v3/memory/V3ScopedMemoryService.js';

const SERVER_OWNED_TARGET_FIELDS = new Set([
  'targetId',
  'target_id',
  'companyId',
  'company_id',
  'teamId',
  'team_id',
  'agentId',
  'agent_id',
  'workspaceId',
  'workspace_id',
  'workId',
  'work_id',
  'missionId',
  'mission_id',
]);

export function v3MemoryContext(sessionId: string): V3ToolExecutionContext | null {
  return V3ToolExecutionRegistry.getInstance().get(sessionId);
}

export function parseV3MemoryScope(value: unknown): V3MemoryScope | null {
  return typeof value === 'string' && V3_MEMORY_SCOPES.includes(value as V3MemoryScope)
    ? value as V3MemoryScope
    : null;
}

export function resolveV3MemoryTarget(
  context: V3ToolExecutionContext,
  scope: V3MemoryScope,
): V3MemoryTarget {
  const targetId = targetIdForScope(context, scope);
  if (!targetId) {
    throw new Error(`The current v3 Run has no server-owned ${scope} memory target.`);
  }
  return { scope, targetId };
}

export function resolveAllV3MemoryTargets(
  context: V3ToolExecutionContext,
): V3MemoryTarget[] {
  return V3_MEMORY_SCOPES.flatMap((scope) => {
    const targetId = targetIdForScope(context, scope);
    return targetId ? [{ scope, targetId }] : [];
  });
}

export function assertNoModelSuppliedMemoryTarget(
  params: Record<string, unknown>,
): void {
  const forbidden = Object.keys(params).find((key) => SERVER_OWNED_TARGET_FIELDS.has(key));
  if (forbidden) {
    throw new Error(
      `Memory target field "${forbidden}" is server-owned and cannot be supplied by the model.`,
    );
  }
}

export function v3MemoryFailure(
  error: unknown,
  makeError: (message: string) => ToolResult,
): ToolResult {
  return makeError(`Failed to access v3 memory: ${error instanceof Error ? error.message : String(error)}`);
}

function targetIdForScope(
  context: V3ToolExecutionContext,
  scope: V3MemoryScope,
): string | undefined {
  switch (scope) {
    case 'company': return context.companyId;
    case 'team': return context.teamId;
    case 'agent': return context.agentId;
    case 'workspace': return context.workspaceId;
    case 'work': return context.workId;
    case 'mission': return context.missionId;
  }
}
