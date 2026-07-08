// SubAgentDeleteTool - destroy a temporary SubAgent
// Only works on SubAgents (role === SubAgent). Does NOT destroy Managers/Members.
// Unregisters the agent from AgentRegistry.

import { Tool, RiskLevel, InterruptBehavior } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { AgentRole, AgentState } from '../../../../shared/types/agent.js';

const MAX_AGENT_ID_LENGTH = 200;
const MAX_REASON_LENGTH = 500;

interface DeleteParams {
  agentId: string;
  dryRun: boolean;
  reason: string | null;
}

export class SubAgentDeleteTool extends Tool {

  static category = 'Task Delegation';
  static toolDescription = 'Removes a live temporary sub-agent from the registry while preserving transcripts for audit.';
  name(): string {
    return 'SubAgentDelete';
  }

  description(): string {
    return 'Destroy a temporary SubAgent. Only works on SubAgents (not Managers or Members). The SubAgent is marked destroyed and unregistered; persisted transcripts are preserved for audit.';
  }

  prompt(): string {
    return '## SubAgentDelete Usage\n' +
      'Clean up a SubAgent spawned with SubAgentSpawn. Only works on SubAgent role - you cannot delete Managers or Members.\n\n' +
      '**When to use:** After receiving a SubAgent result and you no longer need it. To cancel a misbehaving temporary agent.\n\n' +
      '**Delegation cleanup:** SubAgentSpawn (create) -> use the result -> SubAgentDelete (clean up). Permanent team members (TaskAssign targets) should NOT be deleted this way.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_AGENT_ID_LENGTH,
          pattern: '\\S',
          description: 'ID of the SubAgent to destroy',
        },
        dry_run: {
          type: 'boolean',
          description: 'If true, report what would be deleted without mutating the registry. Default false.',
        },
        reason: {
          type: 'string',
          maxLength: MAX_REASON_LENGTH,
          description: 'Optional short reason for audit/debug output.',
        },
      },
      required: ['agentId'],
      additionalProperties: false,
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Low;
  }

  interruptBehavior(): InterruptBehavior {
    return InterruptBehavior.Block;
  }

  async execute(
    params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const normalized = normalizeDeleteParams(params);
    if (!normalized.ok) return this.makeError(normalized.error);
    const { agentId, dryRun, reason } = normalized.value;

    const registry = AgentRegistry.getInstance();
    const agent = registry.agent(agentId);

    if (!agent) {
      return this.makeError(
        `SubAgent '${agentId}' was not found in the registry. It may have already completed and been cleaned up.`,
        {
          structured: {
            agentId,
            status: 'not_found',
            deleted: false,
            dryRun,
          },
        },
      );
    }

    // Only allow deletion of SubAgents
    if (agent.role !== AgentRole.SubAgent) {
      return this.makeError(
        `Cannot delete '${agent.name}': role is '${agent.role}'. ` +
        'Only SubAgents can be deleted with this tool. ' +
        'Use the admin interface to destroy Managers or Members.',
        {
          structured: {
            agentId,
            agentName: agent.name,
            role: agent.role,
            status: 'wrong_role',
            deleted: false,
            dryRun,
          },
        },
      );
    }

    const structuredBase = {
      agentId,
      agentName: agent.name,
      role: agent.role,
      parentAgentId: agent.parentAgentId,
      state: agent.state,
      wasActive: agent.isActive,
      dryRun,
      reason,
      sessionAction: 'preserved_transcripts',
    };

    if (dryRun) {
      return this.makeResult(
        `Dry run: SubAgent '${agent.name}' (${agentId}) would be ` +
        `${agent.isActive ? 'destroyed and unregistered' : 'unregistered as an already-destroyed stale entry'}. ` +
        'Persisted transcripts would be preserved.',
        {
          structured: {
            ...structuredBase,
            status: 'dry_run',
            deleted: false,
          },
        },
      );
    }

    if (!agent.isActive) {
      const unregistered = registry.unregisterAgent(agentId);
      return this.makeResult(
        `SubAgent '${agent.name}' (${agentId}) was already destroyed; ` +
        `${unregistered ? 'stale registry entry removed' : 'registry entry was already absent'}. ` +
        'Persisted transcripts were preserved.',
        {
          structured: {
            ...structuredBase,
            status: 'already_destroyed',
            deleted: false,
            unregistered,
          },
        },
      );
    }

    // Mark as destroyed
    agent.setState(AgentState.Destroyed);

    // Unregister from registry
    const unregistered = registry.unregisterAgent(agentId);

    return this.makeResult(
      `SubAgent '${agent.name}' (${agentId}) destroyed and unregistered successfully. Persisted transcripts were preserved.`,
      {
        structured: {
          ...structuredBase,
          status: 'deleted',
          deleted: true,
          unregistered,
        },
      },
    );
  }
}

type Normalization<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function normalizeDeleteParams(params: Record<string, unknown>): Normalization<DeleteParams> {
  const agentIdResult = normalizeString(params.agentId, 'agentId', MAX_AGENT_ID_LENGTH);
  if (!agentIdResult.ok) return agentIdResult;

  const dryRunResult = normalizeBoolean(params.dry_run, 'dry_run', false);
  if (!dryRunResult.ok) return dryRunResult;

  const reasonResult = normalizeOptionalString(params.reason, 'reason', MAX_REASON_LENGTH);
  if (!reasonResult.ok) return reasonResult;

  return {
    ok: true,
    value: {
      agentId: agentIdResult.value,
      dryRun: dryRunResult.value,
      reason: reasonResult.value,
    },
  };
}

function normalizeString(
  value: unknown,
  field: string,
  maxLength: number,
): Normalization<string> {
  if (typeof value !== 'string') return { ok: false, error: `${field} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, error: `${field} must not be empty` };
  if (trimmed.length > maxLength) return { ok: false, error: `${field} must be ${maxLength} characters or less` };
  return { ok: true, value: trimmed };
}

function normalizeOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
): Normalization<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  const result = normalizeString(value, field, maxLength);
  return result.ok ? result : result;
}

function normalizeBoolean(
  value: unknown,
  field: string,
  fallback: boolean,
): Normalization<boolean> {
  if (value === undefined || value === null) return { ok: true, value: fallback };
  if (typeof value !== 'boolean') return { ok: false, error: `${field} must be a boolean` };
  return { ok: true, value };
}
