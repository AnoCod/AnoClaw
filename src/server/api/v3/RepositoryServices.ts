import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type {
  Agent,
  Company,
  CompanyLocale,
  CompanyProjection,
  JsonObject as DomainJsonObject,
  Mission,
  Run,
  Session,
  Task,
  Team,
  TeamMembership,
  TeamMembershipRole,
  TranscriptMessage,
  VerificationCriterionResult,
  VerificationPolicy,
  VerificationRecord,
  Work,
  WorkProjection,
  Workspace,
} from '../../../shared/types/v3/index.js';
import { V3DomainError } from '../../core/v3/domain/DomainError.js';
import { TaskRunTransitionValidator } from '../../core/v3/orchestration/TaskRunTransitionValidator.js';
import {
  CompanyRepository,
  SessionTranscriptRepository,
  WorkRepository,
} from '../../core/v3/store/index.js';
import type { V3ApiServices, V3CompanyApi, V3WorkApi } from './Contracts.js';
import { revisioned, type JsonObject, type Revisioned } from './HttpContract.js';
import { SettingsManager } from '../../infra/storage/SettingsManager.js';
import {
  V3PrimaryTurnCoordinator,
  type QueuePrimaryTurnInput,
} from '../../core/v3/execution/V3PrimaryTurnCoordinator.js';
import type { V3RunExecutor } from '../../core/v3/orchestration/V3RunExecutor.js';

export interface RepositoryV3ServicesOptions {
  idFactory?: () => string;
  clock?: () => string;
  companyRepository?: CompanyRepository;
  workRepository?: WorkRepository;
  transcriptRepository?: SessionTranscriptRepository;
  runExecutor?: Pick<V3RunExecutor, 'stop'>;
  enablePrimaryTurns?: boolean;
  primaryTurnDispatcher?: {
    enqueue(input: QueuePrimaryTurnInput): void;
  };
}

export function createRepositoryV3Services(
  rootDir = path.resolve('data', 'v3'),
  options: RepositoryV3ServicesOptions = {},
): V3ApiServices {
  const companyRepository = options.companyRepository
    ?? new CompanyRepository(rootDir, options);
  const workRepository = options.workRepository
    ?? new WorkRepository(rootDir, options);
  const transcriptRepository = options.transcriptRepository
    ?? new SessionTranscriptRepository(rootDir, options);
  const primaryTurnDispatcher = options.primaryTurnDispatcher
    ?? (options.enablePrimaryTurns
      ? new V3PrimaryTurnCoordinator({
        companyRepository,
        workRepository,
        transcriptRepository,
        clock: options.clock,
        idFactory: options.idFactory,
      })
      : undefined);
  return {
    company: new RepositoryCompanyApi(
      companyRepository,
      workRepository,
      options.runExecutor,
    ),
    work: new RepositoryWorkApi(
      companyRepository,
      workRepository,
      transcriptRepository,
      options,
      options.runExecutor,
      primaryTurnDispatcher,
    ),
  };
}

export class RepositoryCompanyApi implements V3CompanyApi {
  constructor(
    private readonly repository: CompanyRepository,
    private readonly workRepository?: WorkRepository,
    private readonly runExecutor?: Pick<V3RunExecutor, 'stop'>,
  ) {}

  async getCompany(): Promise<Revisioned<Company | null>> {
    const projection = await this.repository.getProjection();
    return revisioned(projection.company, projection.revision);
  }

  async createCompany(input: JsonObject, expectedRevision: number): Promise<Revisioned<Company>> {
    const settings = SettingsManager.getInstance();
    const projection = await this.repository.bootstrapCompany(
      {
        name: text(input, 'name'),
        ...optionalTextField(input, 'description'),
        defaultLocale: input.defaultLocale === undefined ? 'zh-CN' : locale(input.defaultLocale),
        mainAgentProvider: settings.get<string>('llm.provider', 'openai-compatible'),
        mainAgentModel: settings.get<string>('llm.model', 'deepseek-chat'),
        mainAgentCredentialRef: settings.get<string>('llm.credentialRef', 'local-llm'),
      },
      { expectedRevision },
    );
    return revisioned(projection.company, expectedRevision + 1);
  }

  async updateCompany(input: JsonObject, expectedRevision: number): Promise<Revisioned<Company>> {
    const company = await this.repository.updateCompany(
      {
        ...optionalTextField(input, 'name'),
        ...optionalTextField(input, 'description'),
        ...(input.defaultLocale === undefined
          ? {}
          : { defaultLocale: locale(input.defaultLocale) }),
      },
      { expectedRevision },
    );
    return revisioned(company, expectedRevision + 1);
  }

  async listCompanyEvents(afterRevision: number) {
    const projection = await this.repository.getProjection();
    return revisioned(await this.repository.listEvents(afterRevision), projection.revision);
  }

  async listTeams(): Promise<Revisioned<Team[]>> {
    const projection = await this.repository.getProjection();
    return revisioned(
      Object.values(projection.teams).filter((team) => team.companyId === projection.company?.id),
      projection.revision,
    );
  }

  async getTeam(teamId: string): Promise<Revisioned<Team> | null> {
    const projection = await this.repository.getProjection();
    return owned(projection.teams[teamId], projection)
      ? revisioned(projection.teams[teamId]!, projection.revision)
      : null;
  }

  async createTeam(input: JsonObject, expectedRevision: number): Promise<Revisioned<Team>> {
    const team = await this.repository.createTeam(
      {
        ...(optionalText(input, 'id') ? { id: optionalText(input, 'id') } : {}),
        name: text(input, 'name'),
        ...optionalTextField(input, 'description'),
        ...optionalTextField(input, 'parentTeamId'),
      },
      { expectedRevision },
    );
    return revisioned(team, expectedRevision + 1);
  }

  async updateTeam(
    teamId: string,
    input: JsonObject,
    expectedRevision: number,
  ): Promise<Revisioned<Team> | null> {
    if (!(await this.getTeam(teamId))) return null;
    const team = await this.repository.updateTeam(
      teamId,
      {
        ...optionalTextField(input, 'name'),
        ...optionalTextField(input, 'description'),
        ...optionalTextField(input, 'parentTeamId'),
      },
      { expectedRevision },
    );
    return revisioned(team, expectedRevision + 1);
  }

