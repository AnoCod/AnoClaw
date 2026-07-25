// UpdateOrgTool - reassign an agent to a new parent in the org tree
// Validates there are no circular references before reassigning.

import { Tool, RiskLevel, InterruptBehavior } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { AgentRole } from '../../../../shared/types/agent.js';
import { hierarchyValidationMessage } from '../../agent/AgentConstraints.js';

const MAX_AGENT_ID_CHARS = 200;

export class UpdateOrgTool extends Tool {

  static category = 'Agent Teams';
  static toolDescription = 'Changes durable reporting relationships in the organization roster.';
  name(): string {
    return 'UpdateOrg';
  }

  description(): string {
    return 'Reassign a durable employee to a new manager. MainAgent only. This changes the organization roster; TeamUpdate changes only the current session collaboration team.';
  }

  prompt(): string {
    return '## UpdateOrg Usage\n' +
      'Restructure your organization as the MainAgent. Move an agent to a different valid manager.\n\n' +
      '**When to use:** Reorganizing teams. An agent\'s skills better fit another department. A manager has too many or too few direct reports.\n\n' +
      '**Constraints:** Cannot move the CEO (MainAgent). Cannot create circular reporting chains. The new parent must exist.\n\n' +
      'Use ListEmployees first to see the current structure.';
  }

