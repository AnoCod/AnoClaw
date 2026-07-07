// UpdateOrgTool - reassign an agent to a new parent in the org tree
// Validates there are no circular references before reassigning.

import { Tool, RiskLevel, InterruptBehavior } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { AgentRole } from '../../../../shared/types/agent.js';

export class UpdateOrgTool extends Tool {

  static category = 'Organization Management';
  static toolDescription = 'Updates agent metadata, parent, or configuration in the org tree.';
  name(): string {
    return 'UpdateOrg';
  }

  description(): string {
    return 'Reassign an agent to a new parent in the organization hierarchy. Validates that the move does not create circular references. Cannot move the MainAgent.';
  }

  prompt(): string {
    return '## UpdateOrg Usage\n' +
      'Restructure your organization. Move an agent to a different manager.\n\n' +
      '**When to use:** Reorganizing teams. An agent\'s skills better fit another department. A manager has too many or too few direct reports.\n\n' +
      '**Constraints:** Cannot move the CEO (MainAgent). Cannot create circular reporting chains. The new parent must exist.\n\n' +
      'Use ListEmployees first to see the current structure.';
  }

  minRole(): string { return 'Manager'; }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'ID of the agent to reassign',
        },
        newParentId: {
          type: 'string',
          description: 'ID of the new parent agent in the org tree',
        },
      },
      required: ['agentId', 'newParentId'],
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
    _ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const agentId = params.agentId as string;
    const newParentId = params.newParentId as string;

    if (!agentId || !newParentId) {
      return this.makeError('Both agentId and newParentId are required.');
    }

    const registry = AgentRegistry.getInstance();

    // Validate agent exists
    const agent = registry.findAgent(agentId);
    if (!agent) {
      return this.makeError(`Agent '${agentId}' not found in registry`);
    }

    // Cannot move the MainAgent
    if (agent.role === AgentRole.MainAgent) {
      return this.makeError('Cannot reassign the MainAgent (CEO). The MainAgent must remain at the root of the org tree.');
    }

    // Validate new parent exists
    const newParent = registry.findAgent(newParentId);
    if (!newParent) {
      return this.makeError(`New parent agent '${newParentId}' not found in registry`);
    }

    if (!newParent.isActive) {
      return this.makeError(`New parent agent '${newParentId}' is destroyed - cannot reassign under a destroyed agent`);
    }

    // Moving to self is a no-op
    if (agentId === newParentId) {
      return this.makeResult('No change: agent is already assigned to itself (no-op).');
    }

    // Moving to current parent is a no-op
    if (agent.parentAgentId === newParentId) {
      const parentName = newParent.name;
      return this.makeResult(`No change: agent '${agent.name}' is already assigned to '${parentName}'.`);
    }

    // Check for circular references: the new parent must not be a descendant
    // of the agent being moved (otherwise we'd create a cycle)
    if (this._isDescendantOf(newParentId, agentId, registry)) {
      return this.makeError(
        `Cannot reassign '${agent.name}' under '${newParent.name}': ` +
        `'${newParent.name}' is currently a subordinate of '${agent.name}'. ` +
        'This would create a circular reference in the org tree.',
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
      return this.makeError(`Failed to persist org change: ${msg}`);
    }

    return this.makeResult(
      `Organization updated: '${agent.name}' reassigned from '${oldParentName}' to '${newParent.name}'.\n` +
      `New level: ${newLevel}`,
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
