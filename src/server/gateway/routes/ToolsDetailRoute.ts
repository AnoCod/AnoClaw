// ToolsDetailRoute — single tool detail and tools-for-agent query
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson } from '../RouteHelpers.js';
import { ToolRegistry } from '../../core/tools/ToolRegistry.js';
import { AgentRegistry } from '../../core/agent/AgentRegistry.js';
import { filterToolMeta, wantsDetails } from './ToolsRoute.js';

export class GetToolDetailRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/tools/:name';
  category = 'Tools'; description = 'Get detailed info for a single tool';
  handle(m: RouteMatch, _r: IncomingMessage, res: ServerResponse): boolean {
    try {
      const tr = ToolRegistry.getInstance();
      const tool = tr.allToolsWithMeta({ includeDetails: true }).find((candidate) => candidate.name === m.params['name']);
      if (!tool) { sendJson(res, 404, { error: 'Tool not found' }); return true; }
      sendJson(res, 200, tool);
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class ToolsForAgentRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/tools-for-agent/:agentId';
  category = 'Tools'; description = 'List tools available to a specific agent (respects allowlist)';
  handle(m: RouteMatch, req: IncomingMessage, res: ServerResponse): boolean {
    try {
      const reg = AgentRegistry.getInstance();
      const agent = reg.agent(m.params['agentId']);
      const allowedTools = agent ? agent.allowedTools() : [];
      const tr = ToolRegistry.getInstance();
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const includeDetails = wantsDetails(url.searchParams.get('detail'));
      const allTools = tr.toolsForAgentWithMeta(allowedTools, {}, { includeDetails });
      const { tools, filters } = filterToolMeta(allTools, url.searchParams);
      sendJson(res, 200, {
        agentId: m.params['agentId'],
        agentFound: Boolean(agent),
        tools,
        total: tools.length,
        availableTotal: allTools.length,
        configuredButUnavailable: tr.missingToolNames(allowedTools),
        detail: includeDetails,
        filters,
      });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}
