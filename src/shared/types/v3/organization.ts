export type CompanyLocale = 'zh-CN' | 'en-US';

export interface Company {
  id: string;
  name: string;
  description?: string;
  mainAgentId: string;
  rootTeamId: string;
  defaultLocale: CompanyLocale;
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  id: string;
  companyId: string;
  name: string;
  rootPath: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface Team {
  id: string;
  companyId: string;
  parentTeamId?: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export type TeamMembershipRole = 'leader' | 'member';

export interface TeamMembership {
  id: string;
  companyId: string;
  teamId: string;
  agentId: string;
  role: TeamMembershipRole;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
  removedAt?: string;
}

export type AgentStatus = 'active' | 'paused' | 'archived';

/**
 * A single persistent runtime agent. Credentials are referenced by identifier
 * and are deliberately never embedded in the domain model.
 */
export interface Agent {
  id: string;
  companyId: string;
  name: string;
  description?: string;
  instructions?: string;
  status: AgentStatus;
  provider?: string;
  model?: string;
  credentialRef?: string;
  capabilities: string[];
  enabledSkills: string[];
  allowedTools: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface CompanyProjection {
  company: Company | null;
  workspaces: Record<string, Workspace>;
  teams: Record<string, Team>;
  memberships: Record<string, TeamMembership>;
  agents: Record<string, Agent>;
  revision: number;
  updatedAt: string;
}
