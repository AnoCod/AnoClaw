import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CoordinationTaskPriority, CoordinationTaskStatus } from '../../../shared/types/coordination.js';
import { AgentRegistry } from '../../core/agent/AgentRegistry.js';
import { InterruptController, InterruptReason } from '../../core/agent/supervision/InterruptController.js';
import { CoordinationError } from '../../core/coordination/CoordinationError.js';
import { CoordinationService } from '../../core/coordination/CoordinationService.js';
import { SessionManager } from '../../core/session/SessionManager.js';
import type { ApiToken } from '../ApiAuth.js';
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import { readBody, sendJson } from '../RouteHelpers.js';

abstract class CoordinationRoute implements RouteHandler {
  abstract method: RouteHandler['method'];
  abstract path: string;
  abstract description: string;
  category = 'Coordination';
  abstract permission: string;
  abstract execute(match: RouteMatch, req: IncomingMessage): Promise<unknown>;

  async handle(match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    try {
      sendJson(res, 200, await this.execute(match, req));
    } catch (error) {
      const status = statusFor(error);
      sendJson(res, status, {
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof CoordinationError ? error.code : 'internal_error',
      });
    }
    return true;
  }
}

export class ListTeamsRoute extends CoordinationRoute {
  method = 'GET' as const;
  path = '/api/v1/sessions/:rootSessionId/teams';
  description = 'List teams and the current coordination revision for a root session';
  permission = 'sessions:read';
  async execute(match: RouteMatch): Promise<unknown> {
    const rootSessionId = requireRoot(match.params.rootSessionId);
    const snapshot = CoordinationService.getInstance().getSnapshot(rootSessionId);
    return { rootSessionId, revision: snapshot.revision, teams: snapshot.teams };
  }
}

export class CreateTeamRoute extends CoordinationRoute {
  method = 'POST' as const;
  path = '/api/v1/sessions/:rootSessionId/teams';
  description = 'Create the root session active collaboration team';
  permission = 'sessions:write';
  async execute(match: RouteMatch, req: IncomingMessage): Promise<unknown> {
    const rootSessionId = requireRoot(match.params.rootSessionId);
    const body = await readBody(req);
    const leaderAgentId = text(body.leaderAgentId) || rootAgentId(rootSessionId);
    const members = strings(body.memberAgentIds);
    for (const agentId of [leaderAgentId, ...members]) requireActiveAgent(agentId);
    const team = await CoordinationService.getInstance().createTeam({
      rootSessionId,
      name: required(body.name, 'name'),
      purpose: required(body.purpose, 'purpose'),
      leaderAgentId,
      memberAgentIds: members,
      createdByAgentId: rootAgentId(rootSessionId),
      autoDisband: body.autoDisband !== false,
      idempotencyKey: header(req, 'idempotency-key'),
    });
    return { team };
  }
}

export class GetTeamRoute extends CoordinationRoute {
  method = 'GET' as const;
  path = '/api/v1/teams/:teamId';
  description = 'Get one collaboration team';
  permission = 'sessions:read';
  async execute(match: RouteMatch): Promise<unknown> {
    return { team: requireTeam(match.params.teamId) };
  }
}

export class PatchTeamRoute extends CoordinationRoute {
  method = 'PATCH' as const;
  path = '/api/v1/teams/:teamId';
  description = 'Invite, remove, or transfer team leadership';
  permission = 'sessions:write';
  async execute(match: RouteMatch, req: IncomingMessage): Promise<unknown> {
    const current = requireTeam(match.params.teamId);
    const body = await readBody(req);
    const actor = rootAgentId(current.rootSessionId);
    const add = strings(body.addMemberAgentIds);
    const remove = strings(body.removeMemberAgentIds);
    const leader = text(body.leaderAgentId);
    for (const id of [...add, ...(leader ? [leader] : [])]) requireActiveAgent(id);
    const active = CoordinationService.getInstance().listTasks(current.rootSessionId).filter(
      (task) => task.teamId === current.id
        && !!task.assigneeAgentId
        && remove.includes(task.assigneeAgentId)
        && !isTerminal(task.status),
    );
    if (active.length > 0 && body.force !== true) {
      throw new CoordinationError('conflict', `${active.length} active task(s) belong to removed members`);
    }
    for (const task of active) await cancelTask(task.id, 'Member forcibly removed from team', actor);
    const team = await CoordinationService.getInstance().updateTeam(current.rootSessionId, current.id, {
      addMemberAgentIds: add,
      removeMemberAgentIds: remove,
      leaderAgentId: leader,
    }, actor);
    return { team };
  }
}

