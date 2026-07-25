import type {
  Agent,
  Company,
  CompanyEventEnvelope,
  Mission,
  Run,
  Session,
  Task,
  Team,
  TeamMembership,
  TranscriptMessage,
  VerificationRecord,
  Work,
  WorkEventEnvelope,
  Workspace,
} from '../../../shared/types/v3/index.js';
import type { JsonObject, Revisioned } from './HttpContract.js';

export type MaybeRevisioned<T> = Promise<Revisioned<T> | null>;
export type RevisionedResult<T> = Promise<Revisioned<T>>;

/**
 * Organization-side port consumed by the v3 HTTP layer.
 *
 * The implementation owns authorization and company scoping. In particular,
 * child lookups must return null (or NOT_FOUND) when an ID belongs to another
 * company/team. The HTTP layer deliberately converts all such misses to the
 * same 404 envelope.
 */
export interface V3CompanyApi {
  getCompany(): RevisionedResult<Company | null>;
  createCompany(input: JsonObject, expectedRevision: number): RevisionedResult<Company>;
  updateCompany(input: JsonObject, expectedRevision: number): RevisionedResult<Company>;
  listCompanyEvents(afterRevision: number): RevisionedResult<CompanyEventEnvelope[]>;

  listTeams(): RevisionedResult<Team[]>;
  getTeam(teamId: string): MaybeRevisioned<Team>;
  createTeam(input: JsonObject, expectedRevision: number): RevisionedResult<Team>;
  updateTeam(teamId: string, input: JsonObject, expectedRevision: number): MaybeRevisioned<Team>;
  archiveTeam(teamId: string, input: JsonObject, expectedRevision: number): MaybeRevisioned<Team>;
  listTeamMembers(teamId: string): MaybeRevisioned<TeamMembership[]>;
  addTeamMember(teamId: string, input: JsonObject, expectedRevision: number): MaybeRevisioned<TeamMembership>;
  updateTeamMember(teamId: string, input: JsonObject, expectedRevision: number): MaybeRevisioned<TeamMembership>;
  removeTeamMember(teamId: string, input: JsonObject, expectedRevision: number): MaybeRevisioned<TeamMembership>;

  listAgents(): RevisionedResult<Agent[]>;
  getAgent(agentId: string): MaybeRevisioned<Agent>;
  createAgent(input: JsonObject, expectedRevision: number): RevisionedResult<Agent>;
  updateAgent(agentId: string, input: JsonObject, expectedRevision: number): MaybeRevisioned<Agent>;
  archiveAgent(agentId: string, input: JsonObject, expectedRevision: number): MaybeRevisioned<Agent>;

  listWorkspaces(): RevisionedResult<Workspace[]>;
  getWorkspace(workspaceId: string): MaybeRevisioned<Workspace>;
  createWorkspace(input: JsonObject, expectedRevision: number): RevisionedResult<Workspace>;
  updateWorkspace(workspaceId: string, input: JsonObject, expectedRevision: number): MaybeRevisioned<Workspace>;
}

/**
 * Work-side port consumed by the v3 HTTP layer.
 *
 * Every nested method receives its parent identifiers. Implementations must
 * verify the complete ownership chain instead of resolving a globally unique
 * child ID and trusting it. A mismatched chain is a NOT_FOUND condition.
 */
export interface V3WorkApi {
  listWorks(): RevisionedResult<Work[]>;
  getWork(workId: string): MaybeRevisioned<Work>;
  createWork(input: JsonObject, expectedRevision: number): RevisionedResult<Work>;
  updateWork(workId: string, input: JsonObject, expectedRevision: number): MaybeRevisioned<Work>;
  listWorkEvents(workId: string, afterRevision: number): MaybeRevisioned<WorkEventEnvelope[]>;

  listMissions(workId: string): MaybeRevisioned<Mission[]>;
  getMission(missionId: string): MaybeRevisioned<Mission>;
  createMission(workId: string, input: JsonObject, expectedRevision: number): MaybeRevisioned<Mission>;
  updateMission(
    missionId: string,
    input: JsonObject,
    expectedRevision: number,
  ): MaybeRevisioned<Mission>;

  listTasks(missionId: string): MaybeRevisioned<Task[]>;
  getTask(taskId: string): MaybeRevisioned<Task>;
  createTask(missionId: string, input: JsonObject, expectedRevision: number): MaybeRevisioned<Task>;
  updateTask(
    taskId: string,
    input: JsonObject,
    expectedRevision: number,
  ): MaybeRevisioned<Task>;
  assignTask(
    taskId: string,
    input: JsonObject,
    expectedRevision: number,
  ): MaybeRevisioned<Task>;
  claimTask(
    taskId: string,
    input: JsonObject,
    expectedRevision: number,
  ): MaybeRevisioned<{ task: Task; run: Run }>;
  retryTask(
    taskId: string,
    input: JsonObject,
    expectedRevision: number,
  ): MaybeRevisioned<{ task: Task; run: Run }>;
  stopTask(
    taskId: string,
    input: JsonObject,
    expectedRevision: number,
  ): MaybeRevisioned<{ task: Task; run?: Run }>;
  verifyTask(
    taskId: string,
    input: JsonObject,
    expectedRevision: number,
  ): MaybeRevisioned<{ task: Task; verification: VerificationRecord }>;

  listSessions(workId: string): MaybeRevisioned<Session[]>;
  getSession(sessionId: string): MaybeRevisioned<Session>;
  listTranscript(sessionId: string, afterSequence: number): MaybeRevisioned<TranscriptMessage[]>;
  appendMessage(
    sessionId: string,
    message: JsonObject,
    expectedRevision: number,
  ): MaybeRevisioned<TranscriptMessage>;
}

export interface V3ApiServices {
  company: V3CompanyApi;
  work: V3WorkApi;
}
