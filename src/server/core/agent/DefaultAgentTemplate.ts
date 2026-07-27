import type { AgentConfig } from '../../../shared/types/agent.js';
import { AgentRole, AgentState } from '../../../shared/types/agent.js';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAIN_AGENT_ID } from '../../../shared/constants.js';
import { defaultConfig, type AgentConfigWithKey } from './AgentConfig.js';

export const DEFAULT_ENGINEERING_MANAGER_ID = 'manager-engineering';
export const DEFAULT_IMPLEMENTATION_MEMBER_ID = 'member-implementation';

export const DEFAULT_CORE_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'Bash',
  'RunProgram',
  'WebFetch',
  'WebSearch',
  'Browser',
  'TodoWrite',
  'Plan',
  'EnterPlanMode',
  'ExitPlanMode',
  'memory_search',
  'memory_recall',
  'memory_save',
  'SkillList',
  'skill_matching',
  'SkillInspect',
  'Skill',
];

export const DEFAULT_COORDINATION_TOOLS = [
  'Team',
  'Task',
  'AgentMessage',
  'JobList',
  'JobOutput',
  'JobStop',
];

export const DEFAULT_CEO_TOOLS = [
  ...DEFAULT_CORE_TOOLS,
  ...DEFAULT_COORDINATION_TOOLS,
  'AskUserQuestion',
  'Organization',
  'ApiCall',
];

export const DEFAULT_MANAGER_TOOLS = [
  ...DEFAULT_CORE_TOOLS,
  ...DEFAULT_COORDINATION_TOOLS,
  'Organization',
];

export const DEFAULT_MEMBER_TOOLS = [
  ...DEFAULT_CORE_TOOLS,
  ...DEFAULT_COORDINATION_TOOLS,
];

const LEGACY_COORDINATION_TOOLS = new Set([
  'TeamCreate',
  'TeamUpdate',
  'TeamStatus',
  'TeamDelete',
  'TaskCreate',
  'TaskAssign',
  'TaskClaim',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'AgentMessage',
  'SubAgentSpawn',
  'SubAgentDelete',
]);

const LEGACY_ORGANIZATION_TOOLS = new Set([
  'ListEmployees',
  'HireEmployee',
  'UpdateOrg',
]);

/**
 * Replace the legacy verb-per-operation coordination surface with the compact
 * Organization, Team, Task, and AgentMessage tools. Restricted allowlists stay
 * restricted unless they previously opted into the corresponding tool family.
 */
export function migrateCoordinationToolAllowlist(
  config: AgentConfigWithKey,
): { config: AgentConfigWithKey; changed: boolean } {
  const hadLegacyCoordination = config.allowedTools.some(
    (name) => LEGACY_COORDINATION_TOOLS.has(name),
  );
  const hadLegacyOrganization = config.allowedTools.some(
    (name) => name === 'ListEmployees'
      || name === 'HireEmployee'
      || (name === 'UpdateOrg' && config.role === AgentRole.MainAgent),
  );
  const baseTools = config.allowedTools.filter(
    (name) => !LEGACY_COORDINATION_TOOLS.has(name)
      && !LEGACY_ORGANIZATION_TOOLS.has(name),
  );
  const allowedTools = [...new Set([
    ...baseTools,
    ...(hadLegacyCoordination ? DEFAULT_COORDINATION_TOOLS : []),
    ...(hadLegacyOrganization ? ['Organization'] : []),
  ])];
  const agentPrompt = migrateLegacyCoordinationPrompt(config.agentPrompt);
  const changed = allowedTools.length !== config.allowedTools.length
    || allowedTools.some((name, index) => name !== config.allowedTools[index])
    || agentPrompt !== config.agentPrompt;
  return {
    config: changed ? { ...config, allowedTools, agentPrompt } : config,
    changed,
  };
}

function migrateLegacyCoordinationPrompt(prompt: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/\bListEmployees\b/g, 'Organization action="list"'],
    [/\bHireEmployee\b/g, 'Organization action="hire"'],
    [/\bUpdateOrg\b/g, 'Organization action="reassign"'],
    [/\bTeamCreate\b/g, 'Team action="create"'],
    [/\bTeamUpdate\b/g, 'Team action="update"'],
    [/\bTeamStatus\b/g, 'Team action="status"'],
    [/\bTeamDelete\b/g, 'Team action="delete"'],
    [/\bTaskCreate\b/g, 'Task action="create"'],
    [/\bTaskAssign\b/g, 'Task action="assign"'],
    [/\bTaskClaim\b/g, 'Task action="claim"'],
    [/\bTaskUpdate\b/g, 'Task action="update"'],
    [/\bTaskGet\b/g, 'Task action="output"'],
    [/\bTaskList\b/g, 'Task action="list"'],
    [/\bTaskOutput\b/g, 'Task action="output"'],
    [/\bTaskStop\b/g, 'Task action="stop"'],
    [/\bSubAgentSpawn\b/g, 'Task action="spawn"'],
  ];
  return replacements.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    prompt,
  );
}

export const DEFAULT_CEO_SKILLS = [
  'writing-plans',
  'project-management',
  'systematic-debugging',
  'test-driven-development',
  'verification-before-completion',
  'code-review',
  'web-research',
  'browser-control',
];

export const DEFAULT_MANAGER_SKILLS = [
  'writing-plans',
  'project-management',
  'systematic-debugging',
  'verification-before-completion',
  'code-review',
];

