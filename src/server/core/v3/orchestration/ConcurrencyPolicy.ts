export const COMPANY_LOOP_LIMIT = 4;
export const MISSION_LOOP_LIMIT = 4;
export const AGENT_WRITE_LOOP_LIMIT = 1;
export const AGENT_READ_LOOP_LIMIT = 2;

export type LoopAccessMode = 'read' | 'write';

export interface LoopReservation {
  companyId: string;
  missionId: string;
  agentId: string;
  accessMode: LoopAccessMode;
}

export interface LoopStartRequest extends LoopReservation {}

export type ConcurrencyDenialCode =
  | 'company_limit_reached'
  | 'mission_limit_reached'
  | 'agent_write_exclusive'
  | 'agent_read_limit_reached';

export type ConcurrencyDecision =
  | { allowed: true }
  | {
    allowed: false;
    code: ConcurrencyDenialCode;
    limit: number;
    active: number;
  };

/**
 * Pure admission policy. Callers own reservations atomically; this class only
 * decides whether a supplied snapshot admits one additional AgentLoop.
 */
export class ConcurrencyPolicy {
  canStart(
    request: LoopStartRequest,
    activeLoops: readonly LoopReservation[],
  ): ConcurrencyDecision {
    const missionActive = activeLoops.filter(
      (loop) => loop.companyId === request.companyId
        && loop.missionId === request.missionId,
    ).length;
    if (missionActive >= MISSION_LOOP_LIMIT) {
      return {
        allowed: false,
        code: 'mission_limit_reached',
        limit: MISSION_LOOP_LIMIT,
        active: missionActive,
      };
    }

    const companyActive = activeLoops.filter(
      (loop) => loop.companyId === request.companyId,
    ).length;
    if (companyActive >= COMPANY_LOOP_LIMIT) {
      return {
        allowed: false,
        code: 'company_limit_reached',
        limit: COMPANY_LOOP_LIMIT,
        active: companyActive,
      };
    }

    const agentActive = activeLoops.filter(
      (loop) => loop.companyId === request.companyId
        && loop.agentId === request.agentId,
    );
    if (request.accessMode === 'write') {
      if (agentActive.length > 0) {
        return {
          allowed: false,
          code: 'agent_write_exclusive',
          limit: AGENT_WRITE_LOOP_LIMIT,
          active: agentActive.length,
        };
      }
      return { allowed: true };
    }

    if (agentActive.some((loop) => loop.accessMode === 'write')) {
      return {
        allowed: false,
        code: 'agent_write_exclusive',
        limit: AGENT_WRITE_LOOP_LIMIT,
        active: agentActive.length,
      };
    }
    if (agentActive.length >= AGENT_READ_LOOP_LIMIT) {
      return {
        allowed: false,
        code: 'agent_read_limit_reached',
        limit: AGENT_READ_LOOP_LIMIT,
        active: agentActive.length,
      };
    }
    return { allowed: true };
  }
}
