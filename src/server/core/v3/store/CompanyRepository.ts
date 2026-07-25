import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import type {
  Agent,
  AppendEventOptions,
  Company,
  CompanyLocale,
  CompanyEvent,
  CompanyEventEnvelope,
  CompanyProjection,
  ProjectionCheckpoint,
  Team,
  TeamMembership,
  TeamMembershipRole,
  Workspace,
} from '../../../../shared/types/v3/index.js';
import { V3DomainError } from '../domain/DomainError.js';
import { AppendOnlyEventStore } from './AppendOnlyEventStore.js';

export const INSTALL_COMPANY_SCOPE = 'install-company';

export interface CompanyRepositoryOptions {
  clock?: () => string;
  idFactory?: () => string;
  store?: AppendOnlyEventStore;
}

export type CompanyUpdate = Partial<Pick<Company, 'name' | 'description' | 'defaultLocale'>>;
export type WorkspaceUpdate = Partial<Pick<Workspace, 'name' | 'rootPath' | 'description'>>;
export type TeamUpdate = Partial<Pick<Team, 'name' | 'description' | 'parentTeamId'>>;
export type MembershipUpdate = Partial<Pick<TeamMembership, 'role' | 'isPrimary'>>;
export type AgentUpdate = Partial<Pick<
  Agent,
  | 'name'
  | 'description'
  | 'instructions'
  | 'status'
  | 'provider'
  | 'model'
  | 'credentialRef'
  | 'capabilities'
  | 'enabledSkills'
  | 'allowedTools'
>>;

export class CompanyRepository extends EventEmitter {
  private readonly store: AppendOnlyEventStore;
  private readonly clock: () => string;
  private readonly idFactory: () => string;

  constructor(
    rootDir = path.resolve('data', 'v3'),
    options: CompanyRepositoryOptions = {},
  ) {
    super();
    this.store = options.store ?? new AppendOnlyEventStore(rootDir);
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async getProjection(rebuild = false): Promise<CompanyProjection> {
    const events = await this.store.readCompanyEvents(INSTALL_COMPANY_SCOPE);
    if (!rebuild) {
      const checkpoint = await this.store.readCheckpoint<CompanyProjection>(
        'company',
        INSTALL_COMPANY_SCOPE,
      );
      if (isUsableCheckpoint(checkpoint, events)) {
        const projection = events
          .slice(checkpoint.revision)
          .reduce(applyCompanyEvent, checkpoint.projection);
        if (projection.revision !== checkpoint.revision) {
          await this.writeCheckpoint(projection, events.at(-1)?.eventId ?? null);
        }
        return projection;
      }
    }
    return this.rebuildProjection(events);
  }

  async rebuildProjection(
    knownEvents?: CompanyEventEnvelope[],
  ): Promise<CompanyProjection> {
    const events = knownEvents ?? await this.store.readCompanyEvents(INSTALL_COMPANY_SCOPE);
    const projection = events.reduce(applyCompanyEvent, emptyCompanyProjection());
    await this.writeCheckpoint(projection, events.at(-1)?.eventId ?? null);
    return projection;
  }

  async getCompany(): Promise<Company | null> {
    return (await this.getProjection()).company;
  }

  async listEvents(afterRevision = 0): Promise<CompanyEventEnvelope[]> {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      throw new V3DomainError('INVALID_ARGUMENT', 'afterRevision must be a non-negative integer');
    }
    return (await this.store.readCompanyEvents(INSTALL_COMPANY_SCOPE))
      .filter((event) => event.revision > afterRevision);
  }

