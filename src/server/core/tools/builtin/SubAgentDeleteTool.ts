// SubAgentDeleteTool - destroy a temporary SubAgent
// Only works on SubAgents (role === SubAgent). Does NOT destroy Managers/Members.
// Unregisters the agent from AgentRegistry.

import { Tool, RiskLevel, InterruptBehavior } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { AgentRole, AgentState } from '../../../../shared/types/agent.js';

export class SubAgentDeleteTool extends Tool {

  static category = 'Task Delegation';
  static toolDescription = 'Removes a previously spawned sub-agent and its session.';
  name(): string {
    return 'SubAgentDelete';
  }

  description(): string {
    return 'Destroy a temporary SubAgent. Only works on SubAgents (not Managers or Members). The SubAgent is unregistered and its resources are freed.';
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
          description: 'ID of the SubAgent to destroy',
        },
      },
      required: ['agentId'],
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
    const agentId = params.agentId as string;

    const registry = AgentRegistry.getInstance();
    const agent = registry.agent(agentId);

    if (!agent) {
      return this.makeError(`Agent '${agentId}' not found in registry`);
    }

    // Only allow deletion of SubAgents
    if (agent.role !== AgentRole.SubAgent) {
      return this.makeError(
        `Cannot delete '${agent.name}': role is '${agent.role}'. ` +
        'Only SubAgents can be deleted with this tool. ' +
        'Use the admin interface to destroy Managers or Members.',
      );
    }

    if (!agent.isActive) {
      return this.makeResult(
        `Agent '${agent.name}' (${agentId}) was already destroyed.`,
      );
    }

    // Mark as destroyed
    agent.setState(AgentState.Destroyed);

    // Unregister from registry
    registry.unregisterAgent(agentId);

    return this.makeResult(
      `SubAgent '${agent.name}' (${agentId}) destroyed successfully.`,
    );
  }
}
