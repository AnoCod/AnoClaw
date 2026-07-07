import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AgentRegistry } from '../../../core/agent/AgentRegistry.js';
import { Agent } from '../../../core/agent/Agent.js';
import { defaultConfig } from '../../../core/agent/AgentConfig.js';
import { levelForRole } from '../../../core/agent/AgentConstraints.js';
import { WsServer } from '../../../infra/network/WsServer.js';
import { AgentRole } from '../../../../shared/types/agent.js';
import { handleDeleteAgent } from '../AgentHandlers.js';

interface Capture {
  status: number;
  body: Record<string, unknown>;
}

beforeEach(() => {
  AgentRegistry.resetInstance();
  vi.spyOn(WsServer.getInstance(), 'isConnected').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleDeleteAgent', () => {
  it('rejects non-cascade deletion when descendants would become orphaned', async () => {
    registerAgent('ceo', AgentRole.MainAgent);
    registerAgent('manager', AgentRole.Manager, 'ceo');
    registerAgent('member', AgentRole.Member, 'manager');

    const capture = await deleteAgent('/api/v1/agents/manager', 'manager');

    expect(capture.status).toBe(409);
    expect(capture.body.message).toContain('Use cascade=true');
    expect(capture.body.childAgentIds).toEqual(['member']);
    expect(AgentRegistry.getInstance().agent('manager')).toBeTruthy();
    expect(AgentRegistry.getInstance().agent('member')).toBeTruthy();
  });

  it('cascade deletes the selected agent and all descendants', async () => {
    registerAgent('ceo', AgentRole.MainAgent);
    registerAgent('manager', AgentRole.Manager, 'ceo');
    registerAgent('member', AgentRole.Member, 'manager');

    const capture = await deleteAgent('/api/v1/agents/manager?cascade=true', 'manager');

    expect(capture.status).toBe(200);
    expect(capture.body.deletedAgentIds).toEqual(['manager', 'member']);
    expect(AgentRegistry.getInstance().agent('ceo')).toBeTruthy();
    expect(AgentRegistry.getInstance().agent('manager')).toBeUndefined();
    expect(AgentRegistry.getInstance().agent('member')).toBeUndefined();
  });
});

async function deleteAgent(url: string, agentId: string): Promise<Capture> {
  const capture: Capture = { status: 0, body: {} };
  await handleDeleteAgent(
    agentId,
    { url } as IncomingMessage,
    {} as ServerResponse,
    (_res, status, body) => {
      capture.status = status;
      capture.body = body as Record<string, unknown>;
    },
    '127.0.0.1',
  );
  return capture;
}

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
