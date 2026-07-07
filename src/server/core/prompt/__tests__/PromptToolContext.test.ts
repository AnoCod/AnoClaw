import { beforeEach, describe, expect, it } from 'vitest';
import { PromptAssembler } from '../PromptAssembler.js';
import { Tool } from '../../tools/Tool.js';
import { ToolRegistry } from '../../tools/ToolRegistry.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { Agent } from '../../agent/Agent.js';
import type { AgentConfigWithKey } from '../../agent/AgentConfig.js';
import { AgentRole, AgentState } from '../../../../shared/types/agent.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { BOUNDARY_MARKER } from '../../../../shared/constants.js';

class PromptProbeTool extends Tool {
  constructor(
    private readonly toolName: string,
    private readonly guide: string,
    private readonly userInteraction = false,
  ) {
    super();
  }

  name(): string { return this.toolName; }
  description(): string { return `${this.toolName} description`; }
  prompt(): string { return this.guide; }
  parametersSchema(): Record<string, unknown> {
    return { type: 'object', properties: {}, required: [] };
  }
  requiresUserInteraction(): boolean { return this.userInteraction; }
  isReadOnly(): boolean { return true; }
  async execute(_params: Record<string, unknown>, _ctx: ExecutionContext): Promise<ToolResult> {
    return {
      toolCallId: this.toolName,
      success: true,
      content: 'ok',
      tokensUsed: 0,
      startedAt: 0,
      finishedAt: 0,
      durationMs: 0,
      wasTruncated: false,
    };
  }
}

