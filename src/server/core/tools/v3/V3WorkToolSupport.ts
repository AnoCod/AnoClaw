import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import type {
  Agent,
  CompanyProjection,
  Task,
  TeamMembership,
  WorkProjection,
} from '../../../../shared/types/v3/index.js';
import { V3DomainError } from '../../v3/domain/DomainError.js';
import {
  CompanyRepository,
  SessionTranscriptRepository,
  WorkRepository,
} from '../../v3/store/index.js';
import {
  V3ToolExecutionRegistry,
  type V3ToolExecutionContext,
} from '../../v3/runtime/V3ToolExecutionRegistry.js';
import { makeError } from '../ToolResult.js';

export interface V3WorkToolDependencies {
  workRepository: WorkRepository;
  companyRepository: CompanyRepository;
  transcriptRepository: SessionTranscriptRepository;
  stopTask?: (workId: string, taskId: string, reason: string) => Promise<void>;
  wakeSafeTurnBoundary?: (sessionId: string) => void;
  clock?: () => string;
  idFactory?: () => string;
}

export class V3WorkToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'V3WorkToolError';
  }
}

let configuredDependencies: V3WorkToolDependencies | null = null;

/**
 * Main startup may bind the scheduler-owned repositories and stop cascade.
 * Tests can instead inject dependencies into individual tool constructors.
 */
export function configureV3WorkToolDependencies(
  dependencies: V3WorkToolDependencies | null,
): void {
  configuredDependencies = dependencies;
}

export function v3WorkToolDependencies(
  override?: V3WorkToolDependencies,
): V3WorkToolDependencies {
  if (override) return override;
  if (!configuredDependencies) {
    const rootDir = path.resolve('data', 'v3');
    configuredDependencies = {
      workRepository: new WorkRepository(rootDir),
      companyRepository: new CompanyRepository(rootDir),
      transcriptRepository: new SessionTranscriptRepository(rootDir),
    };
  }
  return configuredDependencies;
}

export function requireV3ExecutionContext(
  ctx: ExecutionContext,
): V3ToolExecutionContext {
  const context = V3ToolExecutionRegistry.getInstance().get(ctx.sessionId);
  if (!context) {
    throw new V3WorkToolError(
      'v3_context_required',
      'This tool is available only inside a persistent AnoClaw v3 Work execution.',
      { sessionId: ctx.sessionId },
    );
  }
  if (!context.companyId || !context.teamId || !context.workId) {
    throw new V3WorkToolError(
      'v3_identity_incomplete',
      'The server-owned v3 execution identity is missing company, Team, or Work scope.',
      { sessionId: ctx.sessionId },
    );
  }
  return context;
}

export async function requireScopedState(
  dependencies: V3WorkToolDependencies,
  ctx: ExecutionContext,
): Promise<{
  context: V3ToolExecutionContext & { companyId: string; teamId: string };
  company: CompanyProjection;
  work: WorkProjection;
  caller: Agent;
  callerMembership: TeamMembership;
}> {
  const context = requireV3ExecutionContext(ctx) as V3ToolExecutionContext & {
    companyId: string;
    teamId: string;
  };
  const [company, work] = await Promise.all([
    dependencies.companyRepository.getProjection(),
    dependencies.workRepository.getProjection(context.workId),
  ]);
  if (!company.company || company.company.id !== context.companyId) {
    throw new V3WorkToolError('company_not_found', 'The execution Company no longer exists.');
  }
  if (!work.work || work.work.companyId !== context.companyId) {
    throw new V3WorkToolError(
      'work_not_found',
      `Work not found in this execution scope: ${context.workId}`,
    );
  }
  const team = company.teams[context.teamId];
  if (!team || team.archivedAt) {
    throw new V3WorkToolError(
      'team_not_found',
      `Active Team not found in this execution scope: ${context.teamId}`,
    );
  }
  const caller = company.agents[context.agentId];
  if (!caller || caller.status !== 'active') {
    throw new V3WorkToolError(
      'agent_not_active',
      `The executing Agent is not active: ${context.agentId}`,
    );
  }
  const callerMembership = activeMembership(company, context.teamId, context.agentId);
  if (!callerMembership) {
    throw new V3WorkToolError(
      'team_membership_required',
      `Agent ${context.agentId} is not an active member of Team ${context.teamId}.`,
    );
  }
  return { context, company, work, caller, callerMembership };
}

export function activeMembership(
  company: CompanyProjection,
  teamId: string,
  agentId: string,
): TeamMembership | undefined {
  return Object.values(company.memberships).find((membership) => (
    membership.teamId === teamId
    && membership.agentId === agentId
    && !membership.removedAt
  ));
}

export function activeTeamMembers(
  company: CompanyProjection,
  teamId: string,
): TeamMembership[] {
  return Object.values(company.memberships).filter((membership) => (
    membership.teamId === teamId && !membership.removedAt
  ));
}