  async createCompany(
    input: {
      id?: string;
      name: string;
      description?: string;
      mainAgentId: string;
      rootTeamId: string;
      defaultLocale: CompanyLocale;
    },
    options: AppendEventOptions,
  ): Promise<Company> {
    const projection = await this.getProjection();
    if (projection.company) {
      throw new V3DomainError('ALREADY_EXISTS', 'This AnoClaw install already has a company');
    }
    requireText(input.name, 'company name');
    requireText(input.mainAgentId, 'company mainAgentId');
    requireText(input.rootTeamId, 'company rootTeamId');
    requireCompanyLocale(input.defaultLocale);
    const now = options.occurredAt ?? this.clock();
    const company: Company = {
      id: input.id ?? this.idFactory(),
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      mainAgentId: input.mainAgentId,
      rootTeamId: input.rootTeamId,
      defaultLocale: input.defaultLocale,
      createdAt: now,
      updatedAt: now,
    };
    const next = await this.commit({ type: 'company.created', company }, options);
    return requireEntity(next.company, 'Company was not projected');
  }

  async bootstrapCompany(
    input: {
      id?: string;
      name: string;
      description?: string;
      mainAgentId?: string;
      mainAgentName?: string;
      mainAgentProvider?: string;
      mainAgentModel?: string;
      mainAgentCredentialRef?: string;
      rootTeamId?: string;
      rootTeamName?: string;
      membershipId?: string;
      defaultLocale: CompanyLocale;
    },
    options: AppendEventOptions,
  ): Promise<CompanyProjection & { company: Company }> {
    const projection = await this.getProjection();
    const workIds = await this.store.listWorkIds();
    if (
      projection.company
      || Object.keys(projection.teams).length > 0
      || Object.keys(projection.agents).length > 0
      || Object.keys(projection.memberships).length > 0
    ) {
      throw new V3DomainError('ALREADY_EXISTS', 'This AnoClaw install already has a company');
    }
    if (workIds.length > 0) {
      throw new V3DomainError(
        'CORRUPT_EVENT_STREAM',
        'Cannot bootstrap Company because data/v3 already contains Work streams',
        { workIds },
      );
    }
    requireText(input.name, 'company name');
    requireCompanyLocale(input.defaultLocale);
    const now = options.occurredAt ?? this.clock();
    const companyId = input.id ?? this.idFactory();
    const rootTeamId = input.rootTeamId ?? this.idFactory();
    const mainAgentId = input.mainAgentId ?? this.idFactory();
    const company: Company = {
      id: companyId,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      mainAgentId,
      rootTeamId,
      defaultLocale: input.defaultLocale,
      createdAt: now,
      updatedAt: now,
    };
    const rootTeam: Team = {
      id: rootTeamId,
      companyId,
      name: input.rootTeamName ?? 'Company',
      description: 'Root team for the local AnoClaw company',
      createdAt: now,
      updatedAt: now,
    };
    const mainAgent: Agent = {
      id: mainAgentId,
      companyId,
      name: input.mainAgentName ?? 'MainAgent',
      description: 'Autonomous owner of the local AnoClaw company',
      instructions: 'Own the company outcome, organize teams, and delegate work autonomously.',
      status: 'active',
      capabilities: ['organization.manage', 'work.manage', 'agent.delegate'],
      enabledSkills: [],
      allowedTools: ['*'],
      ...(input.mainAgentProvider ? { provider: input.mainAgentProvider } : {}),
      ...(input.mainAgentModel ? { model: input.mainAgentModel } : {}),
      ...(input.mainAgentCredentialRef ? { credentialRef: input.mainAgentCredentialRef } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const membership: TeamMembership = {
      id: input.membershipId ?? this.idFactory(),
      companyId,
      teamId: rootTeamId,
      agentId: mainAgentId,
      role: 'leader',
      isPrimary: true,
      createdAt: now,
      updatedAt: now,
    };
    const next = await this.commit(
      {
        type: 'company.bootstrapped',
        company,
        rootTeam,
        mainAgent,
        membership,
      },
      options,
    );
    return next as CompanyProjection & { company: Company };
  }

  async updateCompany(
    update: CompanyUpdate,
    options: AppendEventOptions,
  ): Promise<Company> {
    const projection = await this.getProjection();
    const current = requireEntity(projection.company, 'Company does not exist');
    if (update.name !== undefined) requireText(update.name, 'company name');
    if (update.defaultLocale !== undefined) requireCompanyLocale(update.defaultLocale);
    const company: Company = {
      ...current,
      ...defined(update),
      updatedAt: options.occurredAt ?? this.clock(),
    };
    const next = await this.commit({ type: 'company.updated', company }, options);
    return requireEntity(next.company, 'Company was not projected');
  }

  async createWorkspace(
    input: {
      id?: string;
      name: string;
      rootPath: string;
      description?: string;
    },
    options: AppendEventOptions,
  ): Promise<Workspace> {
    const projection = await this.requireCompanyProjection();
    requireText(input.name, 'workspace name');
    requireText(input.rootPath, 'workspace rootPath');
    const id = input.id ?? this.idFactory();
    assertAbsent(projection.workspaces[id], 'Workspace', id);
    const now = options.occurredAt ?? this.clock();
    const workspace: Workspace = {
      id,
      companyId: projection.company.id,
      name: input.name,
      rootPath: input.rootPath,
      ...(input.description !== undefined ? { description: input.description } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const next = await this.commit({ type: 'workspace.created', workspace }, options);
    return next.workspaces[id]!;
  }

  async updateWorkspace(
    workspaceId: string,
    update: WorkspaceUpdate,
    options: AppendEventOptions,
  ): Promise<Workspace> {
    const projection = await this.getProjection();
    const current = requireEntity(projection.workspaces[workspaceId], `Workspace not found: ${workspaceId}`);
    if (current.archivedAt) throw conflict(`Workspace is archived: ${workspaceId}`);
    if (update.name !== undefined) requireText(update.name, 'workspace name');
    if (update.rootPath !== undefined) requireText(update.rootPath, 'workspace rootPath');
    const workspace: Workspace = {
      ...current,
      ...defined(update),
      updatedAt: options.occurredAt ?? this.clock(),
    };
    const next = await this.commit({ type: 'workspace.updated', workspace }, options);
    return next.workspaces[workspaceId]!;
  }

  async archiveWorkspace(
    workspaceId: string,
    options: AppendEventOptions,
  ): Promise<Workspace> {
    const projection = await this.getProjection();
    const current = requireEntity(projection.workspaces[workspaceId], `Workspace not found: ${workspaceId}`);
    const now = options.occurredAt ?? this.clock();
    const workspace: Workspace = { ...current, updatedAt: now, archivedAt: now };
    const next = await this.commit({ type: 'workspace.archived', workspace }, options);
    return next.workspaces[workspaceId]!;
  }

  async createTeam(
    input: { id?: string; name: string; description?: string; parentTeamId?: string },
    options: AppendEventOptions,
  ): Promise<Team> {
    const projection = await this.requireCompanyProjection();
    requireText(input.name, 'team name');
    if (input.parentTeamId) requireActiveTeam(projection, input.parentTeamId);
    const id = input.id ?? this.idFactory();
    assertAbsent(projection.teams[id], 'Team', id);
    const now = options.occurredAt ?? this.clock();
    const team: Team = {
      id,
      companyId: projection.company.id,
      ...(input.parentTeamId ? { parentTeamId: input.parentTeamId } : {}),
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const next = await this.commit({ type: 'team.created', team }, options);
    return next.teams[id]!;
  }

  async updateTeam(
    teamId: string,
    update: TeamUpdate,
    options: AppendEventOptions,
  ): Promise<Team> {
    const projection = await this.getProjection();
    const current = requireActiveTeam(projection, teamId);
    if (update.name !== undefined) requireText(update.name, 'team name');
    if (update.parentTeamId !== undefined) {
      if (update.parentTeamId === teamId) throw conflict('A team cannot be its own parent');
      requireActiveTeam(projection, update.parentTeamId);
      assertNoTeamCycle(projection, teamId, update.parentTeamId);
    }
    const team: Team = {
      ...current,
      ...defined(update),
      updatedAt: options.occurredAt ?? this.clock(),
    };
    const next = await this.commit({ type: 'team.updated', team }, options);
    return next.teams[teamId]!;
  }

  async archiveTeam(teamId: string, options: AppendEventOptions): Promise<Team> {
    const projection = await this.getProjection();
    const current = requireActiveTeam(projection, teamId);
    const hasActiveChildren = Object.values(projection.teams)
      .some((team) => team.parentTeamId === teamId && !team.archivedAt);
    if (hasActiveChildren) throw conflict('A team with active child teams cannot be archived');
    const hasActiveMemberships = Object.values(projection.memberships)
      .some((membership) => membership.teamId === teamId && !membership.removedAt);
    if (hasActiveMemberships) throw conflict('A team with active memberships cannot be archived');
    const now = options.occurredAt ?? this.clock();
    const team: Team = { ...current, updatedAt: now, archivedAt: now };
    const next = await this.commit({ type: 'team.archived', team }, options);
    return next.teams[teamId]!;
  }

  async addMembership(
    input: {
      id?: string;
      teamId: string;
      agentId: string;
      role: TeamMembershipRole;
      isPrimary?: boolean;
    },
    options: AppendEventOptions,
  ): Promise<TeamMembership> {
    const projection = await this.requireCompanyProjection();
    requireActiveTeam(projection, input.teamId);
    requireActiveAgent(projection, input.agentId);
    const duplicate = Object.values(projection.memberships).find((membership) => (
      membership.teamId === input.teamId
      && membership.agentId === input.agentId
      && !membership.removedAt
    ));
    if (duplicate) throw conflict('Agent already has an active membership in this team');
    if (input.isPrimary) assertNoOtherPrimaryMembership(projection, input.agentId);
    const id = input.id ?? this.idFactory();
    assertAbsent(projection.memberships[id], 'Membership', id);
    const now = options.occurredAt ?? this.clock();
    const membership: TeamMembership = {
      id,
      companyId: projection.company.id,
      teamId: input.teamId,
      agentId: input.agentId,
      role: input.role,
      isPrimary: input.isPrimary ?? false,
      createdAt: now,
      updatedAt: now,
    };
    const next = await this.commit({ type: 'membership.added', membership }, options);
    return next.memberships[id]!;
  }

  async updateMembership(
    membershipId: string,
    update: MembershipUpdate,
    options: AppendEventOptions,
  ): Promise<TeamMembership> {
    const projection = await this.getProjection();
    const current = requireEntity(
      projection.memberships[membershipId],
      `Membership not found: ${membershipId}`,
    );
    if (current.removedAt) throw conflict(`Membership is removed: ${membershipId}`);
    if (update.isPrimary) {
      assertNoOtherPrimaryMembership(projection, current.agentId, membershipId);
    }
    const membership: TeamMembership = {
      ...current,
      ...defined(update),
      updatedAt: options.occurredAt ?? this.clock(),
    };
    const next = await this.commit({ type: 'membership.updated', membership }, options);
    return next.memberships[membershipId]!;
  }

  async removeMembership(
    membershipId: string,
    options: AppendEventOptions,
  ): Promise<TeamMembership> {
    const projection = await this.getProjection();
    const current = requireEntity(
      projection.memberships[membershipId],
      `Membership not found: ${membershipId}`,
    );
    const now = options.occurredAt ?? this.clock();
    const membership: TeamMembership = { ...current, updatedAt: now, removedAt: now };
    const next = await this.commit({ type: 'membership.removed', membership }, options);
    return next.memberships[membershipId]!;
  }

  async createAgent(
    input: {
      id?: string;
      name: string;
      description?: string;
      instructions?: string;
      provider?: string;
      model?: string;
      credentialRef?: string;
      capabilities?: string[];
      enabledSkills?: string[];
      allowedTools?: string[];
    },
    options: AppendEventOptions,
  ): Promise<Agent> {
    const projection = await this.requireCompanyProjection();
    requireText(input.name, 'agent name');
    const id = input.id ?? this.idFactory();
    assertAbsent(projection.agents[id], 'Agent', id);
    const now = options.occurredAt ?? this.clock();
    const agent: Agent = {
      id,
      companyId: projection.company.id,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      status: 'active',
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.credentialRef !== undefined ? { credentialRef: input.credentialRef } : {}),
      capabilities: [...(input.capabilities ?? [])],
      enabledSkills: [...(input.enabledSkills ?? [])],
      // Every persistent Agent has the same underlying runtime capability as
      // MainAgent. Team responsibility plus Task read/write policy narrows the
      // effective tool set at execution time.
      allowedTools: [...(input.allowedTools ?? ['*'])],
      createdAt: now,
      updatedAt: now,
    };
    const next = await this.commit({ type: 'agent.created', agent }, options);
    return next.agents[id]!;
  }

  async updateAgent(
    agentId: string,
    update: AgentUpdate,
    options: AppendEventOptions,
  ): Promise<Agent> {
    const projection = await this.getProjection();
    const current = requireActiveAgent(projection, agentId);
    if (update.name !== undefined) requireText(update.name, 'agent name');
    if (update.status === 'archived') {
      throw new V3DomainError('INVALID_ARGUMENT', 'Use archiveAgent to archive an agent');
    }
    const agent: Agent = {
      ...current,
      ...defined(update),
      updatedAt: options.occurredAt ?? this.clock(),
    };
    const next = await this.commit({ type: 'agent.updated', agent }, options);
    return next.agents[agentId]!;
  }

  async archiveAgent(agentId: string, options: AppendEventOptions): Promise<Agent> {
    const projection = await this.getProjection();
    const current = requireActiveAgent(projection, agentId);
    const hasActiveMemberships = Object.values(projection.memberships)
      .some((membership) => membership.agentId === agentId && !membership.removedAt);
    if (hasActiveMemberships) {
      throw conflict('An agent with active team memberships cannot be archived');
    }
    const now = options.occurredAt ?? this.clock();
    const agent: Agent = {
      ...current,
      status: 'archived',
      updatedAt: now,
      archivedAt: now,
    };
    const next = await this.commit({ type: 'agent.archived', agent }, options);
    return next.agents[agentId]!;
  }

  private async requireCompanyProjection(): Promise<CompanyProjection & { company: Company }> {
    const projection = await this.getProjection();
    if (!projection.company) throw new V3DomainError('NOT_FOUND', 'Company does not exist');
    return projection as CompanyProjection & { company: Company };
  }

  private async commit(
    event: CompanyEvent,
    options: AppendEventOptions,
  ): Promise<CompanyProjection> {
    const envelope = await this.store.appendCompanyEvent(
      INSTALL_COMPANY_SCOPE,
      {
        eventId: options.eventId ?? this.idFactory(),
        occurredAt: options.occurredAt ?? this.clock(),
        ...(options.actor ? { actor: options.actor } : {}),
        ...(options.correlationId ? { correlationId: options.correlationId } : {}),
        ...(options.causationId ? { causationId: options.causationId } : {}),
        event,
      },
      options.expectedRevision,
    );
    const projection = await this.rebuildProjection();
    this.emit('changed', {
      revision: envelope.revision,
      event,
    });
    return projection;
  }

  private async writeCheckpoint(
    projection: CompanyProjection,
    lastEventId: string | null,
  ): Promise<void> {
    await this.store.writeCheckpoint({
      schemaVersion: 3,
      scopeType: 'company',
      scopeId: INSTALL_COMPANY_SCOPE,
      revision: projection.revision,
      lastEventId,
      updatedAt: projection.updatedAt,
      projection,
    });
  }
}

export function emptyCompanyProjection(): CompanyProjection {
  return {
    company: null,
    workspaces: {},
    teams: {},
    memberships: {},
    agents: {},
    revision: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

export function applyCompanyEvent(
  projection: CompanyProjection,
  envelope: CompanyEventEnvelope,
): CompanyProjection {
  const next: CompanyProjection = {
    ...projection,
    workspaces: { ...projection.workspaces },
    teams: { ...projection.teams },
    memberships: { ...projection.memberships },
    agents: { ...projection.agents },
    revision: envelope.revision,
    updatedAt: envelope.occurredAt,
  };
  const event = envelope.event;
  switch (event.type) {
    case 'company.bootstrapped':
      next.company = event.company;
      next.teams[event.rootTeam.id] = event.rootTeam;
      next.agents[event.mainAgent.id] = event.mainAgent;
      next.memberships[event.membership.id] = event.membership;
      break;
    case 'company.created':
    case 'company.updated':
      next.company = event.company;
      break;
    case 'workspace.created':
    case 'workspace.updated':
    case 'workspace.archived':
      next.workspaces[event.workspace.id] = event.workspace;
      break;
    case 'team.created':
    case 'team.updated':
    case 'team.archived':
      next.teams[event.team.id] = event.team;
      break;
    case 'membership.added':
    case 'membership.updated':
    case 'membership.removed':
      next.memberships[event.membership.id] = event.membership;
      break;
    case 'agent.created':
    case 'agent.updated':
    case 'agent.archived':
      next.agents[event.agent.id] = event.agent;
      break;
  }
  return next;
}

function isUsableCheckpoint(
  checkpoint: ProjectionCheckpoint<CompanyProjection> | null,
  events: CompanyEventEnvelope[],
): checkpoint is ProjectionCheckpoint<CompanyProjection> {
  if (!checkpoint || checkpoint.revision > events.length) return false;
  if (checkpoint.projection.revision !== checkpoint.revision) return false;
  const expectedEventId = checkpoint.revision === 0
    ? null
    : events[checkpoint.revision - 1]?.eventId;
  return checkpoint.lastEventId === expectedEventId;
}

function requireActiveTeam(projection: CompanyProjection, teamId: string): Team {
  const team = requireEntity(projection.teams[teamId], `Team not found: ${teamId}`);
  if (team.archivedAt) throw conflict(`Team is archived: ${teamId}`);
  return team;
}

function requireActiveAgent(projection: CompanyProjection, agentId: string): Agent {
  const agent = requireEntity(projection.agents[agentId], `Agent not found: ${agentId}`);
  if (agent.status === 'archived') throw conflict(`Agent is archived: ${agentId}`);
  return agent;
}

function assertNoOtherPrimaryMembership(
  projection: CompanyProjection,
  agentId: string,
  exceptMembershipId?: string,
): void {
  const existing = Object.values(projection.memberships).find((membership) => (
    membership.agentId === agentId
    && membership.isPrimary
    && !membership.removedAt
    && membership.id !== exceptMembershipId
  ));
  if (existing) {
    throw conflict(`Agent already has primary membership ${existing.id}`);
  }
}

function assertNoTeamCycle(
  projection: CompanyProjection,
  teamId: string,
  parentTeamId: string,
): void {
  let cursor: string | undefined = parentTeamId;
  const visited = new Set<string>();
  while (cursor) {
    if (cursor === teamId) throw conflict('Nested team relationship would create a cycle');
    if (visited.has(cursor)) throw conflict('Existing team hierarchy contains a cycle');
    visited.add(cursor);
    cursor = projection.teams[cursor]?.parentTeamId;
  }
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

function requireText(value: string, label: string): void {
  if (!value.trim()) throw new V3DomainError('INVALID_ARGUMENT', `${label} is required`);
}

function requireCompanyLocale(locale: string): asserts locale is CompanyLocale {
  if (locale !== 'zh-CN' && locale !== 'en-US') {
    throw new V3DomainError('INVALID_ARGUMENT', 'defaultLocale must be zh-CN or en-US');
  }
}

function assertAbsent(value: unknown, label: string, id: string): void {
  if (value) throw new V3DomainError('ALREADY_EXISTS', `${label} already exists: ${id}`);
}

function requireEntity<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new V3DomainError('NOT_FOUND', message);
  return value;
}

function conflict(message: string): V3DomainError {
  return new V3DomainError('CONFLICT', message);
}
