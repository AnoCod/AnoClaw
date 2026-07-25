import type { JsonObject } from './common.js';

export type WorkStatus =
  | 'draft'
  | 'active'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'archived';

export interface Work {
  id: string;
  companyId: string;
  workspaceId?: string;
  primarySessionId: string;
  focusMissionId?: string;
  title: string;
  objective: string;
  status: WorkStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  archivedAt?: string;
}

export type MissionStatus =
  | 'planned'
  | 'active'
  | 'blocked'
  | 'completed'
  | 'cancelled';

export type WorkPriority = 'low' | 'normal' | 'high' | 'critical';

export interface VerificationPolicy {
  mode: 'automatic' | 'independent_agent' | 'user';
  reviewerAgentId?: string;
  requireDifferentAgent: boolean;
  maxRevisionAttempts: number;
  requiredEvidence: string[];
}

export interface Mission {
  id: string;
  workId: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  priority: WorkPriority;
  verificationPolicy: VerificationPolicy;
  status: MissionStatus;
  teamId?: string;
  ownerAgentId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'claimed'
  | 'running'
  | 'submitted'
  | 'verifying'
  | 'revision_required'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskPriority = WorkPriority;

export interface Task {
  id: string;
  workId: string;
  missionId: string;
  title: string;
  description?: string;
  acceptanceCriteria: string[];
  status: TaskStatus;
  priority: TaskPriority;
  teamId?: string;
  assignedAgentId?: string;
  dependsOnTaskIds: string[];
  readOnly: boolean;
  writeScope: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  dueAt?: string;
  completedAt?: string;
}

export type RunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'recovery_required';

export type RunTerminationReason =
  | 'completed'
  | 'max_turns'
  | 'timeout'
  | 'error'
  | 'cancelled'
  | 'interrupted';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface RunCost {
  currency: 'USD';
  amount: number;
  estimated: boolean;
}

export type WorkspaceExecution =
  | { mode: 'none' }
  | {
    mode: 'lease';
    workspaceId: string;
    leaseIds: string[];
    writeScope: string[];
  }
  | {
    mode: 'git_worktree';
    workspaceId: string;
    integrationBranch: string;
    taskBranch: string;
    worktreePath: string;
    baselineHead: string;
    commit?: string;
  };

export interface Run {
  id: string;
  workId: string;
  missionId: string;
  taskId: string;
  agentId: string;
  sessionId: string;
  status: RunStatus;
  attempt: number;
  maxTurns: number;
  turnsConsumed: number;
  heartbeatAt?: string;
  fencingToken: number;
  lastCompletedToolCallId?: string;
  tokenUsage: TokenUsage;
  cost: RunCost;
  toolCount: number;
  workspaceExecution: WorkspaceExecution;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  terminationReason?: RunTerminationReason;
  resultSummary?: string;
  error?: string;
}

export type SessionKind = 'primary' | 'run';
export type SessionStatus = 'active' | 'idle' | 'closed';

export interface SessionActorSnapshot {
  agentId: string;
  name: string;
  teamId?: string;
  instructions?: string;
  provider?: string;
  model?: string;
  capabilities: string[];
  enabledSkills: string[];
  allowedTools: string[];
}

/**
 * A Session is only a transcript boundary. Primary sessions belong directly
 * to Work, while run sessions snapshot one Agent actor and may point at a
 * Mission/Task/Run lineage. Work and orchestration state never live here.
 */
export interface Session {
  id: string;
  workId: string;
  kind: SessionKind;
  missionId?: string;
  taskId?: string;
  runId?: string;
  parentSessionId?: string;
  agentId: string;
  actorSnapshot: SessionActorSnapshot;
  status: SessionStatus;
  transcriptRevision: number;
  createdAt: string;
  closedAt?: string;
}

export type TaskReportOutcome =
  | 'submitted'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'revision_required'
  | 'cancelled';

export interface TaskReport {
  id: string;
  taskId: string;
  runId?: string;
  agentId: string;
  outcome: TaskReportOutcome;
  summary: string;
  details?: string;
  artifacts: string[];
  createdAt: string;
}

export type CoordinationMessageKind =
  | 'note'
  | 'steer'
  | 'task_assignment'
  | 'task_update'
  | 'task_result'
  | 'shutdown';

export type CoordinationMessageStatus =
  | 'queued'
  | 'delivered'
  | 'consumed'
  | 'acknowledged'
  | 'dead_letter';

/**
 * Durable, ordered Agent-to-Agent delivery. A message is appended to a target
 * inbox once, may be consumed by several attempted turns after a crash, and is
 * acknowledged only by the turn that completed.
 */
export interface CoordinationMessage {
  id: string;
  workId: string;
  teamId?: string;
  taskId?: string;
  senderAgentId: string;
  recipientAgentId: string;
  recipientSessionId?: string;
  kind: CoordinationMessageKind;
  content: string;
  summary?: string;
  sequence: number;
  idempotencyKey: string;
  status: CoordinationMessageStatus;
  deliveryAttempts: number;
  consumingTurnId?: string;
  createdAt: string;
  deliveredAt?: string;
  consumedAt?: string;
  acknowledgedAt?: string;
  deadLetteredAt?: string;
  lastError?: string;
}

export type WorkspaceLeaseStatus = 'active' | 'released' | 'expired';

/**
 * A pessimistic write lease. writeScope contains normalized, workspace-relative
 * POSIX-style path prefixes. "." represents the entire Workspace.
 */
export interface WorkspaceLeaseRecord {
  id: string;
  workId: string;
  workspaceId: string;
  writeScope: string[];
  ownerRunId: string;
  ownerTaskId: string;
  ownerAgentId: string;
  fencingToken: number;
  status: WorkspaceLeaseStatus;
  acquiredAt: string;
  expiresAt: string;
  renewedAt?: string;
  releasedAt?: string;
  releaseReason?: string;
}

export type OrchestrationDecisionKind =
  | 'strategy'
  | 'assignment'
  | 'capacity'
  | 'dependency'
  | 'retry'
  | 'recovery';

export interface OrchestrationDecision {
  id: string;
  workId: string;
  missionId?: string;
  taskId?: string;
  runId?: string;
  kind: OrchestrationDecisionKind;
  decision: string;
  reason: string;
  candidateAgentIds: string[];
  selectedAgentId?: string;
  inputs?: JsonObject;
  createdAt: string;
}

export type VerificationOutcome =
  | 'pending'
  | 'approved'
  | 'revision_required'
  | 'rejected';

export interface VerificationCriterionResult {
  criterion: string;
  passed: boolean;
  evidence: string[];
  note?: string;
}

export interface VerificationRecord {
  id: string;
  workId: string;
  missionId: string;
  taskId: string;
  runId: string;
  mode: VerificationPolicy['mode'];
  workerAgentId: string;
  reviewerAgentId?: string;
  outcome: VerificationOutcome;
  summary: string;
  criteria: VerificationCriterionResult[];
  revisionAttempt: number;
  createdAt: string;
  completedAt?: string;
}

export type ToolCallJournalStatus =
  | 'prepared'
  | 'started'
  | 'finished'
  | 'transcript_committed';

export type ToolCallRecoveryStatus =
  | 'start_pending'
  | 'replayable'
  | 'recovery_required'
  | 'result_pending_commit'
  | 'committed';

/**
 * The durable write-ahead journal for one tool call. An interrupted write in
 * `started` is deliberately projected as `recovery_required`; it is never
 * silently replayed after restart.
 */
export interface ToolCallJournalRecord {
  id: string;
  workId: string;
  missionId: string;
  taskId: string;
  runId: string;
  sessionId: string;
  agentId: string;
  toolCallId: string;
  toolName: string;
  readOnly: boolean;
  writeScope: string[];
  idempotencyKey: string;
  status: ToolCallJournalStatus;
  recoveryStatus: ToolCallRecoveryStatus;
  preparedAt: string;
  startedAt?: string;
  finishedAt?: string;
  transcriptCommittedAt?: string;
  resultRef?: string;
  error?: string;
  processId?: number;
}

export type TranscriptRole = 'user' | 'assistant' | 'system' | 'tool';

export interface TranscriptMessage {
  kind: 'message';
  id: string;
  role: TranscriptRole;
  content: string;
  agentId?: string;
  toolCallId?: string;
  toolName?: string;
  metadata?: JsonObject;
}

export interface TranscriptEvent {
  kind: 'event';
  id: string;
  eventType: string;
  data: JsonObject;
}

export type TranscriptEntry = TranscriptMessage | TranscriptEvent;

export interface SessionTranscriptRecord {
  schemaVersion: 3;
  sessionId: string;
  sequence: number;
  entryId: string;
  occurredAt: string;
  entry: TranscriptEntry;
}

export interface WorkProjection {
  work: Work | null;
  missions: Record<string, Mission>;
  tasks: Record<string, Task>;
  runs: Record<string, Run>;
  sessions: Record<string, Session>;
  taskReports: Record<string, TaskReport>;
  coordinationMessages: Record<string, CoordinationMessage>;
  coordinationMessageOrder: string[];
  workspaceLeases: Record<string, WorkspaceLeaseRecord>;
  orchestrationDecisions: Record<string, OrchestrationDecision>;
  verificationRecords: Record<string, VerificationRecord>;
  toolCallJournal: Record<string, ToolCallJournalRecord>;
  revision: number;
  updatedAt: string;
}