  async archiveTeam(
    teamId: string,
    input: JsonObject,
    expectedRevision: number,
  ): Promise<Revisioned<Team> | null> {
    const projection = await this.repository.getProjection();
    const current = projection.teams[teamId];
    if (!owned(current, projection)) return null;
    assertExpectedRevision(projection.revision, expectedRevision);
    if (projection.company?.rootTeamId === teamId) {
      throw conflict('The Company root Team cannot be archived');
    }
    const activeChildTeams = Object.values(projection.teams)
      .filter((team) => team.parentTeamId === teamId && !team.archivedAt);
    if (activeChildTeams.length > 0) {
      throw conflict('A Team with active child Teams cannot be archived');
    }
    const memberships = Object.values(projection.memberships)
      .filter((membership) => membership.teamId === teamId && !membership.removedAt);
    const activeTasks = await this.activeTeamTasks(teamId);
    const force = input.force === true;
    if (memberships.length > 0 && !force) {
      throw conflict('A Team with active memberships cannot be archived without force');
    }
    if (activeTasks.length > 0 && !force) {
      throw conflict('A Team with active Tasks cannot be archived without force');
    }
    if (force) {
      await this.cancelTasks(activeTasks, 'Team force-archived');
    }
    let companyRevision = projection.revision;
    for (const membership of memberships) {
      await this.repository.removeMembership(
        membership.id,
        { expectedRevision: companyRevision },
      );
      companyRevision += 1;
    }
    const team = await this.repository.archiveTeam(
      teamId,
      { expectedRevision: companyRevision },
    );
    return revisioned(team, companyRevision + 1);
  }

  async listTeamMembers(teamId: string): Promise<Revisioned<TeamMembership[]> | null> {
    const projection = await this.repository.getProjection();
    if (!owned(projection.teams[teamId], projection)) return null;
    return revisioned(
      Object.values(projection.memberships).filter(
        (membership) => membership.teamId === teamId && !membership.removedAt,
      ),
      projection.revision,
    );
  }

  async addTeamMember(
    teamId: string,
    input: JsonObject,
    expectedRevision: number,
  ): Promise<Revisioned<TeamMembership> | null> {
    if (!(await this.getTeam(teamId))) return null;
    const projection = await this.repository.getProjection();
    const activeMembers = Object.values(projection.memberships).filter(
      (membership) => membership.teamId === teamId && !membership.removedAt,
    );
    const maxMembers = SettingsManager.getInstance().get<number>(
      'coordination.maxTeamMembers',
      8,
    );
    if (activeMembers.length >= maxMembers) {
      throw conflict(`Team member limit reached (${maxMembers})`);
    }
    const membership = await this.repository.addMembership(
      {
        ...(optionalText(input, 'id') ? { id: optionalText(input, 'id') } : {}),
        teamId,
        agentId: text(input, 'agentId'),
        role: membershipRole(input.role),
        ...(input.isPrimary === undefined ? {} : { isPrimary: booleanValue(input, 'isPrimary') }),
      },
      { expectedRevision },
    );
    return revisioned(membership, expectedRevision + 1);
  }

  async updateTeamMember(
    teamId: string,
    input: JsonObject,
    expectedRevision: number,
  ): Promise<Revisioned<TeamMembership> | null> {
    const projection = await this.repository.getProjection();
    if (!owned(projection.teams[teamId], projection)) return null;
    const membershipId = optionalText(input, 'membershipId');
    const agentId = optionalText(input, 'agentId');
    const membership = membershipId
      ? projection.memberships[membershipId]
      : Object.values(projection.memberships).find(
        (candidate) => candidate.teamId === teamId
          && candidate.agentId === agentId
          && !candidate.removedAt,
      );
    if (!membership || membership.teamId !== teamId || membership.removedAt) return null;
    const updated = await this.repository.updateMembership(
      membership.id,
      {
        ...(input.role === undefined ? {} : { role: membershipRole(input.role) }),
        ...(input.isPrimary === undefined
          ? {}
          : { isPrimary: booleanValue(input, 'isPrimary') }),
      },
      { expectedRevision },
    );
    return revisioned(updated, expectedRevision + 1);
  }

  async removeTeamMember(
    teamId: string,
    input: JsonObject,
    expectedRevision: number,
  ): Promise<Revisioned<TeamMembership> | null> {
    const projection = await this.repository.getProjection();
    if (!owned(projection.teams[teamId], projection)) return null;
    const membershipId = optionalText(input, 'membershipId');
    const agentId = optionalText(input, 'agentId');
    const membership = membershipId
      ? projection.memberships[membershipId]
      : Object.values(projection.memberships).find(
        (candidate) => candidate.teamId === teamId
          && candidate.agentId === agentId
          && !candidate.removedAt,
      );
    if (!membership || membership.teamId !== teamId || membership.removedAt) return null;
    const activeTasks = await this.activeTeamTasks(teamId, membership.agentId);
    const force = input.force === true;
    if (activeTasks.length > 0 && !force) {
      throw conflict('An Agent executing Team Tasks cannot be removed without force');
    }
    if (force) {
      await this.cancelTasks(activeTasks, 'Team membership force-removed');
    }
    const removed = await this.repository.removeMembership(
      membership.id,
      { expectedRevision },
    );
    return revisioned(removed, expectedRevision + 1);
  }

  private async activeTeamTasks(
    teamId: string,
    agentId?: string,
  ): Promise<Array<{ workId: string; task: Task; run?: Run }>> {
    if (!this.workRepository) return [];
    const results: Array<{ workId: string; task: Task; run?: Run }> = [];
    for (const workId of await this.workRepository.listWorkIds()) {
      const work = await this.workRepository.getProjection(workId);
      if (work.work?.companyId !== (await this.repository.getProjection()).company?.id) continue;
      for (const task of Object.values(work.tasks)) {
        if (
          task.teamId !== teamId
          || ['completed', 'failed', 'cancelled'].includes(task.status)
        ) {
          continue;
        }
        const run = Object.values(work.runs)
          .filter((candidate) => candidate.taskId === task.id)
          .sort((left, right) => right.attempt - left.attempt)[0];
        if (
          agentId
          && task.assignedAgentId !== agentId
          && run?.agentId !== agentId
        ) {
          continue;
        }
        results.push({ workId, task, ...(run ? { run } : {}) });
      }
    }
    return results;
  }

