import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { HireEmployeeTool } from '../builtin/HireEmployeeTool.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { AgentRole } from '../../../../shared/types/agent.js';
import type { Agent } from '../../agent/Agent.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

const ctx: ExecutionContext = {
  sessionId: 'hire-session',
  agentId: 'manager-agent',
  workspace: process.cwd(),
  userConfirmed: true,
};

function parentAgent() {
  return {
    id: 'manager-agent',
    name: 'Engineering Manager',
    role: AgentRole.Manager,
    roleString: 'Manager',
    parentAgentId: 'main-agent',
    level: 1,
    teamName: 'Engineering',
    provider: 'openai-compatible',
    apiUrl: 'https://api.example.test',
    apiKey: 'secret',
    modelName: 'parent-model',
    contextWindow: 200000,
    maxTurns: 25,
    temperature: 0.4,
    preferredLanguage: 'zh',
    conversationLanguage: 'zh',
    isActive: true,
    isManagerRole: () => true,
    allowedTools: () => ['Read', 'Glob', 'Grep'],
  };
}

describe('HireEmployeeTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    AgentRegistry.resetInstance();
  });

  it('rejects invalid structured params before touching AgentRegistry', async () => {
    vi.spyOn(AgentRegistry, 'getInstance').mockImplementation(() => {
      throw new Error('AgentRegistry should not be touched for invalid HireEmployee params');
    });

    const badTools = await new HireEmployeeTool().execute({
      name: 'QA Tester',
      role: 'Member',
      parentAgentId: 'manager-agent',
      agentPrompt: 'You test changes.',
      reason: 'Durable QA coverage',
      allowedTools: 'Read',
    }, ctx);
    expect(badTools.success).toBe(false);
    expect(badTools.errorMessage).toContain('allowedTools must be an array of strings');

    const badRole = await new HireEmployeeTool().execute({
      name: 'QA Tester',
      role: 'SubAgent',
      parentAgentId: 'manager-agent',
      agentPrompt: 'You test changes.',
      reason: 'Durable QA coverage',
    }, ctx);
    expect(badRole.success).toBe(false);
    expect(badRole.errorMessage).toContain('role must be one of');
  });

  it('normalizes durable employee config before registering and saving', async () => {
    let registeredAgent: Agent | null = null;
    vi.spyOn(AgentRegistry, 'getInstance').mockReturnValue({
      findAgent: vi.fn(() => parentAgent()),
      registerAgent: vi.fn((agent: Agent) => { registeredAgent = agent; }),
      unregisterAgent: vi.fn(),
      saveAgent: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentRegistry);
    vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
    vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);

    const result = await new HireEmployeeTool().execute({
      name: '  QA Tester  ',
      role: 'Member',
      parentAgentId: ' manager-agent ',
      model: '  cheaper-model  ',
      agentPrompt: '  You test changes and report clear failures.  ',
      teamName: '   ',
      reason: '  Need durable regression coverage.  ',
      allowedTools: [' Read ', 'Read', 'Grep', ' Bash '],
      enabledSkills: [' code-review ', 'code-review'],
      mcpServers: [' local-rag ', 'local-rag'],
    }, ctx);

    expect(result.success).toBe(true);
    expect(registeredAgent).not.toBeNull();
    const config = registeredAgent!.toConfig();
    expect(config).toMatchObject({
      name: 'QA Tester',
      role: AgentRole.Member,
      parentAgentId: 'manager-agent',
      level: 2,
      teamName: 'Engineering',
      model: 'cheaper-model',
      agentPrompt: 'You test changes and report clear failures.',
      allowedTools: ['Read', 'Grep', 'Bash'],
      enabledSkills: ['code-review'],
      mcpServers: ['local-rag'],
    });
    expect(result.structured).toMatchObject({
      name: 'QA Tester',
      role: 'Member',
      parentAgentId: 'manager-agent',
      teamName: 'Engineering',
      allowedTools: ['Read', 'Grep', 'Bash'],
      enabledSkills: ['code-review'],
      mcpServers: ['local-rag'],
      inheritedModel: false,
    });
  });
});