function makeConfig(overrides: Partial<AgentConfigWithKey> = {}): AgentConfigWithKey {
  return {
    id: overrides.id ?? 'agent-prompt-test',
    name: overrides.name ?? 'PromptAgent',
    role: overrides.role ?? AgentRole.Member,
    parentAgentId: overrides.parentAgentId ?? null,
    level: overrides.level ?? 1,
    teamName: overrides.teamName ?? '',
    provider: overrides.provider ?? 'cloud_api',
    apiUrl: overrides.apiUrl ?? '',
    apiKey: overrides.apiKey ?? 'sk-test',
    model: overrides.model ?? 'test-model',
    contextWindow: overrides.contextWindow ?? 128000,
    maxTurns: overrides.maxTurns ?? 0,
    temperature: overrides.temperature ?? 0.7,
    agentPrompt: overrides.agentPrompt ?? '',
    preferredLanguage: overrides.preferredLanguage ?? 'en',
    conversationLanguage: overrides.conversationLanguage ?? 'en',
    allowedTools: overrides.allowedTools ?? [],
    enabledSkills: overrides.enabledSkills ?? [],
    mcpServers: overrides.mcpServers ?? [],
    state: overrides.state ?? AgentState.Active,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

function registerAgent(config: Partial<AgentConfigWithKey>): Agent {
  const agent = new Agent(makeConfig(config));
  AgentRegistry.getInstance().registerAgent(agent);
  return agent;
}

describe('prompt tool context', () => {
  beforeEach(() => {
    AgentRegistry.resetInstance();
    ToolRegistry.resetInstance();
    PromptAssembler.getInstance().clearAllCaches();
  });

  it('uses run-scoped mode and hides user-interaction tools consistently', () => {
    const registry = ToolRegistry.getInstance();
    registry.registerTool(new PromptProbeTool('SafeProbeTool', 'SAFE_PROBE_GUIDE'), 'Testing');
    registry.registerTool(new PromptProbeTool('AskForInfoProbeTool', 'ASK_PROBE_GUIDE', true), 'Testing');
    registerAgent({
      allowedTools: ['SafeProbeTool', 'AskForInfoProbeTool', 'MissingProbeTool'],
    });

    const prompt = PromptAssembler.getInstance().buildEffectivePrompt(
      'agent-prompt-test',
      'session-prompt-test',
      undefined,
      { permissionMode: 'Auto', effort: 'HIGH', hideUserInteractionTools: true },
    );

    expect(prompt).toContain('You are in SAFE_AUTO mode');
    expect(prompt).toContain('Effort level: HIGH');
    expect(prompt).toContain('SafeProbeTool');
    expect(prompt).toContain('SAFE_PROBE_GUIDE');
    expect(prompt).not.toContain('AskForInfoProbeTool');
    expect(prompt).not.toContain('ASK_PROBE_GUIDE');
    expect(prompt).toContain('Configured but unavailable tools: MissingProbeTool');
  });

  it('shows user-interaction tools when the run context allows them', () => {
    const registry = ToolRegistry.getInstance();
    registry.registerTool(new PromptProbeTool('SafeProbeTool', 'SAFE_PROBE_GUIDE'), 'Testing');
    registry.registerTool(new PromptProbeTool('AskForInfoProbeTool', 'ASK_PROBE_GUIDE', true), 'Testing');
    registerAgent({
      allowedTools: ['SafeProbeTool', 'AskForInfoProbeTool'],
    });

    const prompt = PromptAssembler.getInstance().buildEffectivePrompt(
      'agent-prompt-test',
      'session-prompt-test',
      undefined,
      { permissionMode: 'Ask', effort: 'NORMAL', hideUserInteractionTools: false },
    );

    expect(prompt).toContain('You are in ASK mode');
    expect(prompt).toContain('AskForInfoProbeTool');
    expect(prompt).toContain('ASK_PROBE_GUIDE');
  });

  it('includes run-scoped capability tools without changing the agent allowlist', () => {
    const registry = ToolRegistry.getInstance();
    registry.registerTool(new PromptProbeTool('OfficeCreatePptx', 'OFFICE_PPTX_GUIDE'), 'Office');
    registerAgent({
      allowedTools: [],
    });

    const prompt = PromptAssembler.getInstance().buildEffectivePrompt(
      'agent-prompt-test',
      'session-prompt-test',
      undefined,
      { extraAllowedTools: ['OfficeCreatePptx'] },
    );

    expect(prompt).toContain('OfficeCreatePptx');
    expect(prompt).toContain('OFFICE_PPTX_GUIDE');
    expect(AgentRegistry.getInstance().agent('agent-prompt-test')?.allowedTools()).toEqual([]);
  });

  it('normalizes legacy underscore permission mode spelling in prompt context', () => {
    registerAgent({ allowedTools: [] });

    const prompt = PromptAssembler.getInstance().buildEffectivePrompt(
      'agent-prompt-test',
      'session-prompt-test',
      undefined,
      { permissionMode: 'auto_edit', effort: 'NORMAL' },
    );

    expect(prompt).toContain('You are in AUTO_EDIT mode');
  });

  it('uses the agent context window in token budget guidance', () => {
    registerAgent({
      contextWindow: 1048576,
      allowedTools: [],
    });

    const prompt = PromptAssembler.getInstance().buildEffectivePrompt(
      'agent-prompt-test',
      'session-prompt-test',
    );

    expect(prompt).toContain('Your context window is 1,048,576 tokens.');
    expect(prompt).not.toContain('Your context window is 200,000 tokens.');
  });

  it('normalizes delegation guidance to persistent child sessions', () => {
    registerAgent({
      id: 'main-agent-test',
      name: 'CEO',
      role: AgentRole.MainAgent,
      level: 0,
      allowedTools: [],
    });

    const prompt = PromptAssembler.getInstance().buildEffectivePrompt(
      'main-agent-test',
      'session-prompt-test',
    );

    expect(prompt).toContain('One parent-agent pair has one persistent child session');
    expect(prompt).toContain('TaskAssign starts or queues durable work');
    expect(prompt).toContain('AgentMessage is for mid-task clarification');
    expect(prompt).not.toContain('One agent = one active task');
  });

  it('assembles optimized role prompts without mojibake markers', () => {
    registerAgent({
      id: 'main-agent-test',
      name: 'CEO',
      role: AgentRole.MainAgent,
      level: 0,
      allowedTools: [],
    });

    const prompt = PromptAssembler.getInstance().buildEffectivePrompt(
      'main-agent-test',
      'session-prompt-test',
    );

    expect(prompt).toContain('## Multi-Agent Leadership');
    expect(prompt).toContain('You own the user outcome');
    expect(prompt).not.toMatch(/[鈥鈫鈼鉁鈿锟�]/);
  });

  it('keeps stable identity and capability sections before volatile session context', () => {
    const registry = ToolRegistry.getInstance();
    registry.registerTool(new PromptProbeTool('SafeProbeTool', 'SAFE_PROBE_GUIDE'), 'Testing');
    registerAgent({
      id: 'main-agent-test',
      name: 'CEO',
      role: AgentRole.MainAgent,
      level: 0,
      allowedTools: ['SafeProbeTool'],
    });

    const assembler = PromptAssembler.getInstance();
    const prompt = assembler.buildEffectivePrompt(
      'main-agent-test',
      'session-prompt-test',
      undefined,
      { permissionMode: 'Auto', effort: 'HIGH' },
    );
    const boundaryIndex = prompt.indexOf(BOUNDARY_MARKER);

    expect(boundaryIndex).toBeGreaterThan(0);
    expect(prompt.indexOf('One parent-agent pair has one persistent child session')).toBeLessThan(boundaryIndex);
    expect(prompt.indexOf('SAFE_PROBE_GUIDE')).toBeLessThan(boundaryIndex);
    expect(prompt.indexOf('# Available tools')).toBeLessThan(boundaryIndex);
    expect(prompt.indexOf('# Session Guidance')).toBeGreaterThan(boundaryIndex);
    expect(prompt.indexOf('# Permission Mode')).toBeGreaterThan(boundaryIndex);

    const stats = assembler.analyzePromptLayout(
      'main-agent-test',
      'session-prompt-test',
      { permissionMode: 'Auto', effort: 'HIGH' },
    );
    expect(stats.totalTokens).toBeGreaterThan(stats.cacheablePrefixTokens);
    expect(stats.cacheablePrefixTokens).toBeGreaterThan(0);
    expect(stats.cacheablePrefixRatio).toBeGreaterThan(0);

    const textStats = assembler.analyzePromptText(prompt);
    expect(textStats.cacheablePrefixTokens).toBe(stats.cacheablePrefixTokens);
    expect(textStats.volatileTokens).toBe(stats.volatileTokens);
  });
});