  private async cancelTasks(
    entries: Array<{ workId: string; task: Task; run?: Run }>,
    reason: string,
  ): Promise<void> {
    if (!this.workRepository) return;
    for (const entry of entries) {
      if (entry.run && !['succeeded', 'failed', 'cancelled'].includes(entry.run.status)) {
        if (!this.runExecutor) {
          throw conflict('Force removal requires the active Run controller');
        }
        await this.runExecutor.stop(entry.workId, entry.task.id, reason);
        continue;
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const projection = await this.workRepository.getProjection(entry.workId);
        const task = projection.tasks[entry.task.id];
        if (!task || ['completed', 'failed', 'cancelled'].includes(task.status)) break;
        try {
          await this.workRepository.updateTask(
            entry.workId,
            task.id,
            { status: 'cancelled' },
            { expectedRevision: projection.revision },
          );
          break;
        } catch (error) {
          if (
            !(error instanceof V3DomainError)
            || error.code !== 'REVISION_CONFLICT'
            || attempt === 2
          ) {
            throw error;
          }
        }
      }
    }
  }

  async listAgents(): Promise<Revisioned<Agent[]>> {
    const projection = await this.repository.getProjection();
    return revisioned(
      Object.values(projection.agents).filter((agent) => agent.companyId === projection.company?.id),
      projection.revision,
    );
  }

  async getAgent(agentId: string): Promise<Revisioned<Agent> | null> {
    const projection = await this.repository.getProjection();
    return owned(projection.agents[agentId], projection)
      ? revisioned(projection.agents[agentId]!, projection.revision)
      : null;
  }

  async createAgent(input: JsonObject, expectedRevision: number): Promise<Revisioned<Agent>> {
    const agent = await this.repository.createAgent(
      {
        ...(optionalText(input, 'id') ? { id: optionalText(input, 'id') } : {}),
        name: text(input, 'name'),
        ...optionalTextField(input, 'description'),
        ...optionalTextField(input, 'instructions'),
        ...optionalTextField(input, 'provider'),
        ...optionalTextField(input, 'model'),
        ...optionalTextField(input, 'credentialRef'),
        ...optionalStringArrayField(input, 'capabilities'),
        ...optionalStringArrayField(input, 'enabledSkills'),
        ...optionalStringArrayField(input, 'allowedTools'),
      },
      { expectedRevision },
    );
    return revisioned(agent, expectedRevision + 1);
  }

  async updateAgent(
    agentId: string,
    input: JsonObject,
    expectedRevision: number,
  ): Promise<Revisioned<Agent> | null> {
    if (!(await this.getAgent(agentId))) return null;
    const status = input.status === undefined
      ? {}
      : { status: enumValue(input.status, ['active', 'paused'] as const, 'status') };
    const agent = await this.repository.updateAgent(
      agentId,
      {
        ...optionalTextField(input, 'name'),
        ...optionalTextField(input, 'description'),
        ...optionalTextField(input, 'instructions'),
        ...optionalTextField(input, 'provider'),
        ...optionalTextField(input, 'model'),
        ...optionalTextField(input, 'credentialRef'),
        ...optionalStringArrayField(input, 'capabilities'),
        ...optionalStringArrayField(input, 'enabledSkills'),
        ...optionalStringArrayField(input, 'allowedTools'),
        ...status,
      },
      { expectedRevision },
    );
    return revisioned(agent, expectedRevision + 1);
  }

  async archiveAgent(
    agentId: string,
    _input: JsonObject,
    expectedRevision: number,
  ): Promise<Revisioned<Agent> | null> {
    if (!(await this.getAgent(agentId))) return null;
    const agent = await this.repository.archiveAgent(agentId, { expectedRevision });
    return revisioned(agent, expectedRevision + 1);
  }

  async listWorkspaces(): Promise<Revisioned<Workspace[]>> {
    const projection = await this.repository.getProjection();
    return revisioned(
      Object.values(projection.workspaces)
        .filter((workspace) => workspace.companyId === projection.company?.id),
      projection.revision,
    );
  }

  async getWorkspace(workspaceId: string): Promise<Revisioned<Workspace> | null> {
    const projection = await this.repository.getProjection();
    return owned(projection.workspaces[workspaceId], projection)
      ? revisioned(projection.workspaces[workspaceId]!, projection.revision)
      : null;
  }

  async createWorkspace(
    input: JsonObject,
    expectedRevision: number,
  ): Promise<Revisioned<Workspace>> {
    const workspace = await this.repository.createWorkspace(
      {
        ...(optionalText(input, 'id') ? { id: optionalText(input, 'id') } : {}),
        name: text(input, 'name'),
        rootPath: text(input, 'rootPath'),
        ...optionalTextField(input, 'description'),
      },
      { expectedRevision },
    );
    return revisioned(workspace, expectedRevision + 1);
  }

  async updateWorkspace(
    workspaceId: string,
    input: JsonObject,
    expectedRevision: number,
  ): Promise<Revisioned<Workspace> | null> {
    if (!(await this.getWorkspace(workspaceId))) return null;
    const workspace = await this.repository.updateWorkspace(
      workspaceId,
      {
        ...optionalTextField(input, 'name'),
        ...optionalTextField(input, 'rootPath'),
        ...optionalTextField(input, 'description'),
      },
      { expectedRevision },
    );
    return revisioned(workspace, expectedRevision + 1);
  }
}

export class RepositoryWorkApi implements V3WorkApi {
  private readonly idFactory: () => string;
  private readonly clock: () => string;
  private readonly transitions = new TaskRunTransitionValidator();

