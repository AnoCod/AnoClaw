import type { EventActor } from './common.js';
import type {
  Agent,
  Company,
  Team,
  TeamMembership,
  Workspace,
} from './organization.js';
import type {
  CoordinationMessage,
  Mission,
  OrchestrationDecision,
  Run,
  Session,
  Task,
  TaskReport,
  ToolCallJournalRecord,
  VerificationRecord,
  Work,
  WorkspaceLeaseRecord,
} from './work.js';

export type CompanyEvent =
  | {
    type: 'company.bootstrapped';
    company: Company;
    rootTeam: Team;
    mainAgent: Agent;
    membership: TeamMembership;
  }
  | { type: 'company.created'; company: Company }
  | { type: 'company.updated'; company: Company }
  | { type: 'workspace.created'; workspace: Workspace }
  | { type: 'workspace.updated'; workspace: Workspace }
  | { type: 'workspace.archived'; workspace: Workspace }
  | { type: 'team.created'; team: Team }
  | { type: 'team.updated'; team: Team }
  | { type: 'team.archived'; team: Team }
  | { type: 'membership.added'; membership: TeamMembership }
  | { type: 'membership.updated'; membership: TeamMembership }
  | { type: 'membership.removed'; membership: TeamMembership }
  | { type: 'agent.created'; agent: Agent }
  | { type: 'agent.updated'; agent: Agent }
  | { type: 'agent.archived'; agent: Agent };

export type WorkEvent =
  | { type: 'work.created'; work: Work }
  | { type: 'work.updated'; work: Work }
  | { type: 'mission.created'; mission: Mission }
  | { type: 'mission.updated'; mission: Mission }
  | { type: 'task.created'; task: Task }
  | { type: 'task.updated'; task: Task }
  | { type: 'task.reported'; report: TaskReport }
  | { type: 'run.created'; run: Run }
  | { type: 'run.updated'; run: Run }
  | { type: 'session.created'; session: Session }
  | { type: 'session.updated'; session: Session }
  | { type: 'coordination.message.enqueued'; message: CoordinationMessage }
  | { type: 'coordination.message.updated'; message: CoordinationMessage }
  | { type: 'workspace.lease.acquired'; lease: WorkspaceLeaseRecord }
  | { type: 'workspace.lease.updated'; lease: WorkspaceLeaseRecord }
  | { type: 'orchestration.decision.recorded'; decision: OrchestrationDecision }
  | { type: 'verification.recorded'; verification: VerificationRecord }
  | { type: 'verification.updated'; verification: VerificationRecord }
  | { type: 'tool_call.journaled'; toolCall: ToolCallJournalRecord }
  | { type: 'tool_call.updated'; toolCall: ToolCallJournalRecord }
  | {
    type: 'execution.claimed';
    operation: 'claim' | 'retry';
    task: Task;
    run: Run;
    session: Session;
    decision: OrchestrationDecision;
  }
  | {
    type: 'execution.started';
    task: Task;
    run: Run;
    leases: WorkspaceLeaseRecord[];
  }
  | {
    type: 'execution.heartbeat';
    run: Run;
    leases: WorkspaceLeaseRecord[];
  }
  | {
    type: 'execution.terminal';
    task: Task;
    run: Run;
    session: Session;
    leases: WorkspaceLeaseRecord[];
    report?: TaskReport;
    decision?: OrchestrationDecision;
  }
  | {
    type: 'execution.verification_gated';
    task: Task;
    verification: VerificationRecord;
  };

export interface DomainEventEnvelope<TScopeType extends 'company' | 'work', TEvent> {
  schemaVersion: 3;
  eventId: string;
  scopeType: TScopeType;
  scopeId: string;
  revision: number;
  occurredAt: string;
  actor?: EventActor;
  correlationId?: string;
  causationId?: string;
  event: TEvent;
}

export type CompanyEventEnvelope = DomainEventEnvelope<'company', CompanyEvent>;
export type WorkEventEnvelope = DomainEventEnvelope<'work', WorkEvent>;

export interface ProjectionCheckpoint<TProjection> {
  schemaVersion: 3;
  scopeType: 'company' | 'work';
  scopeId: string;
  revision: number;
  lastEventId: string | null;
  updatedAt: string;
  projection: TProjection;
}
