import type { Mission } from '../../../../shared/types/v3/index.js';
import {
  CapabilityMatcher,
  type AgentCapabilitySnapshot,
  type CapabilityRequirements,
  type RankedCapabilityCandidate,
} from './CapabilityMatcher.js';

export type OrchestrationStrategy = 'direct' | 'single_delegate' | 'team';

export interface PlanningWorkstream {
  id: string;
  requirements: CapabilityRequirements;
}

export interface OrchestrationPlanningRequest {
  mission: Mission;
  ownerAgentId: string;
  requirements: CapabilityRequirements;
  candidates: readonly AgentCapabilitySnapshot[];
  workstreams?: readonly PlanningWorkstream[];
}

export interface ProposedAssignment {
  agentId: string;
  workstreamIds: string[];
  score: number;
}

export interface OrchestrationProposal {
  missionId: string;
  strategy: OrchestrationStrategy;
  assignments: ProposedAssignment[];
  rationale: string;
}

export type OrchestrationPlanningResult =
  | { ok: true; proposal: OrchestrationProposal }
  | {
    ok: false;
    reason: 'no_capable_agent' | 'incomplete_team';
    unmatchedWorkstreamIds: string[];
  };

export class OrchestrationPlanner {
  constructor(private readonly matcher = new CapabilityMatcher()) {}

  propose(request: OrchestrationPlanningRequest): OrchestrationPlanningResult {
    const workstreams = request.workstreams ?? [];
    const combinedRequirements = combineRequirements(
      request.requirements,
      workstreams.map((workstream) => workstream.requirements),
    );
    const combinedMatch = this.matcher.match(combinedRequirements, request.candidates);
    const owner = combinedMatch.ranked.find(
      (candidate) => candidate.agent.id === request.ownerAgentId,
    );
    if (owner) {
      return {
        ok: true,
        proposal: {
          missionId: request.mission.id,
          strategy: 'direct',
          assignments: [{
            agentId: owner.agent.id,
            workstreamIds: workstreams.map((workstream) => workstream.id),
            score: owner.score,
          }],
          rationale: 'The mission owner satisfies all hard requirements.',
        },
      };
    }

    const singleDelegate = combinedMatch.ranked[0];
    if (singleDelegate) {
      return {
        ok: true,
        proposal: {
          missionId: request.mission.id,
          strategy: 'single_delegate',
          assignments: [{
            agentId: singleDelegate.agent.id,
            workstreamIds: workstreams.map((workstream) => workstream.id),
            score: singleDelegate.score,
          }],
          rationale: 'One delegate satisfies all hard requirements.',
        },
      };
    }

    if (workstreams.length === 0) {
      return {
        ok: false,
        reason: 'no_capable_agent',
        unmatchedWorkstreamIds: [],
      };
    }

    const selections: Array<{ workstreamId: string; candidate: RankedCapabilityCandidate }> = [];
    const unmatchedWorkstreamIds: string[] = [];
    for (const workstream of workstreams) {
      const requirements = combineRequirements(request.requirements, [workstream.requirements]);
      const candidate = this.matcher.match(requirements, request.candidates).ranked[0];
      if (!candidate) unmatchedWorkstreamIds.push(workstream.id);
      else selections.push({ workstreamId: workstream.id, candidate });
    }
    if (unmatchedWorkstreamIds.length > 0) {
      return {
        ok: false,
        reason: 'incomplete_team',
        unmatchedWorkstreamIds,
      };
    }

    const assignments = groupAssignments(selections);
    const strategy: OrchestrationStrategy = assignments.length > 1
      ? 'team'
      : assignments[0]?.agentId === request.ownerAgentId
        ? 'direct'
        : 'single_delegate';
    return {
      ok: true,
      proposal: {
        missionId: request.mission.id,
        strategy,
        assignments,
        rationale: strategy === 'team'
          ? 'No single agent covers the mission; a capability-complete team does.'
          : 'One agent covers every independently matched workstream.',
      },
    };
  }
}

function combineRequirements(
  base: CapabilityRequirements,
  additions: readonly CapabilityRequirements[],
): CapabilityRequirements {
  const all = [base, ...additions];
  const preferredTeamIds = unique(all.map((item) => item.preferredTeamId).filter(isString));
  return {
    requiredTools: unique(all.flatMap((item) => item.requiredTools ?? [])),
    requiredSkills: unique(all.flatMap((item) => item.requiredSkills ?? [])),
    responsibilities: unique(all.flatMap((item) => item.responsibilities ?? [])),
    relevantMemoryKeys: unique(all.flatMap((item) => item.relevantMemoryKeys ?? [])),
    expectedContextTokens: Math.max(
      0,
      ...all.map((item) => item.expectedContextTokens ?? 0),
    ),
    preferredTeamId: preferredTeamIds.length === 1 ? preferredTeamIds[0] : undefined,
  };
}

function groupAssignments(
  selections: ReadonlyArray<{ workstreamId: string; candidate: RankedCapabilityCandidate }>,
): ProposedAssignment[] {
  const byAgent = new Map<string, ProposedAssignment>();
  for (const selection of selections) {
    const agentId = selection.candidate.agent.id;
    const existing = byAgent.get(agentId);
    if (existing) {
      existing.workstreamIds.push(selection.workstreamId);
      existing.score = Math.max(existing.score, selection.candidate.score);
    } else {
      byAgent.set(agentId, {
        agentId,
        workstreamIds: [selection.workstreamId],
        score: selection.candidate.score,
      });
    }
  }
  return [...byAgent.values()].sort(
    (left, right) => left.workstreamIds[0].localeCompare(right.workstreamIds[0])
      || left.agentId.localeCompare(right.agentId),
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string';
}