  constructor(
    private readonly companyRepository: CompanyRepository,
    private readonly workRepository: WorkRepository,
    private readonly transcriptRepository: SessionTranscriptRepository,
    options: RepositoryV3ServicesOptions = {},
    private readonly runExecutor?: Pick<V3RunExecutor, 'stop'>,
    private readonly primaryTurnDispatcher?: {
      enqueue(input: QueuePrimaryTurnInput): void;
    },
  ) {
    this.idFactory = options.idFactory ?? randomUUID;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async listWorks(): Promise<Revisioned<Work[]>> {
    const projections = await this.ownedWorkProjections();
    return revisioned(
      projections.map((projection) => projection.work!),
      Math.max(0, ...projections.map((projection) => projection.revision)),
    );
  }

  async getWork(workId: string): Promise<Revisioned<Work> | null> {
    const projection = await this.ownedWorkProjection(workId);
    return projection ? revisioned(projection.work!, projection.revision) : null;
  }

  async createWork(input: JsonObject, expectedRevision: number): Promise<Revisioned<Work>> {
    const company = await this.requireCompanyProjection();
    const workspaceId = optionalText(input, 'workspaceId');
    if (workspaceId) requireOwnedWorkspace(company, workspaceId);
    const id = optionalText(input, 'id') ?? this.idFactory();
    const primarySessionId = optionalText(input, 'primarySessionId') ?? this.idFactory();
    const agentId = optionalText(input, 'agentId') ?? company.company.mainAgentId;
    const agent = requireOwnedAgent(company, agentId);
    const work = await this.workRepository.createWork(
      {
        id,
        companyId: company.company.id,
        ...(workspaceId ? { workspaceId } : {}),
        primarySessionId,
        title: text(input, 'title'),
        objective: text(input, 'objective'),
        ...(input.status === undefined
          ? {}
          : { status: workStatus(input.status) }),
      },
      { expectedRevision },
    );
    await this.workRepository.createSession(
      id,
      {
        id: primarySessionId,
        kind: 'primary',
        agentId,
        actorSnapshot: actorSnapshot(agent, primaryMembershipTeamId(company, agent.id)),
      },
      { expectedRevision: expectedRevision + 1 },
    );
    return revisioned(work, expectedRevision + 2);
  }

  async updateWork(
    workId: string,
    input: JsonObject,
    expectedRevision: number,
  ): Promise<Revisioned<Work> | null> {
    const projection = await this.ownedWorkProjection(workId);
    if (!projection) return null;
    const company = await this.requireCompanyProjection();
    const workspaceId = optionalText(input, 'workspaceId');
    if (workspaceId) requireOwnedWorkspace(company, workspaceId);
    const focusMissionId = optionalText(input, 'focusMissionId');
    if (focusMissionId && projection.missions[focusMissionId]?.workId !== workId) return null;
    const nextStatus = input.status === undefined ? undefined : workStatus(input.status);
    const work = await this.workRepository.updateWork(
      workId,
      {
        ...optionalTextField(input, 'title'),
        ...optionalTextField(input, 'objective'),
        ...optionalTextField(input, 'workspaceId'),
        ...optionalTextField(input, 'focusMissionId'),
        ...(nextStatus === undefined ? {} : { status: nextStatus }),
      },
      { expectedRevision },
    );
    if ((nextStatus === 'paused' || nextStatus === 'cancelled') && this.runExecutor) {
      const afterCancellation = await this.workRepository.getProjection(workId);
      const activeTaskIds = Object.values(afterCancellation.tasks)
        .filter((task) => !['completed', 'failed', 'cancelled'].includes(task.status))
        .map((task) => task.id);
      for (const taskId of activeTaskIds) {
        await this.runExecutor.stop(
          workId,
          taskId,
          nextStatus === 'paused' ? 'Work paused by user' : 'Work cancelled by user',
        );
      }
      const finalProjection = await this.workRepository.getProjection(workId);
      return revisioned(finalProjection.work ?? work, finalProjection.revision);
    }
    return revisioned(work, expectedRevision + 1);
  }

  async listWorkEvents(workId: string, afterRevision: number) {
    const projection = await this.ownedWorkProjection(workId);
    if (!projection) return null;
    return revisioned(
      await this.workRepository.listEvents(workId, afterRevision),
      projection.revision,
    );
  }

  async listMissions(workId: string): Promise<Revisioned<Mission[]> | null> {
    const projection = await this.ownedWorkProjection(workId);
    return projection
      ? revisioned(Object.values(projection.missions), projection.revision)
      : null;
  }

  async getMission(missionId: string): Promise<Revisioned<Mission> | null> {
    const found = await this.findMission(missionId);
    return found ? revisioned(found.mission, found.projection.revision) : null;
  }

  async createMission(
    workId: string,
    input: JsonObject,
    expectedRevision: number,
  ): Promise<Revisioned<Mission> | null> {
    const projection = await this.ownedWorkProjection(workId);
    if (!projection) return null;
    const company = await this.requireCompanyProjection();
    const teamId = optionalText(input, 'teamId');
    const ownerAgentId = optionalText(input, 'ownerAgentId');
    if (teamId) requireOwnedTeam(company, teamId);
    if (ownerAgentId) requireOwnedAgent(company, ownerAgentId);
    const policy = input.verificationPolicy === undefined
      ? undefined
      : verificationPolicy(input.verificationPolicy);
    validateVerificationReviewer(policy, company);
    const mission = await this.workRepository.createMission(
      workId,
      {
        ...(optionalText(input, 'id') ? { id: optionalText(input, 'id') } : {}),
        title: text(input, 'title'),
        objective: text(input, 'objective'),
        ...optionalStringArrayField(input, 'acceptanceCriteria'),
        ...(input.priority === undefined ? {} : { priority: priority(input.priority) }),
        ...(policy ? { verificationPolicy: policy } : {}),
        ...(input.status === undefined ? {} : { status: missionStatus(input.status) }),
        ...(teamId ? { teamId } : {}),
        ...(ownerAgentId ? { ownerAgentId } : {}),
      },
      { expectedRevision },
    );
    return revisioned(mission, expectedRevision + 1);
  }

  async updateMission(
    missionId: string,
    input: JsonObject,
    expectedRevision: number,
  ): Promise<Revisioned<Mission> | null> {
    const found = await this.findMission(missionId);
    if (!found) return null;
    const company = await this.requireCompanyProjection();
    const teamId = optionalText(input, 'teamId');
    const ownerAgentId = optionalText(input, 'ownerAgentId');
    if (teamId) requireOwnedTeam(company, teamId);
    if (ownerAgentId) requireOwnedAgent(company, ownerAgentId);
    const policy = input.verificationPolicy === undefined
      ? undefined
      : verificationPolicy(input.verificationPolicy);
    validateVerificationReviewer(policy, company);
    const mission = await this.workRepository.updateMission(
      found.projection.work!.id,
      missionId,
      {
        ...optionalTextField(input, 'title'),
        ...optionalTextField(input, 'objective'),
        ...optionalStringArrayField(input, 'acceptanceCriteria'),
        ...(input.priority === undefined ? {} : { priority: priority(input.priority) }),
        ...(policy ? { verificationPolicy: policy } : {}),
        ...(input.status === undefined ? {} : { status: missionStatus(input.status) }),
        ...(teamId ? { teamId } : {}),
        ...(ownerAgentId ? { ownerAgentId } : {}),
      },
      { expectedRevision },
    );
    return revisioned(mission, expectedRevision + 1);
  }

  async listTasks(missionId: string): Promise<Revisioned<Task[]> | null> {
    const found = await this.findMission(missionId);
    return found
      ? revisioned(
        Object.values(found.projection.tasks)
          .filter((task) => task.missionId === missionId),
        found.projection.revision,
      )
      : null;
  }

  async getTask(taskId: string): Promise<Revisioned<Task> | null> {
    const found = await this.findTask(taskId);
    return found ? revisioned(found.task, found.projection.revision) : null;
  }

  async createTask(
    missionId: string,
    input: JsonObject,
    expectedRevision: number,
  ): Promise<Revisioned<Task> | null> {
    const found = await this.findMission(missionId);
    if (!found) return null;
    const company = await this.requireCompanyProjection();
    const teamId = optionalText(input, 'teamId');
    const assignedAgentId = optionalText(input, 'assignedAgentId');
    if (teamId) requireOwnedTeam(company, teamId);
    if (assignedAgentId) requireOwnedAgent(company, assignedAgentId);
    if (assignedAgentId) {
      assertReviewerDiffers(found.mission.verificationPolicy, assignedAgentId);
    }
    const task = await this.workRepository.createTask(
      found.projection.work!.id,
      {
        ...(optionalText(input, 'id') ? { id: optionalText(input, 'id') } : {}),
        missionId,
        title: text(input, 'title'),
        ...optionalTextField(input, 'description'),
        ...optionalStringArrayField(input, 'acceptanceCriteria'),
        ...(input.status === undefined ? {} : { status: taskStatus(input.status) }),
        ...(input.priority === undefined ? {} : { priority: priority(input.priority) }),
        ...(teamId ? { teamId } : {}),
        ...(assignedAgentId ? { assignedAgentId } : {}),
        ...optionalStringArrayField(input, 'dependsOnTaskIds'),
        ...(input.readOnly === undefined ? {} : { readOnly: booleanValue(input, 'readOnly') }),
        ...optionalStringArrayField(input, 'writeScope'),
        ...optionalTextField(input, 'dueAt'),
      },
      { expectedRevision },
    );
    return revisioned(task, expectedRevision + 1);
  }

  async updateTask(
    taskId: string,
    input: JsonObject,
    expectedRevision: number,
  ): Promise<Revisioned<Task> | null> {
    const found = await this.findTask(taskId);
    if (!found) return null;
    const company = await this.requireCompanyProjection();
    const teamId = optionalText(input, 'teamId');
    const assignedAgentId = optionalText(input, 'assignedAgentId');
    if (teamId) requireOwnedTeam(company, teamId);
    if (assignedAgentId) requireOwnedAgent(company, assignedAgentId);
    if (assignedAgentId) {
      assertReviewerDiffers(
        found.projection.missions[found.task.missionId]!.verificationPolicy,
        assignedAgentId,
      );
    }
    const nextStatus = input.status === undefined ? undefined : taskStatus(input.status);
    if (nextStatus && nextStatus !== found.task.status) {
      const decision = this.transitions.validateTaskTransition(found.task, nextStatus);
      if (!decision.ok) throw coded(decision.code, decision.message);
    }
    const task = await this.workRepository.updateTask(
      found.projection.work!.id,
      taskId,
      {
        ...optionalTextField(input, 'title'),
        ...optionalTextField(input, 'description'),
        ...optionalStringArrayField(input, 'acceptanceCriteria'),
        ...(nextStatus ? { status: nextStatus } : {}),
        ...(input.priority === undefined ? {} : { priority: priority(input.priority) }),
        ...(teamId ? { teamId } : {}),
        ...(assignedAgentId ? { assignedAgentId } : {}),
        ...optionalStringArrayField(input, 'dependsOnTaskIds'),
        ...(input.readOnly === undefined ? {} : { readOnly: booleanValue(input, 'readOnly') }),
        ...optionalStringArrayField(input, 'writeScope'),
        ...optionalTextField(input, 'dueAt'),
      },
      { expectedRevision },
    );
    return revisioned(task, expectedRevision + 1);
  }

  async assignTask(
    taskId: string,
    input: JsonObject,
    expectedRevision: number,
  ): Promise<Revisioned<Task> | null> {
    const found = await this.findTask(taskId);
    if (!found) return null;
    const company = await this.requireCompanyProjection();
    const agent = requireOwnedAgent(company, text(input, 'agentId'));
    assertReviewerDiffers(
      found.projection.missions[found.task.missionId]!.verificationPolicy,
      agent.id,
    );
    requireAgentTeamMembership(company, agent.id, found.task.teamId);
    const nextStatus = found.task.status === 'ready'
      ? 'ready'
      : this.requireTaskTransition(found.task, 'ready');
    const task = await this.workRepository.updateTask(
      found.projection.work!.id,
      taskId,
      { assignedAgentId: agent.id, status: nextStatus },
      { expectedRevision },
    );
    return revisioned(task, expectedRevision + 1);
  }

  async claimTask(
    taskId: string,
    input: JsonObject,
    expectedRevision: number,
  ): Promise<Revisioned<{ task: Task; run: Run }> | null> {
    const found = await this.findTask(taskId);
    if (!found) return null;
    assertExpectedRevision(found.projection.revision, expectedRevision);
    const company = await this.requireCompanyProjection();
    const agent = requireOwnedAgent(company, text(input, 'agentId'));
    assertReviewerDiffers(
      found.projection.missions[found.task.missionId]!.verificationPolicy,
      agent.id,
    );
    if (found.task.assignedAgentId && found.task.assignedAgentId !== agent.id) {
      throw conflict('Task is assigned to another agent');
    }
    requireAgentTeamMembership(company, agent.id, found.task.teamId);
    const status = this.requireTaskTransition(found.task, 'claimed');
    const sessionId = text(input, 'sessionId');
    if (found.projection.sessions[sessionId]) throw conflict(`Session already exists: ${sessionId}`);
    const now = this.clock();
    const claimed = await this.workRepository.claimTaskExecution(
      found.projection.work!.id,
      {
        taskId,
        agentId: agent.id,
        sessionId,
        runId: optionalText(input, 'runId') ?? this.idFactory(),
        decisionId: this.idFactory(),
        actorSnapshot: actorSnapshot(agent, primaryMembershipTeamId(company, agent.id)),
        maxTurns: positiveInteger(input, 'maxTurns'),
        candidateAgentIds: [agent.id],
        decisionReason: 'The API atomically claimed the Task for the requested eligible Agent.',
      },
      { expectedRevision, occurredAt: now },
    );
    return revisioned(
      { task: claimed.task, run: claimed.run },
      claimed.revision,
    );
  }

  async retryTask(
    taskId: string,
    input: JsonObject,
    expectedRevision: number,
  ): Promise<Revisioned<{ task: Task; run: Run }> | null> {
    const found = await this.findTask(taskId);
    if (!found) return null;
    assertExpectedRevision(found.projection.revision, expectedRevision);
    const previousRun = latestRun(found.projection, taskId);
    if (!previousRun) throw conflict('Task has no previous Run to retry');
    const decision = this.transitions.prepareRevisionAttempt(found.task, previousRun);
    if (!decision.ok) throw coded(decision.code, decision.message);
    const company = await this.requireCompanyProjection();
    const agentId = optionalText(input, 'agentId')
      ?? found.task.assignedAgentId
      ?? previousRun.agentId;
    const agent = requireOwnedAgent(company, agentId);
    assertReviewerDiffers(
      found.projection.missions[found.task.missionId]!.verificationPolicy,
      agent.id,
    );
    requireAgentTeamMembership(company, agent.id, found.task.teamId);
    const sessionId = optionalText(input, 'sessionId') ?? this.idFactory();
    const maxTurns = input.maxTurns === undefined
      ? previousRun.maxTurns
      : positiveInteger(input, 'maxTurns');
    const now = this.clock();
    const retried = await this.workRepository.retryTaskExecution(
      found.projection.work!.id,
      {
        taskId,
        agentId: agent.id,
        sessionId,
        runId: optionalText(input, 'runId') ?? this.idFactory(),
        decisionId: this.idFactory(),
        actorSnapshot: actorSnapshot(agent, primaryMembershipTeamId(company, agent.id)),
        maxTurns,
        candidateAgentIds: [agent.id],
        decisionReason: 'The API atomically reserved the requested revision attempt.',
      },
      { expectedRevision, occurredAt: now },
    );
    return revisioned(
      { task: retried.task, run: retried.run },
      retried.revision,
    );
  }

  async stopTask(
    taskId: string,
    input: JsonObject,
    expectedRevision: number,
  ): Promise<Revisioned<{ task: Task; run?: Run }> | null> {
    const found = await this.findTask(taskId);
    if (!found) return null;
    assertExpectedRevision(found.projection.revision, expectedRevision);
    const runId = text(input, 'runId');
    const currentRun = found.projection.runs[runId];
    if (!currentRun || currentRun.taskId !== taskId) return null;
    const now = this.clock();
    const reason = optionalText(input, 'reason') ?? 'Stopped through the v3 API.';
    if (this.runExecutor) {
      await this.runExecutor.stop(found.projection.work!.id, taskId, reason);
      const stoppedProjection = await this.workRepository.getProjection(
        found.projection.work!.id,
      );
      const task = stoppedProjection.tasks[taskId];
      const run = stoppedProjection.runs[runId];
      if (!task || !run) return null;
      return revisioned({ task, run }, stoppedProjection.revision);
    }
    const stopped = await this.workRepository.finishTaskExecution(
      found.projection.work!.id,
      {
        runId,
        taskStatus: 'cancelled',
        runStatus: 'cancelled',
        terminationReason: 'cancelled',
        error: reason,
        decision: {
          kind: 'recovery',
          decision: 'stop_cascade',
          reason,
          candidateAgentIds: [currentRun.agentId],
          selectedAgentId: currentRun.agentId,
        },
      },
      { expectedRevision, occurredAt: now },
    );
    return revisioned(
      { task: stopped.task, run: stopped.run },
      stopped.revision,
    );
  }

  async verifyTask(
    taskId: string,
    input: JsonObject,
    expectedRevision: number,
  ): Promise<Revisioned<{ task: Task; verification: VerificationRecord }> | null> {
    const found = await this.findTask(taskId);
    if (!found) return null;
    assertExpectedRevision(found.projection.revision, expectedRevision);
    const mission = found.projection.missions[found.task.missionId];
    if (!mission) return null;
    if (mission.verificationPolicy.mode !== 'user') {
      throw conflict('Only user-mode verification can be decided through this endpoint');
    }
    const pending = Object.values(found.projection.verificationRecords)
      .filter((record) => (
        record.taskId === taskId
        && record.mode === 'user'
        && record.outcome === 'pending'
      ))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (!pending) {
      throw conflict(`Task ${taskId} has no pending user verification`);
    }
    const outcome = enumValue(
      input.outcome,
      ['approved', 'revision_required'] as const,
      'outcome',
    );
    const completed = await this.workRepository.completeTaskVerification(
      found.projection.work.id,
      {
        verificationId: pending.id,
        outcome,
        summary: text(input, 'summary'),
        criteria: verificationCriteriaResults(input.criteria),
      },
      { expectedRevision, occurredAt: this.clock() },
    );
    return revisioned(
      { task: completed.task, verification: completed.verification },
      completed.revision,
    );
  }

  async listSessions(workId: string): Promise<Revisioned<Session[]> | null> {
    const projection = await this.ownedWorkProjection(workId);
    return projection
      ? revisioned(Object.values(projection.sessions), projection.revision)
      : null;
  }

  async getSession(sessionId: string): Promise<Revisioned<Session> | null> {
    const found = await this.findSession(sessionId);
    return found ? revisioned(found.session, found.projection.revision) : null;
  }

  async listTranscript(
    sessionId: string,
    afterSequence: number,
  ): Promise<Revisioned<TranscriptMessage[]> | null> {
    if (!(await this.findSession(sessionId))) return null;
    const records = await this.transcriptRepository.read(sessionId);
    const revision = records.at(-1)?.sequence ?? 0;
    return revisioned(
      records
        .filter((record) => record.sequence > afterSequence && record.entry.kind === 'message')
        .map((record) => record.entry as TranscriptMessage),
      revision,
    );
  }

  async appendMessage(
    sessionId: string,
    input: JsonObject,
    expectedRevision: number,
  ): Promise<Revisioned<TranscriptMessage> | null> {
    const found = await this.findSession(sessionId);
    if (!found) return null;
    if (found.session.status === 'closed') throw conflict('Session is closed');
    if (found.session.kind !== 'primary') {
      throw conflict('Users can write only to a Work primary Session');
    }
    const role = transcriptRole(input.role);
    if (role !== 'user') {
      throw invalid('The public Session message API accepts user messages only');
    }
    const message: TranscriptMessage = {
      kind: 'message',
      id: optionalText(input, 'id') ?? this.idFactory(),
      role,
      content: text(input, 'content'),
      ...optionalTextField(input, 'agentId'),
      ...optionalTextField(input, 'toolCallId'),
      ...optionalTextField(input, 'toolName'),
      ...(input.metadata === undefined
        ? {}
        : { metadata: jsonObject(input.metadata, 'metadata') as unknown as DomainJsonObject }),
    };
    const record = await this.transcriptRepository.append(
      sessionId,
      message,
      { expectedSequence: expectedRevision, entryId: message.id },
    );
    await this.synchronizeTranscriptRevision(
      found.projection.work!.id,
      sessionId,
      record.sequence,
    );
    this.primaryTurnDispatcher?.enqueue({
      workId: found.projection.work!.id,
      sessionId,
      messageId: message.id,
    });
    return revisioned(message, record.sequence);
  }

  private async synchronizeTranscriptRevision(
    workId: string,
    sessionId: string,
    transcriptRevision: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const projection = await this.workRepository.getProjection(workId);
      const session = projection.sessions[sessionId];
      if (!session || session.transcriptRevision >= transcriptRevision) return;
      try {
        await this.workRepository.updateSession(
          workId,
          sessionId,
          { transcriptRevision },
          {
            expectedRevision: projection.revision,
            eventId: `transcript-${sessionId}-${transcriptRevision}`,
          },
        );
        return;
      } catch (error) {
        if (!(error instanceof V3DomainError) || error.code !== 'REVISION_CONFLICT') throw error;
      }
    }
    throw conflict('Could not synchronize Session transcript revision');
  }