export class DeleteTeamRoute extends CoordinationRoute {
  method = 'DELETE' as const;
  path = '/api/v1/teams/:teamId';
  description = 'Disband a collaboration team';
  permission = 'sessions:write';
  async execute(match: RouteMatch, req: IncomingMessage): Promise<unknown> {
    const current = requireTeam(match.params.teamId);
    const body = await readBody(req);
    const actor = rootAgentId(current.rootSessionId);
    const active = CoordinationService.getInstance().listTasks(current.rootSessionId).filter(
      (task) => task.teamId === current.id && !isTerminal(task.status),
    );
    if (active.length > 0 && body.force !== true) {
      throw new CoordinationError('conflict', `${active.length} non-terminal task(s) prevent disband`);
    }
    for (const task of active) await cancelTask(task.id, 'Team forcibly disbanded', actor);
    return { team: await CoordinationService.getInstance().disbandTeam(current.rootSessionId, current.id, actor) };
  }
}

export class ListCoordinationTasksRoute extends CoordinationRoute {
  method = 'GET' as const;
  path = '/api/v1/sessions/:rootSessionId/tasks';
  description = 'List durable coordination tasks and workspace leases';
  permission = 'sessions:read';
  async execute(match: RouteMatch): Promise<unknown> {
    const rootSessionId = requireRoot(match.params.rootSessionId);
    const snapshot = CoordinationService.getInstance().getSnapshot(rootSessionId);
    return {
      rootSessionId,
      revision: snapshot.revision,
      teams: snapshot.teams,
      tasks: snapshot.tasks,
      messages: snapshot.messages,
      leases: snapshot.leases,
    };
  }
}

export class CreateCoordinationTaskRoute extends CoordinationRoute {
  method = 'POST' as const;
  path = '/api/v1/sessions/:rootSessionId/tasks';
  description = 'Create a durable hierarchy or swarm task';
  permission = 'sessions:write';
  async execute(match: RouteMatch, req: IncomingMessage): Promise<unknown> {
    const rootSessionId = requireRoot(match.params.rootSessionId);
    const body = await readBody(req);
    const teamId = text(body.teamId);
    const sourceSessionId = text(body.sourceSessionId) || rootSessionId;
    const source = SessionManager.getInstance().session(sourceSessionId);
    if (!source || SessionManager.getInstance().getRootSession(sourceSessionId).id !== rootSessionId) {
      throw new CoordinationError('not_found', 'Source session not found in this root session');
    }
    const assigneeAgentId = text(body.assigneeAgentId);
    if (assigneeAgentId) requireActiveAgent(assigneeAgentId);
    if (teamId) {
      const team = CoordinationService.getInstance().getTeam(rootSessionId, teamId);
      if (!team) throw new CoordinationError('not_found', 'Team not found in this root session');
      if (assigneeAgentId && !team.memberAgentIds.includes(assigneeAgentId)) {
        throw new CoordinationError('validation', 'Swarm assignee must belong to the task team');
      }
    } else if (assigneeAgentId) {
      const target = AgentRegistry.getInstance().findAgent(assigneeAgentId);
      if (target?.parentAgentId !== rootAgentId(rootSessionId)) {
        throw new CoordinationError('validation', 'Hierarchy assignee must report directly to the root agent');
      }
    }
    const task = await CoordinationService.getInstance().createTask({
      rootSessionId,
      sourceSessionId,
      teamId,
      mode: teamId ? 'swarm' : 'hierarchy',
      subject: required(body.subject, 'subject'),
      description: required(body.description, 'description'),
      acceptanceCriteria: strings(body.acceptanceCriteria),
      priority: (text(body.priority) || 'normal') as CoordinationTaskPriority,
      creatorAgentId: rootAgentId(rootSessionId),
      assigneeAgentId,
      dependsOn: strings(body.dependsOn),
      readOnly: body.readOnly === true,
      writeScope: strings(body.writeScope),
      idempotencyKey: header(req, 'idempotency-key'),
    });
    return { task };
  }
}

