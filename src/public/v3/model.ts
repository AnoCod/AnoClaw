import type {
  Agent,
  Company,
  CompanyEventEnvelope,
  Mission,
  Session,
  Task,
  Team,
  TeamMembership,
  TranscriptEntry,
  TranscriptMessage,
  VerificationCriterionResult,
  VerificationRecord,
  Work,
  WorkEventEnvelope,
  Workspace,
} from '../../shared/types/v3/index.js';

export type {
  Agent,
  Company,
  CompanyEventEnvelope,
  Mission,
  Session,
  Task,
  Team,
  TeamMembership,
  TranscriptEntry,
  TranscriptMessage,
  VerificationCriterionResult,
  VerificationRecord,
  Work,
  WorkEventEnvelope,
  Workspace,
};

export interface Revisioned<T> {
  data: T;
  revision: number;
}

export interface WorkDetail {
  missions: Mission[];
  tasks: Task[];
  sessions: Session[];
  transcript: TranscriptEntry[];
  events: WorkEventEnvelope[];
  verifications: VerificationRecord[];
  revision: number;
  transcriptRevision: number;
}

export interface ShellSnapshot {
  company: Company | null;
  companyRevision: number;
  workspaces: Workspace[];
  teams: Team[];
  memberships: TeamMembership[];
  agents: Agent[];
  works: Work[];
  worksRevision: number;
  companyEvents: CompanyEventEnvelope[];
}

export type ShellRoute = 'work' | 'company' | 'settings';
export type Locale = 'zh-CN' | 'en-US';
