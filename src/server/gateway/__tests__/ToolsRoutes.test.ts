import { describe, it, expect, beforeEach } from 'vitest';
import { ApiServer } from '../ApiServer.js';
import type { RouteHandler } from '../RouteHandler.js';
import { ToolsListRoute } from '../routes/ToolsRoute.js';
import { GetToolDetailRoute, ToolsForAgentRoute } from '../routes/ToolsDetailRoute.js';
import { ToolRegistry } from '../../core/tools/ToolRegistry.js';
import { Tool, RiskLevel } from '../../core/tools/Tool.js';
import type { ExecutionContext, ToolResult } from '../../core/tools/Tool.js';
import { AgentRegistry } from '../../core/agent/AgentRegistry.js';
import { Agent } from '../../core/agent/Agent.js';
import { AgentRole, AgentState } from '../../../shared/types/agent.js';

describe('tools API routes', () => {
  let api: ApiServer;

  beforeEach(() => {
    api = ApiServer.getInstance();
    (api as unknown as { _routeTable: RouteHandler[] })._routeTable = [];
    (api as unknown as { _endpointRegistry: unknown[] })._endpointRegistry = [];
    (api as unknown as { _pluginRoutes: unknown[] })._pluginRoutes = [];

    ToolRegistry.resetInstance();
    AgentRegistry.resetInstance();

    const registry = ToolRegistry.getInstance();
    registry.registerTool(new MemorySearchFixtureTool(), 'memory');
    registry.registerTool(new NoteWriteFixtureTool(), 'files', { source: 'plugin', pluginName: 'notes-plugin' });

    api.registerRoute(new ToolsListRoute());
    api.registerRoute(new GetToolDetailRoute());
    api.registerRoute(new ToolsForAgentRoute());
  });

  it('searches and filters tools while optionally returning detailed metadata', async () => {
    const result = await api.callInternal('GET', '/api/v1/tools?q=memory%20query&readOnly=true&detail=true&limit=5');

    expect(result.statusCode).toBe(200);
    const body = result.body as {
      tools: Array<{
        name: string;
        parameterNames: string[];
        parameters?: Record<string, unknown>;
        isReadOnly: boolean;
        riskLevel: string;
      }>;
      total: number;
      availableTotal: number;
      detail: boolean;
      filters: Record<string, unknown>;
    };

    expect(body.availableTotal).toBe(2);
    expect(body.total).toBe(1);
    expect(body.detail).toBe(true);
    expect(body.filters).toEqual(expect.objectContaining({ search: 'memory query', readOnly: true, limit: 5 }));
    expect(body.tools[0]).toEqual(expect.objectContaining({
      name: 'MemorySearchFixture',
      isReadOnly: true,
      riskLevel: 'Safe',
      parameterNames: ['query', 'limit'],
    }));
    expect(body.tools[0].parameters).toEqual(expect.objectContaining({ type: 'object' }));
  });

  it('returns rich allowlisted tool metadata for a specific agent', async () => {
    AgentRegistry.getInstance().registerAgent(new Agent({
      id: 'agent-tools',
      name: 'Tool Agent',
      role: AgentRole.Member,
      parentAgentId: 'manager-1',
      level: 2,
      teamName: 'Core',
      createdAt: '2026-01-01T00:00:00.000Z',
      state: AgentState.Active,
      provider: 'openai-compatible',
      apiUrl: 'https://api.example.com',
      apiKey: '',
      model: 'test-model',
      contextWindow: 128000,
      maxTurns: 0,
      temperature: 0.7,
      allowedTools: ['MemorySearchFixture', 'MissingFixture'],
      enabledSkills: [],
      mcpServers: [],
      agentPrompt: '',
      preferredLanguage: 'en',
      conversationLanguage: 'en',
    }));

    const result = await api.callInternal('GET', '/api/v1/tools-for-agent/agent-tools?q=memory&detail=true');

    expect(result.statusCode).toBe(200);
    const body = result.body as {
      agentFound: boolean;
      tools: Array<{ name: string; parameters?: Record<string, unknown>; isReadOnly: boolean }>;
      total: number;
      configuredButUnavailable: string[];
      detail: boolean;
    };

    expect(body.agentFound).toBe(true);
    expect(body.detail).toBe(true);
    expect(body.total).toBe(1);
    expect(body.configuredButUnavailable).toEqual(['MissingFixture']);
    expect(body.tools[0]).toEqual(expect.objectContaining({
      name: 'MemorySearchFixture',
      isReadOnly: true,
    }));
    expect(body.tools[0].parameters).toEqual(expect.objectContaining({ type: 'object' }));
  });
});

class MemorySearchFixtureTool extends Tool {
  static category = 'Memory';

  name(): string { return 'MemorySearchFixture'; }
  description(): string { return 'Search memory entries by query text.'; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        limit: { type: 'number', description: 'Maximum results.' },
      },
      required: ['query'],
    };
  }
  riskLevel(): RiskLevel { return RiskLevel.Safe; }
  isReadOnly(): boolean { return true; }
  isConcurrencySafe(): boolean { return true; }
  async execute(_params: Record<string, unknown>, _ctx: ExecutionContext): Promise<ToolResult> {
    return this.makeResult('[]');
  }
}

class NoteWriteFixtureTool extends Tool {
  static category = 'Files';

  name(): string { return 'NoteWriteFixture'; }
  description(): string { return 'Write a note to disk.'; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Target file path.' },
        content: { type: 'string', description: 'Note content.' },
      },
      required: ['path', 'content'],
    };
  }
  riskLevel(): RiskLevel { return RiskLevel.Medium; }
  isDestructive(): boolean { return true; }
  async execute(_params: Record<string, unknown>, _ctx: ExecutionContext): Promise<ToolResult> {
    return this.makeResult('ok');
  }
}
