// ToolsDetailRoute — single tool detail and tools-for-agent query
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson } from '../RouteHelpers.js';
import { ToolRegistry } from '../../core/tools/ToolRegistry.js';
import { AgentRegistry } from '../../core/agent/AgentRegistry.js';

export class GetToolDetailRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/tools/:name';
  category = 'Tools'; description = 'Get detailed info for a single tool';
  handle(m: RouteMatch, _r: IncomingMessage, res: ServerResponse): boolean {
    try {
      const tr = ToolRegistry.getInstance();
      const t = tr.tool(m.params['name']);
      if (!t) { sendJson(res, 404, { error: 'Tool not found' }); return true; }
      sendJson(res, 200, {
        name: t.name(), description: t.description(),
        isReadOnly: tr.isReadOnly(t.name()), isConcurrencySafe: tr.isConcurrencySafe(t.name()),
        riskLevel: t.riskLevel?.() || 'Unknown', interruptBehavior: t.interruptBehavior?.(),
        defaultTimeoutMs: t.defaultTimeoutMs?.() || 0,
        parameters: t.parametersSchema(),
      });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class ToolsForAgentRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/tools-for-agent/:agentId';
  category = 'Tools'; description = 'List tools available to a specific agent (respects allowlist)';
  handle(m: RouteMatch, _r: IncomingMessage, res: ServerResponse): boolean {
    try {
      const reg = AgentRegistry.getInstance();
      const agent = reg.agent(m.params['agentId']);
      const allowedTools = agent ? agent.allowedTools() : [];
      const tr = ToolRegistry.getInstance();
      const tools = tr.toolsForAgent(allowedTools);
      sendJson(res, 200, {
        agentId: m.params['agentId'],
        tools: tools.map(t => ({ name: t.name(), description: t.description() })),
        total: tools.length,
      });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}