export class GetCoordinationTaskRoute extends CoordinationRoute {
  method = 'GET' as const;
  path = '/api/v1/tasks/:taskId';
  description = 'Get one durable coordination task';
  permission = 'sessions:read';
  async execute(match: RouteMatch): Promise<unknown> {
    return { task: requireTask(match.params.taskId) };
  }
}

export class PatchCoordinationTaskRoute extends CoordinationRoute {
  method = 'PATCH' as const;
  path = '/api/v1/tasks/:taskId';
  description = 'Update durable task status and progress using optimistic versioning';
  permission = 'sessions:write';
  async execute(match: RouteMatch, req: IncomingMessage): Promise<unknown> {
    const current = requireTask(match.params.taskId);
    const body = await readBody(req);
    const task = await CoordinationService.getInstance().updateTask(current.rootSessionId, current.id, {
      status: text(body.status) as CoordinationTaskStatus | undefined,
      progress: integer(body.progress),
      blocker: text(body.blocker),
      resultSummary: text(body.resultSummary),
      evidence: strings(body.evidence),
      error: text(body.error),
    }, rootAgentId(current.rootSessionId), integer(body.expectedVersion));
    return { task };
  }
}

export class AssignCoordinationTaskRoute extends CoordinationRoute {
  method = 'POST' as const;
  path = '/api/v1/tasks/:taskId/assign';
  description = 'Assign an existing durable task';
  permission = 'sessions:write';
  async execute(match: RouteMatch, req: IncomingMessage): Promise<unknown> {
    const current = requireTask(match.params.taskId);
    const body = await readBody(req);
    const target = required(body.targetAgentId, 'targetAgentId');
    requireActiveAgent(target);
    if (current.mode === 'hierarchy') {
      const targetAgent = AgentRegistry.getInstance().findAgent(target);
      if (targetAgent?.parentAgentId !== current.creatorAgentId) {
        throw new CoordinationError('validation', 'Hierarchy assignee must be a direct subordinate of the task creator');
      }
    }
    return {
      task: await CoordinationService.getInstance().assignTask(
        current.rootSessionId,
        current.id,
        target,
        rootAgentId(current.rootSessionId),
        integer(body.expectedVersion),
      ),
    };
  }
}

export class ClaimCoordinationTaskRoute extends CoordinationRoute {
  method = 'POST' as const;
  path = '/api/v1/tasks/:taskId/claim';
  description = 'Atomically claim a ready task';
  permission = 'sessions:write';
  async execute(match: RouteMatch, req: IncomingMessage): Promise<unknown> {
    const current = requireTask(match.params.taskId);
    const body = await readBody(req);
    const agentId = text(body.agentId) || rootAgentId(current.rootSessionId);
    return {
      task: await CoordinationService.getInstance().claimTask(
        current.rootSessionId,
        current.id,
        agentId,
        integer(body.expectedVersion),
      ),
    };
  }
}

export class RetryCoordinationTaskRoute extends CoordinationRoute {
  method = 'POST' as const;
  path = '/api/v1/tasks/:taskId/retry';
  description = 'Retry a blocked, failed, or cancelled task';
  permission = 'sessions:write';
  async execute(match: RouteMatch): Promise<unknown> {
    const task = requireTask(match.params.taskId);
    return {
      task: await CoordinationService.getInstance().retryTask(
        task.rootSessionId,
        task.id,
        rootAgentId(task.rootSessionId),
      ),
    };
  }
}

