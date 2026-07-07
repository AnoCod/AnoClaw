import { AgentRegistry } from './AgentRegistry.js';
import type { AgentConfig } from '../../../shared/types/agent.js';
import { AgentRole } from '../../../shared/types/agent.js';

export function hasMainAgentConflict(candidateId: string, candidateRole: unknown): boolean {
  if (candidateRole !== AgentRole.MainAgent && candidateRole !== 'MainAgent') {
    return false;
  }

  const existingMain = AgentRegistry.getInstance().mainAgent();
  return !!existingMain && existingMain.id !== candidateId;
}

export function levelForRole(role: AgentRole | string): number {
  const roleName = String(role);
  if (roleName === AgentRole.MainAgent) return 0;
  if (roleName === AgentRole.Manager) return 1;
  return 2;
}

export function hierarchyValidationMessage(
  candidateId: string,
  candidateRole: AgentRole | string,
  parentAgentId: string | null | undefined,
): string | null {
  const registry = AgentRegistry.getInstance();
  const roleName = String(candidateRole);

  if (roleName === AgentRole.SubAgent) {
    return 'SubAgent is temporary and cannot be saved in the persistent organization tree.';
  }

  if (roleName === AgentRole.MainAgent) {
    if (parentAgentId) {
      return 'CEO/MainAgent must be the root agent and cannot have a parent.';
    }
    return null;
  }

  if (!parentAgentId) {
    return `${candidateRole} requires a parent agent. Managers report to the CEO; Members report to a Manager.`;
  }

  if (parentAgentId === candidateId) {
    return 'An agent cannot report to itself.';
  }

  const parent = registry.agent(parentAgentId);
  if (!parent) {
    return `Parent agent '${parentAgentId}' is not configured.`;
  }

  if (roleName === AgentRole.Manager) {
    if (parent.role !== AgentRole.MainAgent) {
      return `Manager agents must report directly to the CEO/MainAgent. '${parent.name}' is ${parent.role}.`;
    }
    return null;
  }

  if (roleName === AgentRole.Member) {
    if (parent.role !== AgentRole.Manager) {
      return `Member agents must report to a Manager. '${parent.name}' is ${parent.role}.`;
    }
    return null;
  }

  return `Unsupported agent role: ${String(candidateRole)}`;
}

export function normalizeAgentHierarchy<T extends Partial<AgentConfig>>(config: T): T {
  const role = String(config.role || AgentRole.Member);
  const normalized = { ...config };
  normalized.level = levelForRole(role);
  if (role === AgentRole.MainAgent) {
    normalized.parentAgentId = null;
  }
  return normalized;
}