  minRole(): string { return 'MainAgent'; }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_AGENT_ID_CHARS,
          pattern: '\\S',
          description: 'ID of the agent to reassign',
        },
        newParentId: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_AGENT_ID_CHARS,
          pattern: '\\S',
          description: 'ID of the new parent agent in the org tree',
        },
      },
      required: ['agentId', 'newParentId'],
      additionalProperties: false,
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Medium;
  }

  interruptBehavior(): InterruptBehavior {
    return InterruptBehavior.Block;
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const agentResult = normalizeString(params.agentId, 'agentId', MAX_AGENT_ID_CHARS);
    if (agentResult.error) return this.makeError(agentResult.error);
    const agentId = agentResult.value!;

    const newParentResult = normalizeString(params.newParentId, 'newParentId', MAX_AGENT_ID_CHARS);
    if (newParentResult.error) return this.makeError(newParentResult.error);
    const newParentId = newParentResult.value!;

    const registry = AgentRegistry.getInstance();

    const caller = registry.findAgent(ctx.agentId);
    if (!caller || !caller.isActive || caller.role !== AgentRole.MainAgent) {
      return this.makeError(
        'Permission denied: only the active MainAgent can update the organization tree.',
        { structured: { agentId, newParentId, status: 'permission_denied', callerAgentId: ctx.agentId } },
      );
    }

    // Validate agent exists
    const agent = registry.findAgent(agentId);
    if (!agent) {
      return this.makeError(
        `Agent '${agentId}' not found in registry`,
        { structured: { agentId, newParentId, status: 'agent_not_found' } },
      );
    }

    // Cannot move the MainAgent
    if (agent.role === AgentRole.MainAgent) {
      return this.makeError(
        'Cannot reassign the MainAgent (CEO). The MainAgent must remain at the root of the org tree.',
        { structured: { agentId: agent.id, newParentId, status: 'root_immutable' } },
      );
    }

    // Validate new parent exists
    const newParent = registry.findAgent(newParentId);
    if (!newParent) {
      return this.makeError(
        `New parent agent '${newParentId}' not found in registry`,
        { structured: { agentId: agent.id, newParentId, status: 'parent_not_found' } },
      );
    }

    if (!newParent.isActive) {
      return this.makeError(
        `New parent agent '${newParentId}' is destroyed - cannot reassign under a destroyed agent`,
        { structured: { agentId: agent.id, newParentId: newParent.id, status: 'parent_destroyed' } },
      );
    }

    if (!newParent.isManagerRole()) {
      return this.makeError(
        `New parent agent '${newParent.name}' (${newParent.roleString}) cannot have subordinates. Choose a MainAgent or Manager.`,
        { structured: { agentId: agent.id, newParentId: newParent.id, status: 'parent_not_manager' } },
      );
    }

    // Moving to self would create an invalid self-reference.
    if (agent.id === newParent.id) {
      return this.makeError(
        'Cannot reassign an agent under itself.',
        { structured: { agentId: agent.id, newParentId: newParent.id, status: 'self_parent' } },
      );
    }

    // Moving to current parent is a no-op
    if (agent.parentAgentId === newParent.id) {
      const parentName = newParent.name;
      return this.makeResult(
        `No change: agent '${agent.name}' is already assigned to '${parentName}'.`,
        {
          structured: {
            agentId: agent.id,
            agentName: agent.name,
            oldParentId: agent.parentAgentId,
            newParentId: newParent.id,
            newParentName: newParent.name,
            status: 'unchanged',
          },
        },
      );
    }

    // Check for circular references: the new parent must not be a descendant
    // of the agent being moved (otherwise we'd create a cycle)
    if (this._isDescendantOf(newParent.id, agent.id, registry)) {
      return this.makeError(
        `Cannot reassign '${agent.name}' under '${newParent.name}': ` +
        `'${newParent.name}' is currently a subordinate of '${agent.name}'. ` +
        'This would create a circular reference in the org tree.',
        { structured: { agentId: agent.id, newParentId: newParent.id, status: 'circular_reference' } },
      );
    }

    const hierarchyError = hierarchyValidationMessage(agent.id, agent.role, newParent.id);
    if (hierarchyError) {
      return this.makeError(
        hierarchyError,
        { structured: { agentId: agent.id, newParentId: newParent.id, status: 'invalid_hierarchy' } },
      );
    }

    const oldParentId = agent.parentAgentId;
    const oldParentName = oldParentId
      ? (registry.agent(oldParentId)?.name ?? oldParentId)
      : '(none)';
    const oldLevel = agent.level;

    // Perform the reassignment using reassignParent
    // This preserves all runtime state: session statuses, event listeners, servingSessionCount.
    const newLevel = newParent.level + 1;
    agent.reassignParent(newParentId, newLevel);

    // Persist the updated config
    try {
      await registry.saveAgent(agentId);
    } catch (err) {
      // Rollback on persistence failure
      if (oldParentId) {
        agent.reassignParent(oldParentId, oldLevel);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return this.makeError(
        `Failed to persist org change: ${msg}`,
        {
          structured: {
            agentId: agent.id,
            oldParentId,
            newParentId: newParent.id,
            status: 'persist_failed',
            rolledBack: true,
          },
        },
      );
    }

    return this.makeResult(
      `Organization updated: '${agent.name}' reassigned from '${oldParentName}' to '${newParent.name}'.\n` +
      `New level: ${newLevel}`,
      {
        structured: {
          agentId: agent.id,
          agentName: agent.name,
          oldParentId,
          oldParentName,
          oldLevel,
          newParentId: newParent.id,
          newParentName: newParent.name,
          newLevel,
          status: 'updated',
        },
      },
    );
  }

  /**
   * Check whether `potentialAncestor` is an ancestor of `agentId` in the org tree.
   * Used to prevent circular references when reassigning.
   */
  private _isDescendantOf(
    potentialAncestor: string,
    agentId: string,
    registry: AgentRegistry,
  ): boolean {
    const children = registry.agentsByParent(agentId);
    for (const child of children) {
      if (child.id === potentialAncestor) return true;
      if (this._isDescendantOf(potentialAncestor, child.id, registry)) return true;
    }
    return false;
  }
}

function normalizeString(
  value: unknown,
  field: string,
  maxLength: number,
): { value: string; error?: undefined } | { value?: undefined; error: string } {
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { error: `${field} must not be empty` };
  if (trimmed.length > maxLength) {
    return { error: `${field} must be ${maxLength} characters or less` };
  }
  return { value: trimmed };
}