  private async requireCompanyProjection(): Promise<CompanyProjection & { company: Company }> {
    const projection = await this.companyRepository.getProjection();
    if (!projection.company) throw new V3DomainError('NOT_FOUND', 'Company does not exist');
    return projection as CompanyProjection & { company: Company };
  }

  private async ownedWorkProjections(): Promise<Array<WorkProjection & { work: Work }>> {
    const company = await this.requireCompanyProjection();
    const projections = await Promise.all(
      (await this.workRepository.listWorkIds())
        .map((workId) => this.workRepository.getProjection(workId)),
    );
    return projections.filter(
      (projection): projection is WorkProjection & { work: Work } => (
        projection.work?.companyId === company.company.id
      ),
    );
  }

  private async ownedWorkProjection(
    workId: string,
  ): Promise<(WorkProjection & { work: Work }) | null> {
    const company = await this.requireCompanyProjection();
    const projection = await this.workRepository.getProjection(workId);
    return projection.work?.companyId === company.company.id
      ? projection as WorkProjection & { work: Work }
      : null;
  }

  private async findMission(
    missionId: string,
  ): Promise<{ projection: WorkProjection & { work: Work }; mission: Mission } | null> {
    for (const projection of await this.ownedWorkProjections()) {
      const mission = projection.missions[missionId];
      if (mission?.workId === projection.work.id) return { projection, mission };
    }
    return null;
  }

