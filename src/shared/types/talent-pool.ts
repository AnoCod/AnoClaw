// Talent pool — agent template library types
// Groups and templates stored in data/talent-pool/ as JSON files.

export enum TalentPoolTemplateSource {
  BuiltIn = 'builtin',
  Custom  = 'custom',
  GitHub  = 'github',
}

export interface TalentPoolGroup {
  id: string;
  name: string;
  icon: string;        // emoji icon for the group
  order: number;
  description: string;
}

export interface TalentPoolTemplate {
  id: string;
  groupId: string;
  name: string;
  description: string;
  role: 'Manager' | 'Member';   // default role when hired
  model: string;
  provider: string;
  agentPrompt: string;
  preferredLanguage: string;
  conversationLanguage: string;
  allowedTools: string[];
  enabledSkills: string[];
  tags: string[];
  source: TalentPoolTemplateSource;
  sourceUrl?: string;
  icon: string;                 // emoji icon
  starRating: number;           // 1-5
  createdAt: string;            // ISO8601
  updatedAt: string;
}

export interface HireTemplateRequest {
  templateId: string;
  parentAgentId: string;
  role: 'MainAgent' | 'Manager' | 'Member';
  name?: string;               // optional override
}

export interface SaveToPoolRequest {
  agentId: string;
  groupId: string;
  name?: string;
  description?: string;
}
