import { describe, expect, it } from 'vitest';
import type { Agent, Mission } from '../../../../../shared/types/v3/index.js';
import type { AgentCapabilitySnapshot } from '../CapabilityMatcher.js';
import { OrchestrationPlanner } from '../OrchestrationPlanner.js';

describe('OrchestrationPlanner', () => {
  const mission: Mission = {
    id: 'mission-1',
    workId: 'work-1',
    title: 'Ship v3',
    objective: 'Deliver a verified change',
    acceptanceCriteria: ['The change is verified'],
    priority: 'high',
    verificationPolicy: {
      mode: 'automatic',
      requireDifferentAgent: false,
      maxRevisionAttempts: 2,
      requiredEvidence: [],
    },
    status: 'planned',
    ownerAgentId: 'owner',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('proposes direct execution when the owner passes every hard gate', () => {
    const result = new OrchestrationPlanner().propose({
      mission,
      ownerAgentId: 'owner',
      requirements: { requiredTools: ['write'] },
      candidates: [snapshot(agent('owner', ['write']))],
    });

    expect(result).toEqual({
      ok: true,
      proposal: expect.objectContaining({
        missionId: 'mission-1',
        strategy: 'direct',
        assignments: [
          expect.objectContaining({ agentId: 'owner' }),
        ],
      }),
    });
  });

  it('proposes one delegate when one non-owner covers the whole mission', () => {
    const result = new OrchestrationPlanner().propose({
      mission,
      ownerAgentId: 'owner',
      requirements: {
        requiredTools: ['write'],
        requiredSkills: ['typescript'],
      },
      candidates: [
        snapshot(agent('owner')),
        snapshot(agent('delegate', ['write'], ['typescript'])),
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.strategy).toBe('single_delegate');
    expect(result.proposal.assignments[0].agentId).toBe('delegate');
  });

  it('forms a team only when separate agents are needed for workstreams', () => {
    const result = new OrchestrationPlanner().propose({
      mission,
      ownerAgentId: 'owner',
      requirements: {},
      workstreams: [
        { id: 'implement', requirements: { requiredTools: ['write'] } },
        { id: 'verify', requirements: { requiredSkills: ['test'] } },
      ],
      candidates: [
        snapshot(agent('owner')),
        snapshot(agent('builder', ['write'])),
        snapshot(agent('reviewer', [], ['test'])),
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.strategy).toBe('team');
    expect(result.proposal.assignments).toEqual([
      expect.objectContaining({ agentId: 'builder', workstreamIds: ['implement'] }),
      expect.objectContaining({ agentId: 'reviewer', workstreamIds: ['verify'] }),
    ]);
  });

  it('reports an incomplete team without emitting a partial proposal', () => {
    const result = new OrchestrationPlanner().propose({
      mission,
      ownerAgentId: 'owner',
      requirements: {},
      workstreams: [
        { id: 'implement', requirements: { requiredTools: ['write'] } },
        { id: 'verify', requirements: { requiredSkills: ['test'] } },
      ],
      candidates: [snapshot(agent('builder', ['write']))],
    });

    expect(result).toEqual({
      ok: false,
      reason: 'incomplete_team',
      unmatchedWorkstreamIds: ['verify'],
    });
  });
});

function agent(id: string, allowedTools: string[] = [], enabledSkills: string[] = []): Agent {
  return {
    id,
    companyId: 'company-1',
    name: id,
    status: 'active',
    capabilities: [],
    enabledSkills,
    allowedTools,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function snapshot(value: Agent): AgentCapabilitySnapshot {
  return {
    agent: value,
    relevantMemoryKeys: [],
    successRate: 0.5,
    activeLoadRatio: 0,
    estimatedCost: 1,
    availableContextTokens: 8_000,
    teamIds: [],
    idleSince: '2026-01-01T00:00:00.000Z',
  };
}
