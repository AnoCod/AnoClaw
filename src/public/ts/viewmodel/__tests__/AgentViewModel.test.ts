import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentRunnableProblem, AgentViewModel } from '../AgentViewModel.js';
import type { AgentConfig, AgentRole } from '../../types.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe('AgentViewModel.selectRunnableAgent', () => {
  it('returns setup guidance when no agents exist', () => {
    const vm = new AgentViewModel();

    const result = vm.selectRunnableAgent();

    expect(result.ok).toBe(false);
    expect(result.message).toContain('No agents are configured');
  });

  it('accepts a requested runnable agent', () => {
    const vm = new AgentViewModel();
    vm.agents = [makeAgent('member-1', 'Member')];

    const result = vm.selectRunnableAgent('member-1');

    expect(result).toEqual({ ok: true, agentId: 'member-1' });
  });

  it('rejects a requested missing agent', () => {
    const vm = new AgentViewModel();
    vm.agents = [makeAgent('main', 'MainAgent')];

    const result = vm.selectRunnableAgent('missing-agent');

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Agent 'missing-agent' is not configured");
  });

  it('rejects a requested agent missing model configuration', () => {
    const vm = new AgentViewModel();
    vm.agents = [makeAgent('main', 'MainAgent', { model: '' })];

    const result = vm.selectRunnableAgent('main');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('missing a model');
  });

  it('skips a non-runnable MainAgent and falls back to a runnable agent', () => {
    const vm = new AgentViewModel();
    vm.agents = [
      makeAgent('main', 'MainAgent', { apiUrl: '' }),
      makeAgent('member-1', 'Member'),
    ];

    const result = vm.selectRunnableAgent();

    expect(result).toEqual({ ok: true, agentId: 'member-1' });
  });

  it('rejects inactive agents', () => {
    const vm = new AgentViewModel();
    vm.agents = [makeAgent('main', 'MainAgent', { state: 'Destroyed' })];

    const result = vm.selectRunnableAgent();

    expect(result.ok).toBe(false);
    expect(result.message).toContain('is not active');
  });
});

describe('agentRunnableProblem', () => {
  it('returns null for a fully configured active agent', () => {
    expect(agentRunnableProblem(makeAgent('ready', 'MainAgent'))).toBeNull();
  });

  it('reports the concrete missing field', () => {
    expect(agentRunnableProblem(makeAgent('main', 'MainAgent', { apiUrl: '' }))).toContain('missing an API URL');
  });
});

describe('AgentViewModel save errors', () => {
  it('stores backend create error messages', async () => {
    const vm = new AgentViewModel();
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ message: 'Only one MainAgent/CEO is allowed' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch;

    const result = await vm.createAgent(makeAgent('second-main', 'MainAgent'));

    expect(result).toBeNull();
    expect(vm.lastError).toBe('Only one MainAgent/CEO is allowed');
  });

  it('stores backend update error messages', async () => {
    const vm = new AgentViewModel();
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ message: 'Members must report to a Manager' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch;

    const result = await vm.updateAgent('member-1', { parentAgentId: 'ceo' });

    expect(result).toBe(false);
    expect(vm.lastError).toBe('Members must report to a Manager');
  });
});

describe('AgentViewModel delete cascade', () => {
  it('removes every deleted subtree id returned by the backend', async () => {
    const vm = new AgentViewModel();
    vm.agents = [
      makeAgent('main', 'MainAgent'),
      makeAgent('manager', 'Manager', { parentAgentId: 'main' }),
      makeAgent('member', 'Member', { parentAgentId: 'manager' }),
    ];
    vm.selectedAgentId = 'member';
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ deletedAgentIds: ['manager', 'member'] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch;

    const ok = await vm.deleteAgent('manager', true);

    expect(ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/v1/agents/manager?cascade=true', { method: 'DELETE' });
    expect(vm.agents.map(a => a.id)).toEqual(['main']);
    expect(vm.selectedAgentId).toBeNull();
  });

  it('preserves backend delete conflict messages for the UI', async () => {
    const vm = new AgentViewModel();
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ message: 'Agent has descendant agents. Use cascade=true.' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch;

    const ok = await vm.deleteAgent('manager');

    expect(ok).toBe(false);
    expect(vm.lastError).toBe('Agent has descendant agents. Use cascade=true.');
  });
});

describe('AgentViewModel websocket refresh', () => {
  it('reloads agents when agent_config_updated is received', async () => {
    const vm = new AgentViewModel();
    const handlers = new Map<string, (data: unknown) => void>();
    const ws = {
      on: vi.fn((event: string, handler: (data: unknown) => void) => {
        handlers.set(event, handler);
      }),
      off: vi.fn(),
    };
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ agents: [makeAgent('updated-main', 'MainAgent')] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch;

    vm.subscribeToAgentEvents(ws);
    handlers.get('agent_config_updated')?.({ agentId: 'updated-main' });

    await vi.waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v1/agents');
      expect(vm.getAgent('updated-main')).toBeTruthy();
    });
  });
});

function makeAgent(id: string, role: AgentRole, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id,
    name: id,
    role,
    parentAgentId: role === 'MainAgent' ? null : 'main',
    provider: 'openai',
    apiUrl: 'https://api.example.test/v1',
    model: 'test-model',
    contextWindow: 128000,
    preferredLanguage: 'en',
    conversationLanguage: 'en',
    agentPrompt: 'You are a test agent.',
    allowedTools: [],
    enabledSkills: [],
    state: 'Active',
    ...overrides,
  };
}
