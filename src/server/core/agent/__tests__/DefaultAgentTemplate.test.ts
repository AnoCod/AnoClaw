import { describe, expect, it } from 'vitest';
import { DEFAULT_MAIN_AGENT_ID } from '../../../../shared/constants.js';
import { AgentRole } from '../../../../shared/types/agent.js';
import {
  buildDefaultAgentConfigs,
  DEFAULT_ENGINEERING_MANAGER_ID,
  DEFAULT_IMPLEMENTATION_MEMBER_ID,
} from '../DefaultAgentTemplate.js';

describe('buildDefaultAgentConfigs', () => {
  it('creates a runnable CEO -> Manager -> Member organization by default', () => {
    const configs = buildDefaultAgentConfigs({
      agentName: 'MainAgent',
      provider: 'openai-compatible',
      apiUrl: 'https://api.example.test/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      contextWindow: 200000,
      now: '2026-07-07T00:00:00.000Z',
    });

    expect(configs.map((config) => config.id)).toEqual([
      DEFAULT_MAIN_AGENT_ID,
      DEFAULT_ENGINEERING_MANAGER_ID,
      DEFAULT_IMPLEMENTATION_MEMBER_ID,
    ]);
    expect(configs.map((config) => config.role)).toEqual([
      AgentRole.MainAgent,
      AgentRole.Manager,
      AgentRole.Member,
    ]);
    expect(configs[0].parentAgentId).toBeNull();
    expect(configs[1].parentAgentId).toBe(DEFAULT_MAIN_AGENT_ID);
    expect(configs[2].parentAgentId).toBe(DEFAULT_ENGINEERING_MANAGER_ID);
    expect(configs.map((config) => config.level)).toEqual([0, 1, 2]);
  });

  it('preselects coordination, memory, skill, browser, and implementation tools', () => {
    const [ceo, manager, member] = buildDefaultAgentConfigs({
      provider: 'openai-compatible',
      apiUrl: 'https://api.example.test/v1',
      apiKey: 'sk-test',
      model: 'test-model',
    });

    expect(ceo.allowedTools).toEqual(expect.arrayContaining([
      'RunProgram',
      'TaskAssign',
      'ListEmployees',
      'memory_save',
      'memory_search',
      'Skill',
      'skill_matching',
      'Browser',
      'ApiCall',
      'office.create_pptx',
      'office.create_docx',
      'office.analyze_spreadsheet',
      'pdf.summarize',
      'web.research',
      'files.organize',
    ]));
    expect(manager.allowedTools).toContain('TaskAssign');
    expect(manager.allowedTools).toContain('RunProgram');
    expect(manager.allowedTools).toContain('HireEmployee');
    expect(member.allowedTools).toContain('SubAgentSpawn');
    expect(member.allowedTools).toContain('RunProgram');
    expect(member.allowedTools).not.toContain('HireEmployee');
  });

  it('enables focused default skills instead of leaving skills blank', () => {
    const [ceo, manager, member] = buildDefaultAgentConfigs({
      provider: 'openai-compatible',
      apiUrl: 'https://api.example.test/v1',
      apiKey: 'sk-test',
      model: 'test-model',
    });

    expect(ceo.enabledSkills).toEqual(expect.arrayContaining([
      'writing-plans',
      'project-management',
      'systematic-debugging',
      'verification-before-completion',
    ]));
    expect(manager.enabledSkills.length).toBeGreaterThan(0);
    expect(member.enabledSkills).toEqual(expect.arrayContaining([
      'test-driven-development',
      'code-review',
    ]));
  });
});
