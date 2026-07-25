import { describe, expect, it } from 'vitest';
import type { Agent } from '../../../../../shared/types/v3/index.js';
import {
  CapabilityMatcher,
  type AgentCapabilitySnapshot,
} from '../CapabilityMatcher.js';

describe('CapabilityMatcher', () => {
  it('hard-gates required tools and skills before scoring', () => {
    const matcher = new CapabilityMatcher();
    const result = matcher.match({
      requiredTools: ['write_file'],
      requiredSkills: ['typescript'],
    }, [
      snapshot(agent('capable', ['write_file'], ['typescript'])),
      snapshot(agent('missing-tool', [], ['typescript'])),
      snapshot(agent('missing-skill', ['write_file'], [])),
      snapshot({ ...agent('paused', ['write_file'], ['typescript']), status: 'paused' }),
    ]);

    expect(result.ranked.map((candidate) => candidate.agent.id)).toEqual(['capable']);
    expect(result.rejected).toEqual([
      expect.objectContaining({
        agentId: 'missing-skill',
        reasons: ['missing_required_skill'],
        missingSkills: ['typescript'],
      }),
      expect.objectContaining({
        agentId: 'missing-tool',
        reasons: ['missing_required_tool'],
        missingTools: ['write_file'],
      }),
      expect.objectContaining({
        agentId: 'paused',
        reasons: ['agent_inactive'],
      }),
    ]);
  });

  it('scores all soft evidence dimensions', () => {
    const matcher = new CapabilityMatcher();
    const preferred = snapshot(
      agent('preferred', ['read'], ['analysis'], ['review']),
      {
        relevantMemoryKeys: ['project-alpha'],
        successRate: 0.9,
        activeLoadRatio: 0.1,
        estimatedCost: 2,
        availableContextTokens: 16_000,
        teamIds: ['team-a'],
      },
    );
    const weaker = snapshot(
      agent('weaker', ['read'], ['analysis'], []),
      {
        relevantMemoryKeys: [],
        successRate: 0.4,
        activeLoadRatio: 0.8,
        estimatedCost: 8,
        availableContextTokens: 2_000,
        teamIds: [],
      },
    );
    const result = matcher.match({
      requiredTools: ['read'],
      requiredSkills: ['analysis'],
      responsibilities: ['review'],
      relevantMemoryKeys: ['project-alpha'],
      expectedContextTokens: 8_000,
      preferredTeamId: 'team-a',
    }, [weaker, preferred]);

    expect(result.ranked.map((candidate) => candidate.agent.id))
      .toEqual(['preferred', 'weaker']);
    expect(result.ranked[0].components).toEqual({
      responsibility: 1,
      relevantMemory: 1,
      successRate: 0.9,
      load: 0.9,
      cost: 1,
      context: 1,
      teamAffinity: 1,
    });
    expect(result.ranked[1].components.context).toBe(0.25);
    expect(result.ranked[0].score).toBeGreaterThan(result.ranked[1].score);
  });

  it('breaks score ties by longest idle, then stable agent id', () => {
    const matcher = new CapabilityMatcher();
    const oldest = snapshot(agent('z-oldest'), {
      idleSince: '2026-01-01T00:00:00.000Z',
    });
    const tiedB = snapshot(agent('b-tied'), {
      idleSince: '2026-01-02T00:00:00.000Z',
    });
    const tiedA = snapshot(agent('a-tied'), {
      idleSince: '2026-01-02T00:00:00.000Z',
    });

    expect(matcher.match({}, [tiedB, oldest, tiedA]).ranked.map(
      (candidate) => candidate.agent.id,
    )).toEqual(['z-oldest', 'a-tied', 'b-tied']);
  });
});

function agent(
  id: string,
  allowedTools: string[] = [],
  enabledSkills: string[] = [],
  capabilities: string[] = [],
): Agent {
  return {
    id,
    companyId: 'company-1',
    name: id,
    status: 'active',
    capabilities,
    enabledSkills,
    allowedTools,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function snapshot(
  value: Agent,
  overrides: Partial<AgentCapabilitySnapshot> = {},
): AgentCapabilitySnapshot {
  return {
    agent: value,
    relevantMemoryKeys: [],
    successRate: 0.5,
    activeLoadRatio: 0.5,
    estimatedCost: 1,
    availableContextTokens: 8_000,
    teamIds: [],
    idleSince: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}
