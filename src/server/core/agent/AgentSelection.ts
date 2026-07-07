import { AgentRegistry } from './AgentRegistry.js';
import type { Agent } from './Agent.js';

export interface AgentSelection {
  ok: boolean;
  agentId?: string;
  message?: string;
}

function runnableProblem(agent: Agent): string | null {
  if (!agent.isActive) {
    return `Agent '${agent.id}' is not active. Open Agents and reactivate or replace it before starting a session.`;
  }
  if (!agent.provider || !agent.provider.trim()) {
    return `Agent '${agent.name}' is missing a provider. Open Agents and configure its model connection.`;
  }
  if (!agent.modelName || !agent.modelName.trim()) {
    return `Agent '${agent.name}' is missing a model. Open Agents and configure its model connection.`;
  }
  if (!agent.apiUrl || !agent.apiUrl.trim()) {
    return `Agent '${agent.name}' is missing an API URL. Open Agents and configure its model connection.`;
  }
  return null;
}

export function selectRunnableAgent(requestedAgentId?: string): AgentSelection {
  const registry = AgentRegistry.getInstance();
  const requested = (requestedAgentId || '').trim();

  if (requested) {
    const agent = registry.agent(requested);
    if (!agent) {
      return {
        ok: false,
        message: `Agent '${requested}' is not configured. Open Agents and create or select a valid agent before starting a session.`,
      };
    }
    const problem = runnableProblem(agent);
    if (problem) {
      return { ok: false, message: problem };
    }
    return { ok: true, agentId: agent.id };
  }

  const mainAgent = registry.mainAgent();
  if (mainAgent && !runnableProblem(mainAgent)) return { ok: true, agentId: mainAgent.id };

  const fallback = registry.allAgents().find((agent) => !runnableProblem(agent));
  if (fallback) return { ok: true, agentId: fallback.id };

  const anyAgent = registry.allAgents()[0];
  if (anyAgent) {
    return {
      ok: false,
      message: runnableProblem(anyAgent) || 'No runnable agent is configured. Open Agents and configure a model connection before starting a session.',
    };
  }

  return {
    ok: false,
    message: 'No agents are configured. Open Agents, create a CEO/MainAgent, and configure its model connection before starting a session.',
  };
}
