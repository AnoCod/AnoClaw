// Agent identity, configuration, and runtime types

export enum AgentRole {
  MainAgent = 'MainAgent',
  Manager   = 'Manager',
  Member    = 'Member',
  SubAgent  = 'SubAgent',
}

export enum AgentState {
  Active    = 'Active',
  Idle      = 'Idle',
  Destroyed = 'Destroyed',
}

export enum AgentStatus {
  Working     = 'Working',
  WaitingTool = 'WaitingTool',
  Paused      = 'Paused',
  Error       = 'Error',
}

export enum OrgRole {
  Manager = 'Manager',
  Member  = 'Member',
}

export interface AgentConfig {
  id: string;
  name: string;
  role: AgentRole;
  parentAgentId: string | null;
  level: number;
  teamName: string;
  provider: string;
  apiUrl: string;
  // apiKey intentionally omitted from shared types — security: server manages keys internally
  model: string;
  contextWindow: number;
  agentPrompt: string;
  preferredLanguage: string;   // 'zh' | 'en'
  conversationLanguage: string;// 'zh' | 'en'
  allowedTools: string[];
  enabledSkills: string[];
  mcpServers: string[];
  state: AgentState;
  createdAt: string;           // ISO8601
  /** Maximum turns per ReAct loop (default: 25). */
  maxTurns?: number;
  /** LLM temperature (default: 0.7). */
  temperature?: number;
}

export interface OrgNode {
  agentId: string;
  parentAgentId: string | null;
  level: number;
  orgRole: OrgRole;
  teamName: string;
  reportChain: string[];
  children: OrgNode[];
}

export interface SubAgentConfig {
  description: string;
  prompt: string;
  subagent_type: 'Explore' | 'Plan' | 'general-purpose';
  model?: string;
  run_in_background?: boolean;
  /** Keep the SubAgent alive for reuse (default: false). */
  persist?: boolean;
  /** Time-to-live in milliseconds after last use (default: 3600000 = 1 hour). */
  ttl?: number;
}
