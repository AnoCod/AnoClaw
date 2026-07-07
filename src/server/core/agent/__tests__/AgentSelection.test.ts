import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRegistry } from '../AgentRegistry.js';
import { Agent } from '../Agent.js';
import { defaultConfig } from '../AgentConfig.js';
import { selectRunnableAgent } from '../AgentSelection.js';
import { AgentRole, AgentState } from '../../../../shared/types/agent.js';

describe('selectRunnableAgent', () => {
  beforeEach(() => {
    AgentRegistry.resetInstance();
  });

  it('returns an actionable error when no agents are configured', () => {
    const result = selectRunnableAgent();

    expect(result.ok).toBe(false);
    expect(result.agentId).toBeUndefined();
    expect(result.message).toContain('No agents are configured');
  });

  it('returns an actionable error when a requested agent is missing', () => {
    registerAgent('main', AgentRole.MainAgent);

    const result = selectRunnableAgent('missing-agent');

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Agent 'missing-agent' is not configured");
  });

  it('uses the requested agent when it exists', () => {
    registerAgent('main', AgentRole.MainAgent);
    registerAgent('member-1', AgentRole.Member);

    const result = selectRunnableAgent('member-1');

    expect(result).toEqual({ ok: true, agentId: 'member-1' });
  });

  it('prefers MainAgent for default selection', () => {
    registerAgent('member-1', AgentRole.Member);
    registerAgent('main', AgentRole.MainAgent);

    const result = selectRunnableAgent();

    expect(result).toEqual({ ok: true, agentId: 'main' });
  });

  it('uses the registered MainAgent id instead of a hard-coded default', () => {
    registerAgent('workspace-ceo', AgentRole.MainAgent);

    const result = selectRunnableAgent();

    expect(result).toEqual({ ok: true, agentId: 'workspace-ceo' });
  });

  it('falls back to any registered agent when MainAgent is absent', () => {
    registerAgent('member-1', AgentRole.Member);

    const result = selectRunnableAgent();

    expect(result).toEqual({ ok: true, agentId: 'member-1' });
  });

  it('rejects a requested inactive agent before starting a session', () => {
    registerAgent('main', AgentRole.MainAgent, { state: AgentState.Destroyed });

    const result = selectRunnableAgent('main');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('not active');
  });

  it('rejects a requested agent missing model connection fields', () => {
    registerAgent('main', AgentRole.MainAgent, { model: '' });

    const result = selectRunnableAgent('main');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('missing a model');
  });

  it('skips non-runnable MainAgent when selecting a default fallback', () => {
    registerAgent('main', AgentRole.MainAgent, { model: '' });
    registerAgent('member-1', AgentRole.Member);

    const result = selectRunnableAgent();

    expect(result).toEqual({ ok: true, agentId: 'member-1' });
  });

  it('returns an actionable error when every configured agent is non-runnable', () => {
    registerAgent('main', AgentRole.MainAgent, { apiUrl: '' });

    const result = selectRunnableAgent();

    expect(result.ok).toBe(false);
    expect(result.message).toContain('missing an API URL');
  });
});

function registerAgent(id: string, role: AgentRole, overrides: Record<string, unknown> = {}): void {
  const config = defaultConfig({
    id,
    name: id,
    role,
    model: 'test-model',
    provider: 'openai-compatible',
    apiUrl: 'https://example.test',
    apiKey: 'test-key',
    ...overrides,
  });
  AgentRegistry.getInstance().registerAgent(new Agent(config));
}