export class StopCoordinationTaskRoute extends CoordinationRoute {
  method = 'POST' as const;
  path = '/api/v1/tasks/:taskId/stop';
  description = 'Cancel a task and cascade interruption to its AgentLoop';
  permission = 'sessions:write';
  async execute(match: RouteMatch, req: IncomingMessage): Promise<unknown> {
    const task = requireTask(match.params.taskId);
    const body = await readBody(req);
    return {
      task: await cancelTask(
        task.id,
        text(body.reason) || 'Stopped by user',
        rootAgentId(task.rootSessionId),
      ),
    };
  }
}

export class CoordinationEventsRoute extends CoordinationRoute {
  method = 'GET' as const;
  path = '/api/v1/sessions/:rootSessionId/coordination-events';
  description = 'Replay coordination events after a monotonic revision';
  permission = 'sessions:read';
  async execute(match: RouteMatch): Promise<unknown> {
    const rootSessionId = requireRoot(match.params.rootSessionId);
    const afterRevision = Math.max(0, Number(match.query.get('afterRevision') || '0') || 0);
    const events = await CoordinationService.getInstance().eventsAfter(rootSessionId, afterRevision);
    return {
      rootSessionId,
      events,
      revision: CoordinationService.getInstance().getSnapshot(rootSessionId).revision,
    };
  }
}

function requireRoot(rootSessionId: string): string {
  const manager = SessionManager.getInstance();
  const session = manager.session(rootSessionId);
  if (!session) throw new CoordinationError('not_found', 'Root session not found');
  if (manager.getRootSession(rootSessionId).id !== rootSessionId) {
    throw new CoordinationError('not_found', 'Coordination APIs require a root session ID');
  }
  return rootSessionId;
}

function rootAgentId(rootSessionId: string): string {
  const session = SessionManager.getInstance().session(rootSessionId);
  if (!session) throw new CoordinationError('not_found', 'Root session not found');
  return session.agentId;
}

function requireTeam(teamId: string) {
  const team = CoordinationService.getInstance().findTeam(teamId);
  if (!team) throw new CoordinationError('not_found', `Team not found: ${teamId}`);
  return team;
}

function requireTask(taskId: string) {
  const task = CoordinationService.getInstance().findTask(taskId);
  if (!task) throw new CoordinationError('not_found', `Task not found: ${taskId}`);
  return task;
}

function requireActiveAgent(agentId: string): void {
  if (!AgentRegistry.getInstance().findAgent(agentId)?.isActive) {
    throw new CoordinationError('validation', `Active agent not found: ${agentId}`);
  }
}

async function cancelTask(taskId: string, reason: string, actor: string) {
  const task = requireTask(taskId);
  if (isTerminal(task.status)) return task;
  if (task.sessionId) {
    InterruptController.getInstance().requestInterrupt(task.sessionId, InterruptReason.ParentStop);
  }
  return CoordinationService.getInstance().updateTask(task.rootSessionId, task.id, {
    status: 'cancelled',
    error: reason.slice(0, 1_000),
  }, actor);
}

function isTerminal(status: CoordinationTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function required(value: unknown, field: string): string {
  const result = text(value);
  if (!result) throw new CoordinationError('validation', `${field} is required`);
  return result;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim()).map((entry) => entry.trim())
    : [];
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? text(value[0]) : text(value);
}

function statusFor(error: unknown): number {
  if (!(error instanceof CoordinationError)) return 500;
  if (error.code === 'not_found') return 404;
  if (error.code === 'conflict') return 409;
  if (error.code === 'invalid_transition' || error.code === 'validation') return 422;
  if (error.code === 'forbidden') return 403;
  return 400;
}
