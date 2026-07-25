// Durable multi-agent coordination contracts shared by server and frontend.

export type TeamState = 'forming' | 'active' | 'draining' | 'disbanded';
export type CoordinationTaskMode = 'hierarchy' | 'swarm' | 'subagent';
export type CoordinationTaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type CoordinationTaskStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';
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
  | 'acknowledged'
  | 'dead_letter';

export interface TeamRecord {
  id: string;
  rootSessionId: string;
  name: string;
  purpose: string;
  leaderAgentId: string;
  memberAgentIds: string[];
  state: TeamState;
  createdByAgentId: string;
  autoCreated: boolean;
  autoDisband: boolean;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface CoordinationTask {
  id: string;
  rootSessionId: string;
  sourceSessionId: string;
  teamId?: string;
  mode: CoordinationTaskMode;
  subject: string;
  description: string;
  acceptanceCriteria: string[];
  priority: CoordinationTaskPriority;
  creatorAgentId: string;
  assigneeAgentId?: string;
  dependsOn: string[];
  readOnly: boolean;
  /** Normalized workspace-relative path prefixes. "." means the full workspace. */
  writeScope: string[];
  status: CoordinationTaskStatus;
  version: number;
  attempt: number;
  maxAttempts: number;
  sessionId?: string;
  heartbeatAt?: string;
  progress?: number;
  currentTool?: string;
  blocker?: string;
  resultSummary?: string;
  outputRef?: string;
  evidence?: string[];
  tokenUsage?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface CoordinationMessage {
  id: string;
  rootSessionId: string;
  teamId?: string;
  taskId?: string;
  fromAgentId: string;
  toAgentId: string;
  kind: CoordinationMessageKind;
  content: string;
  summary?: string;
  sequence: number;
  status: CoordinationMessageStatus;
  createdAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
  error?: string;
}

export interface WorkspaceLease {
  id: string;
  rootSessionId: string;
  taskId: string;
  agentId: string;
  workspace: string;
  scopes: string[];
  acquiredAt: string;
  expiresAt: string;
}

export type CoordinationEventType =
  | 'team_created'
  | 'team_updated'
  | 'team_disbanded'
  | 'task_created'
  | 'task_updated'
  | 'message_queued'
  | 'message_updated'
  | 'lease_acquired'
  | 'lease_renewed'
  | 'lease_released'
  | 'workspace_conflict';

export interface CoordinationEvent<T = Record<string, unknown>> {
  schemaVersion: 1;
  eventId: string;
  rootSessionId: string;
  revision: number;
  type: CoordinationEventType;
  timestamp: string;
  actorAgentId?: string;
  idempotencyKey?: string;
  payload: T;
}

export interface CoordinationSnapshot {
  schemaVersion: 1;
  rootSessionId: string;
  revision: number;
  teams: TeamRecord[];
  tasks: CoordinationTask[];
  messages: CoordinationMessage[];
  leases: WorkspaceLease[];
  /** Rebuildable deduplication index retained in the projection cache. */
  idempotencyKeys?: string[];
}

export interface TaskPacket {
  taskId: string;
  rootSessionId: string;
  teamId?: string;
  sourceSessionId: string;
  sourceAgentId: string;
  goal: string;
  description: string;
  acceptanceCriteria: string[];
  constraints: string[];
  parentContext: string[];
  dependencyResults: Array<{
    taskId: string;
    subject: string;
    resultSummary?: string;
    outputRef?: string;
    evidence?: string[];
  }>;
  workspace: string;
  teamRoster: string[];
  readOnly: boolean;
  writeScope: string[];
  allowedTools: string[];
}