export function assertCanCoordinate(
  company: CompanyProjection,
  teamId: string,
  agentId: string,
): void {
  if (company.company?.mainAgentId === agentId) return;
  const membership = activeMembership(company, teamId, agentId);
  if (membership?.role !== 'leader') {
    throw new V3WorkToolError(
      'forbidden',
      'Only MainAgent or a leader of the responsible Team may coordinate this task.',
      { teamId, agentId },
    );
  }
}

export function assertTaskInTeam(
  task: Task,
  teamId: string,
  company?: CompanyProjection,
  agentId?: string,
): void {
  if (
    task.teamId !== teamId
    && (!company?.company || company.company.mainAgentId !== agentId)
  ) {
    throw new V3WorkToolError(
      'task_outside_team',
      `Task ${task.id} does not belong to the executing Team.`,
      { taskId: task.id, expectedTeamId: teamId, actualTeamId: task.teamId },
    );
  }
}

export function responsibleTaskTeamId(task: Task, fallbackTeamId: string): string {
  return task.teamId ?? fallbackTeamId;
}

export function isCompanyMainAgent(
  company: CompanyProjection,
  agentId: string,
): boolean {
  return company.company?.mainAgentId === agentId;
}

export function assertTaskVersion(task: Task, expectedVersion: number | undefined): void {
  if (expectedVersion !== undefined && task.version !== expectedVersion) {
    throw new V3WorkToolError(
      'version_conflict',
      `Expected Task version ${expectedVersion}, current version is ${task.version}.`,
      { taskId: task.id, expectedVersion, currentVersion: task.version },
    );
  }
}

export async function withWorkRevisionRetry<T>(
  dependencies: V3WorkToolDependencies,
  workId: string,
  agentId: string,
  operation: (projection: WorkProjection) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const projection = await dependencies.workRepository.getProjection(workId);
    try {
      return await operation(projection);
    } catch (error) {
      lastError = error;
      if (!(error instanceof V3DomainError) || error.code !== 'REVISION_CONFLICT') {
        throw error;
      }
    }
  }
  throw lastError ?? new V3WorkToolError(
    'revision_conflict',
    `Work ${workId} changed too quickly to complete the operation.`,
    { agentId },
  );
}

export function appendCommand(
  projection: WorkProjection,
  agentId: string,
  correlationId?: string,
) {
  return {
    expectedRevision: projection.revision,
    eventId: randomUUID(),
    actor: { type: 'agent' as const, id: agentId },
    ...(correlationId ? { correlationId } : {}),
  };
}

export function workToolFailure(error: unknown): ToolResult {
  if (error instanceof V3WorkToolError) {
    return makeError(`${error.code}: ${error.message}`, {
      structured: {
        status: 'error',
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
    });
  }
  if (error instanceof V3DomainError) {
    const code = error.code.toLowerCase();
    return makeError(`${code}: ${error.message}`, {
      structured: {
        status: 'error',
        error: {
          code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return makeError(`unexpected_error: ${message}`, {
    structured: {
      status: 'error',
      error: { code: 'unexpected_error', message },
    },
  });
}

export function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new V3WorkToolError('validation_failed', `${field} is required.`, { field });
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new V3WorkToolError(
      'validation_failed',
      `${field} must be ${maxLength} characters or fewer.`,
      { field, maxLength },
    );
  }
  return normalized;
}

export function optionalText(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredText(value, field, maxLength);
}

export function optionalInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new V3WorkToolError(
      'validation_failed',
      `${field} must be an integer between ${minimum} and ${maximum}.`,
      { field, minimum, maximum },
    );
  }
  return value as number;
}

export function stringList(
  value: unknown,
  field: string,
  options: { required?: boolean; maxItems: number; maxLength: number },
): string[] | undefined {
  if (value === undefined || value === null) {
    if (options.required) {
      throw new V3WorkToolError('validation_failed', `${field} is required.`, { field });
    }
    return undefined;
  }
  if (!Array.isArray(value) || (options.required && value.length === 0)) {
    throw new V3WorkToolError(
      'validation_failed',
      `${field} must be a${options.required ? ' non-empty' : 'n'} array.`,
      { field },
    );
  }
  if (value.length > options.maxItems) {
    throw new V3WorkToolError(
      'validation_failed',
      `${field} must contain ${options.maxItems} items or fewer.`,
      { field, maxItems: options.maxItems },
    );
  }
  return [...new Set(value.map((entry, index) => {
    try {
      return requiredText(entry, `${field}[${index}]`, options.maxLength);
    } catch (error) {
      throw error;
    }
  }))];
}

export function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new V3WorkToolError('validation_failed', 'Expected a boolean value.');
  }
  return value;
}

export function now(dependencies: V3WorkToolDependencies): string {
  return dependencies.clock?.() ?? new Date().toISOString();
}

export function nextId(dependencies: V3WorkToolDependencies): string {
  return dependencies.idFactory?.() ?? randomUUID();
}