  private async findTask(
    taskId: string,
  ): Promise<{ projection: WorkProjection & { work: Work }; task: Task } | null> {
    for (const projection of await this.ownedWorkProjections()) {
      const task = projection.tasks[taskId];
      if (task?.workId === projection.work.id) return { projection, task };
    }
    return null;
  }

  private async findSession(
    sessionId: string,
  ): Promise<{ projection: WorkProjection & { work: Work }; session: Session } | null> {
    for (const projection of await this.ownedWorkProjections()) {
      const session = projection.sessions[sessionId];
      if (session?.workId === projection.work.id) return { projection, session };
    }
    return null;
  }

  private requireTaskTransition<T extends Task['status']>(task: Task, status: T): T {
    const decision = this.transitions.validateTaskTransition(task, status);
    if (!decision.ok) throw coded(decision.code, decision.message);
    return status;
  }
}

function owned(
  entity: { companyId: string } | undefined,
  projection: CompanyProjection,
): boolean {
  return !!entity && !!projection.company && entity.companyId === projection.company.id;
}

function requireOwnedTeam(projection: CompanyProjection, teamId: string): Team {
  const team = projection.teams[teamId];
  if (!owned(team, projection) || team!.archivedAt) {
    throw new V3DomainError('NOT_FOUND', 'Team not found');
  }
  return team!;
}

