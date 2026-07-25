import type { Agent } from '../../../../shared/types/v3/index.js';

export interface CapabilityRequirements {
  requiredTools?: readonly string[];
  requiredSkills?: readonly string[];
  responsibilities?: readonly string[];
  relevantMemoryKeys?: readonly string[];
  expectedContextTokens?: number;
  preferredTeamId?: string;
}

/**
 * Runtime evidence intentionally kept outside the durable Agent model. These
 * values are snapshots supplied by telemetry, memory search, and membership
 * projections when an orchestration decision is made.
 */
export interface AgentCapabilitySnapshot {
  agent: Agent;
  relevantMemoryKeys: readonly string[];
  successRate: number;
  activeLoadRatio: number;
  estimatedCost: number;
  availableContextTokens: number;
  teamIds: readonly string[];
  idleSince: string;
}

export interface CapabilityScoreWeights {
  responsibility: number;
  relevantMemory: number;
  successRate: number;
  load: number;
  cost: number;
  context: number;
  teamAffinity: number;
}

export interface CapabilityScoreComponents {
  responsibility: number;
  relevantMemory: number;
  successRate: number;
  load: number;
  cost: number;
  context: number;
  teamAffinity: number;
}

export interface RankedCapabilityCandidate {
  agent: Agent;
  snapshot: AgentCapabilitySnapshot;
  score: number;
  components: CapabilityScoreComponents;
}

export type CapabilityRejectionReason =
  | 'agent_inactive'
  | 'missing_required_tool'
  | 'missing_required_skill';

export interface RejectedCapabilityCandidate {
  agentId: string;
  reasons: CapabilityRejectionReason[];
  missingTools: string[];
  missingSkills: string[];
}

export interface CapabilityMatchResult {
  ranked: RankedCapabilityCandidate[];
  rejected: RejectedCapabilityCandidate[];
}

export const DEFAULT_CAPABILITY_SCORE_WEIGHTS: Readonly<CapabilityScoreWeights> = {
  responsibility: 0.25,
  relevantMemory: 0.15,
  successRate: 0.2,
  load: 0.15,
  cost: 0.1,
  context: 0.1,
  teamAffinity: 0.05,
};

export class CapabilityMatcher {
  private readonly weights: CapabilityScoreWeights;
  private readonly totalWeight: number;

  constructor(weights: CapabilityScoreWeights = DEFAULT_CAPABILITY_SCORE_WEIGHTS) {
    const values = Object.values(weights);
    if (values.some((value) => !Number.isFinite(value) || value < 0)) {
      throw new Error('Capability score weights must be finite, non-negative numbers.');
    }
    const totalWeight = values.reduce((total, value) => total + value, 0);
    if (totalWeight <= 0) {
      throw new Error('At least one capability score weight must be positive.');
    }
    this.weights = { ...weights };
    this.totalWeight = totalWeight;
  }

  match(
    requirements: CapabilityRequirements,
    candidates: readonly AgentCapabilitySnapshot[],
  ): CapabilityMatchResult {
    const requiredTools = unique(requirements.requiredTools);
    const requiredSkills = unique(requirements.requiredSkills);
    const eligible: AgentCapabilitySnapshot[] = [];
    const rejected: RejectedCapabilityCandidate[] = [];

    for (const snapshot of candidates) {
      const missingTools = requiredTools.filter(
        (tool) => !snapshot.agent.allowedTools.includes(tool),
      );
      const missingSkills = requiredSkills.filter(
        (skill) => !snapshot.agent.enabledSkills.includes(skill),
      );
      const reasons: CapabilityRejectionReason[] = [];
      if (snapshot.agent.status !== 'active') reasons.push('agent_inactive');
      if (missingTools.length > 0) reasons.push('missing_required_tool');
      if (missingSkills.length > 0) reasons.push('missing_required_skill');

      if (reasons.length > 0) {
        rejected.push({
          agentId: snapshot.agent.id,
          reasons,
          missingTools,
          missingSkills,
        });
      } else {
        eligible.push(snapshot);
      }
    }

    const costs = eligible.map((candidate) => nonNegative(candidate.estimatedCost));
    const minimumCost = costs.length > 0 ? Math.min(...costs) : 0;
    const maximumCost = costs.length > 0 ? Math.max(...costs) : 0;
    const ranked = eligible.map((snapshot): RankedCapabilityCandidate => {
      const components: CapabilityScoreComponents = {
        responsibility: coverage(
          requirements.responsibilities,
          snapshot.agent.capabilities,
        ),
        relevantMemory: coverage(
          requirements.relevantMemoryKeys,
          snapshot.relevantMemoryKeys,
        ),
        successRate: clampUnit(snapshot.successRate),
        load: 1 - clampUnit(snapshot.activeLoadRatio),
        cost: costScore(nonNegative(snapshot.estimatedCost), minimumCost, maximumCost),
        context: contextScore(
          requirements.expectedContextTokens,
          snapshot.availableContextTokens,
        ),
        teamAffinity: requirements.preferredTeamId
          ? Number(snapshot.teamIds.includes(requirements.preferredTeamId))
          : 1,
      };
      const weightedScore = (
        components.responsibility * this.weights.responsibility
        + components.relevantMemory * this.weights.relevantMemory
        + components.successRate * this.weights.successRate
        + components.load * this.weights.load
        + components.cost * this.weights.cost
        + components.context * this.weights.context
        + components.teamAffinity * this.weights.teamAffinity
      ) / this.totalWeight;
      return {
        agent: snapshot.agent,
        snapshot,
        score: roundScore(weightedScore * 100),
        components,
      };
    });

    ranked.sort(compareRankedCandidates);
    rejected.sort((left, right) => left.agentId.localeCompare(right.agentId));
    return { ranked, rejected };
  }
}

function compareRankedCandidates(
  left: RankedCapabilityCandidate,
  right: RankedCapabilityCandidate,
): number {
  const scoreDifference = right.score - left.score;
  if (Math.abs(scoreDifference) > Number.EPSILON) return scoreDifference;

  // An older idle timestamp means the agent has waited longer. Agent id is a
  // final stable key when telemetry timestamps are equal or invalid.
  const idleDifference = idleTimestamp(left.snapshot.idleSince)
    - idleTimestamp(right.snapshot.idleSince);
  return idleDifference || left.agent.id.localeCompare(right.agent.id);
}

function coverage(required: readonly string[] | undefined, available: readonly string[]): number {
  const requiredValues = unique(required);
  if (requiredValues.length === 0) return 1;
  const availableValues = new Set(available);
  const covered = requiredValues.filter((value) => availableValues.has(value)).length;
  return covered / requiredValues.length;
}

function contextScore(expected: number | undefined, available: number): number {
  if (expected == null || expected <= 0) return 1;
  return clampUnit(nonNegative(available) / expected);
}

function costScore(cost: number, minimum: number, maximum: number): number {
  if (maximum <= minimum) return 1;
  return clampUnit((maximum - cost) / (maximum - minimum));
}

function idleTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function unique(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value) => value.length > 0))];
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : Number.MAX_SAFE_INTEGER;
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