export const DEFAULT_MEMBER_SKILLS = [
  'systematic-debugging',
  'test-driven-development',
  'verification-before-completion',
  'code-review',
  'web-research',
];

export interface DefaultAgentTemplateOptions {
  agentName?: string;
  provider: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  contextWindow?: number;
  now?: string;
}

function commonConfig(options: DefaultAgentTemplateOptions, createdAt: string): Pick<AgentConfigWithKey,
  'provider' | 'apiUrl' | 'apiKey' | 'model' | 'contextWindow' | 'maxTurns' | 'temperature' |
  'preferredLanguage' | 'conversationLanguage' | 'mcpServers' | 'state' | 'createdAt'
> {
  return {
    provider: options.provider || 'openai-compatible',
    apiUrl: options.apiUrl || '',
    apiKey: options.apiKey || '',
    model: options.model || '',
    contextWindow: Number(options.contextWindow) || DEFAULT_CONTEXT_WINDOW,
    maxTurns: 0,
    temperature: 0.7,
    preferredLanguage: 'en',
    conversationLanguage: 'zh',
    mcpServers: [],
    state: AgentState.Active,
    createdAt,
  };
}

export function defaultCeoPrompt(agentName = 'MainAgent'): string {
  return [
    `# ${agentName} - AnoClaw CEO`,
    '',
    '## Identity',
    `You are ${agentName}. You run on AnoClaw; it is the platform, not your name.`,
    'Own the user outcome, keep the current goal in focus, and coordinate specialist agents when delegation improves quality, speed, or coverage.',
    '',
    '## Operating Loop',
    '- Clarify only when genuinely blocked; otherwise make a reasonable plan and execute.',
    '- Before tool use, identify the shortest useful path and avoid redundant exploration.',
    '- Use TodoWrite or Plan for multi-step work, and verify completion before reporting.',
    '- Preserve durable project preferences, decisions, and lessons with memory tools.',
    '',
    '## Delegation',
    '- Organization manages the durable roster through list, hire, and reassign actions.',
    '- Team manages only the temporary collaboration team for the current root session.',
    '- Use the default Engineering Manager for substantial implementation, review, or investigation work.',
    '- Delegate with concrete goal, scope, constraints, acceptance criteria, and verification requirements.',
    '- Use AgentMessage for direct notes, live steering, active-Team broadcast, or MainAgent organization-wide communication instead of creating duplicate assignments.',
    '- Review delegated results before reporting to the user.',
    '',
    '## Communication',
    '- Match the user-facing language preference.',
    '- Keep code, comments, tool parameters, memories, and agent-to-agent messages in English unless the deliverable itself requires another language.',
  ].join('\n');
}

export function defaultManagerPrompt(): string {
  return [
    '# Engineering Manager - AnoClaw',
    '',
    'Lead implementation work for the CEO. Break work into clear execution steps, delegate narrow leaf tasks to members when useful, and return verified results.',
    '',
    'Use Organization action="list" before delegation. Organization action="hire" adds a durable Member; Team only selects existing employees for the current root session.',
    '',
    'Use memory and skills before unfamiliar work. Prefer direct file/search tools over broad shell probing. Keep task status concise and actionable.',
  ].join('\n');
}

export function defaultMemberPrompt(): string {
  return [
    '# Implementation Specialist - AnoClaw',
    '',
    'Execute focused engineering tasks with careful file inspection, minimal tool calls, and concrete verification. Report what changed, what was tested, and any residual risk.',
    '',
    'Use specialized skills for debugging, TDD, review, browser/web research, and verification when relevant.',
  ].join('\n');
}

export function buildDefaultAgentConfigs(options: DefaultAgentTemplateOptions): AgentConfigWithKey[] {
  const createdAt = options.now || new Date().toISOString();
  const common = commonConfig(options, createdAt);
  const agentName = options.agentName || 'MainAgent';

  return [
    defaultConfig({
      ...common,
      id: DEFAULT_MAIN_AGENT_ID,
      name: agentName,
      role: AgentRole.MainAgent,
      parentAgentId: null,
      level: 0,
      teamName: 'Executive',
      agentPrompt: defaultCeoPrompt(agentName),
      allowedTools: DEFAULT_CEO_TOOLS,
      enabledSkills: DEFAULT_CEO_SKILLS,
    }),
    defaultConfig({
      ...common,
      id: DEFAULT_ENGINEERING_MANAGER_ID,
      name: 'Engineering Manager',
      role: AgentRole.Manager,
      parentAgentId: DEFAULT_MAIN_AGENT_ID,
      level: 1,
      teamName: 'Engineering',
      agentPrompt: defaultManagerPrompt(),
      allowedTools: DEFAULT_MANAGER_TOOLS,
      enabledSkills: DEFAULT_MANAGER_SKILLS,
    }),
    defaultConfig({
      ...common,
      id: DEFAULT_IMPLEMENTATION_MEMBER_ID,
      name: 'Implementation Specialist',
      role: AgentRole.Member,
      parentAgentId: DEFAULT_ENGINEERING_MANAGER_ID,
      level: 2,
      teamName: 'Engineering',
      agentPrompt: defaultMemberPrompt(),
      allowedTools: DEFAULT_MEMBER_TOOLS,
      enabledSkills: DEFAULT_MEMBER_SKILLS,
    }),
  ];
}

export function toSafeAgentConfig(config: AgentConfigWithKey): AgentConfig {
  const { apiKey: _apiKey, ...safeConfig } = config;
  return safeConfig;
}