function requireOwnedAgent(projection: CompanyProjection, agentId: string): Agent {
  const agent = projection.agents[agentId];
  if (!owned(agent, projection) || agent!.status === 'archived') {
    throw new V3DomainError('NOT_FOUND', 'Agent not found');
  }
  return agent!;
}

function requireOwnedWorkspace(projection: CompanyProjection, workspaceId: string): Workspace {
  const workspace = projection.workspaces[workspaceId];
  if (!owned(workspace, projection) || workspace!.archivedAt) {
    throw new V3DomainError('NOT_FOUND', 'Workspace not found');
  }
  return workspace!;
}

function primaryMembershipTeamId(
  projection: CompanyProjection,
  agentId: string,
): string | undefined {
  return Object.values(projection.memberships).find(
    (membership) => membership.agentId === agentId
      && membership.isPrimary
      && !membership.removedAt,
  )?.teamId;
}

function requireAgentTeamMembership(
  projection: CompanyProjection,
  agentId: string,
  teamId: string | undefined,
): void {
  if (!teamId) return;
  const membership = Object.values(projection.memberships).find(
    (candidate) => candidate.agentId === agentId
      && candidate.teamId === teamId
      && !candidate.removedAt,
  );
  if (!membership) throw new V3DomainError('NOT_FOUND', 'Agent is not a member of the Task Team');
}

