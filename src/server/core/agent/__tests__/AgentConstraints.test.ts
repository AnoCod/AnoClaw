import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRegistry } from '../AgentRegistry.js';
import { Agent } from '../Agent.js';
import { defaultConfig } from '../AgentConfig.js';
import { hasMainAgentConflict, hierarchyValidationMessage, levelForRole, normalizeAgentHierarchy } from '../AgentConstraints.js';
import { AgentRole } from '../../../../shared/types/agent.js';

describe('hasMainAgentConflict', () => {
  beforeEach(() => {
    AgentRegistry.resetInstance();
  });

  it('allows the first MainAgent', () => {
    expect(hasMainAgentConflict('main', AgentRole.MainAgent)).toBe(false);
  });

  it('allows updating the existing MainAgent', () => {
    registerAgent('main', AgentRole.MainAgent);

    expect(hasMainAgentConflict('main', AgentRole.MainAgent)).toBe(false);
  });

  it('rejects a second MainAgent', () => {
    registerAgent('main', AgentRole.MainAgent);

    expect(hasMainAgentConflict('second-main', AgentRole.MainAgent)).toBe(true);
  });

  it('ignores non-MainAgent roles', () => {
    registerAgent('main', AgentRole.MainAgent);

    expect(hasMainAgentConflict('manager', AgentRole.Manager)).toBe(false);
  });
});

describe('agent hierarchy constraints', () => {
  beforeEach(() => {
    AgentRegistry.resetInstance();
  });

  it('allows CEO -> Manager -> Member', () => {
    registerAgent('ceo', AgentRole.MainAgent);
    registerAgent('manager', AgentRole.Manager, 'ceo');

    expect(hierarchyValidationMessage('manager', AgentRole.Manager, 'ceo')).toBeNull();
    expect(hierarchyValidationMessage('member', AgentRole.Member, 'manager')).toBeNull();
  });

  it('rejects Manager under Manager', () => {
    registerAgent('ceo', AgentRole.MainAgent);
    registerAgent('manager', AgentRole.Manager, 'ceo');

    expect(hierarchyValidationMessage('manager-2', AgentRole.Manager, 'manager')).toContain('Manager agents must report');
  });

  it('rejects Member under CEO or Member', () => {
    registerAgent('ceo', AgentRole.MainAgent);
    registerAgent('manager', AgentRole.Manager, 'ceo');
    registerAgent('member', AgentRole.Member, 'manager');

    expect(hierarchyValidationMessage('member-2', AgentRole.Member, 'ceo')).toContain('Member agents must report');
    expect(hierarchyValidationMessage('member-3', AgentRole.Member, 'member')).toContain('Member agents must report');
  });

  it('normalizes role levels and root CEO parent', () => {
    expect(levelForRole(AgentRole.MainAgent)).toBe(0);
    expect(levelForRole(AgentRole.Manager)).toBe(1);
    expect(levelForRole(AgentRole.Member)).toBe(2);

    expect(normalizeAgentHierarchy({
      role: AgentRole.MainAgent,
      parentAgentId: 'manager',
      level: 2,
    })).toMatchObject({ parentAgentId: null, level: 0 });
  });
});

describe('AgentRegistry descendants', () => {
  beforeEach(() => {
    AgentRegistry.resetInstance();
  });

  it('returns every descendant below a manager', () => {
    registerAgent('ceo', AgentRole.MainAgent);
    registerAgent('manager', AgentRole.Manager, 'ceo');
    registerAgent('member-a', AgentRole.Member, 'manager');
    registerAgent('member-b', AgentRole.Member, 'manager');

    expect(AgentRegistry.getInstance().descendantsOf('manager').map(a => a.id)).toEqual([
      'member-a',
      'member-b',
    ]);
    expect(AgentRegistry.getInstance().hasDescendants('manager')).toBe(true);
    expect(AgentRegistry.getInstance().hasDescendants('member-a')).toBe(false);
  });
});

function registerAgent(id: string, role: AgentRole, parentAgentId: string | null = null): void {
  const config = defaultConfig({
    id,
    name: id,
    role,
    parentAgentId,
    level: levelForRole(role),
    model: 'test-model',
    provider: 'openai-compatible',
    apiUrl: 'https://example.test',
    apiKey: 'test-key',
  });
  AgentRegistry.getInstance().registerAgent(new Agent(config));
}