function actorSnapshot(
  agent: Agent,
  teamId: string | undefined,
): Session['actorSnapshot'] {
  return {
    agentId: agent.id,
    name: agent.name,
    ...(teamId ? { teamId } : {}),
    ...(agent.instructions ? { instructions: agent.instructions } : {}),
    ...(agent.provider ? { provider: agent.provider } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    capabilities: [...agent.capabilities],
    enabledSkills: [...agent.enabledSkills],
    allowedTools: [...agent.allowedTools],
  };
}

function nextAttempt(projection: WorkProjection, taskId: string): number {
  return Math.max(
    0,
    ...Object.values(projection.runs)
      .filter((run) => run.taskId === taskId)
      .map((run) => run.attempt),
  ) + 1;
}

function latestRun(projection: WorkProjection, taskId: string): Run | undefined {
  return Object.values(projection.runs)
    .filter((run) => run.taskId === taskId)
    .sort((left, right) => right.attempt - left.attempt)[0];
}

function validateVerificationReviewer(
  policy: VerificationPolicy | undefined,
  projection: CompanyProjection,
): void {
  if (policy?.reviewerAgentId) requireOwnedAgent(projection, policy.reviewerAgentId);
}

function assertReviewerDiffers(policy: VerificationPolicy, workerAgentId: string): void {
  if (
    policy.mode === 'independent_agent'
    && policy.reviewerAgentId === workerAgentId
  ) {
    throw coded('reviewer_must_differ', 'The reviewer must be distinct from the worker.');
  }
}

function text(input: JsonObject, field: string): string {
  const value = optionalText(input, field);
  if (!value) throw invalid(`${field} is required`);
  return value;
}

function optionalText(input: JsonObject, field: string): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(`${field} must be a string`);
  return value.trim() || undefined;
}

function optionalTextField<TField extends string>(
  input: JsonObject,
  field: TField,
): Partial<Record<TField, string>> {
  const value = optionalText(input, field);
  return value === undefined ? {} : { [field]: value } as Record<TField, string>;
}

function optionalStringArrayField<TField extends string>(
  input: JsonObject,
  field: TField,
): Partial<Record<TField, string[]>> {
  if (input[field] === undefined) return {};
  if (!Array.isArray(input[field])) throw invalid(`${field} must be an array`);
  const values = (input[field] as unknown[]).map((value) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw invalid(`${field} must contain non-empty strings`);
    }
    return value.trim();
  });
  return { [field]: [...new Set(values)] } as Record<TField, string[]>;
}

function booleanValue(input: JsonObject, field: string): boolean {
  if (typeof input[field] !== 'boolean') throw invalid(`${field} must be a boolean`);
  return input[field];
}

function positiveInteger(input: JsonObject, field: string): number {
  const value = input[field];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalid(`${field} must be a positive integer`);
  }
  return value as number;
}

function jsonObject(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${field} must be an object`);
  }
  return value as JsonObject;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw invalid(`${field} must be one of ${allowed.join(', ')}`);
  }
  return value;
}

function locale(value: unknown): CompanyLocale {
  return enumValue(value, ['zh-CN', 'en-US'] as const, 'defaultLocale');
}

function membershipRole(value: unknown): TeamMembershipRole {
  return enumValue(value, ['leader', 'member'] as const, 'role');
}

function priority(value: unknown): Task['priority'] {
  return enumValue(value, ['low', 'normal', 'high', 'critical'] as const, 'priority');
}

function workStatus(value: unknown): Work['status'] {
  return enumValue(
    value,
    ['draft', 'active', 'paused', 'completed', 'cancelled', 'archived'] as const,
    'status',
  );
}

function missionStatus(value: unknown): Mission['status'] {
  return enumValue(
    value,
    ['planned', 'active', 'blocked', 'completed', 'cancelled'] as const,
    'status',
  );
}

function taskStatus(value: unknown): Task['status'] {
  return enumValue(
    value,
    [
      'pending',
      'ready',
      'claimed',
      'running',
      'submitted',
      'verifying',
      'revision_required',
      'blocked',
      'completed',
      'failed',
      'cancelled',
    ] as const,
    'status',
  );
}

function transcriptRole(value: unknown): TranscriptMessage['role'] {
  return enumValue(value, ['user', 'assistant', 'system', 'tool'] as const, 'role');
}

function verificationPolicy(value: unknown): VerificationPolicy {
  const input = jsonObject(value, 'verificationPolicy');
  const mode = enumValue(
    input.mode,
    ['automatic', 'independent_agent', 'user'] as const,
    'verificationPolicy.mode',
  );
  const reviewerAgentId = optionalText(input, 'reviewerAgentId');
  if (reviewerAgentId && mode !== 'independent_agent') {
    throw invalid('reviewerAgentId is only valid for independent_agent verification');
  }
  const requireDifferentAgent = booleanValue(input, 'requireDifferentAgent');
  if (mode === 'independent_agent' && !requireDifferentAgent) {
    throw invalid('independent_agent verification must require a different agent');
  }
  return {
    mode,
    ...(reviewerAgentId ? { reviewerAgentId } : {}),
    requireDifferentAgent,
    maxRevisionAttempts: nonNegativeInteger(input, 'maxRevisionAttempts'),
    requiredEvidence: optionalStringArrayField(input, 'requiredEvidence').requiredEvidence ?? [],
  };
}

function verificationCriteriaResults(value: unknown): VerificationCriterionResult[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw invalid('criteria must contain between 1 and 50 results');
  }
  return value.map((entry, index) => {
    const item = jsonObject(entry, `criteria[${index}]`);
    const passed = item.passed;
    if (typeof passed !== 'boolean') {
      throw invalid(`criteria[${index}].passed must be a boolean`);
    }
    const evidence = item.evidence;
    if (!Array.isArray(evidence) || evidence.length > 50) {
      throw invalid(`criteria[${index}].evidence must be an array with at most 50 entries`);
    }
    const normalizedEvidence = evidence.map((entry, evidenceIndex) => {
      if (typeof entry !== 'string' || !entry.trim()) {
        throw invalid(`criteria[${index}].evidence[${evidenceIndex}] must be a non-empty string`);
      }
      return entry.trim();
    });
    const note = item.note;
    if (note !== undefined && (typeof note !== 'string' || !note.trim())) {
      throw invalid(`criteria[${index}].note must be a non-empty string when provided`);
    }
    return {
      criterion: text(item, 'criterion'),
      passed,
      evidence: normalizedEvidence,
      ...(typeof note === 'string' ? { note: note.trim() } : {}),
    };
  });
}

function nonNegativeInteger(input: JsonObject, field: string): number {
  const value = input[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalid(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function assertExpectedRevision(actualRevision: number, expectedRevision: number): void {
  if (actualRevision !== expectedRevision) {
    throw new V3DomainError(
      'REVISION_CONFLICT',
      `Expected revision ${expectedRevision}, current revision is ${actualRevision}`,
      { expectedRevision, currentRevision: actualRevision },
    );
  }
}

function invalid(message: string): V3DomainError {
  return new V3DomainError('INVALID_ARGUMENT', message);
}

function conflict(message: string): V3DomainError {
  return new V3DomainError('CONFLICT', message);
}

function coded(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
