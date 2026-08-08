/**
 * Native MCP routes — CRUD for MCP servers, reconnect, and connection logs.
 */

import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { readBody, sendJson } from '../RouteHelpers.js';
import { McpManager } from '../../infra/mcp/McpManager.js';
import type { McpServerConfig } from '../../infra/mcp/McpTypes.js';

export class McpListServersRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/mcp/servers';
  category = 'MCP';
  description = 'List MCP servers with connection state';
  handle(_m: RouteMatch, _r: IncomingMessage, res: ServerResponse): boolean {
    try {
      sendJson(res, 200, { servers: McpManager.getInstance().listServers() });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class McpGetServerRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/mcp/servers/:id';
  category = 'MCP';
  description = 'Get one MCP server with tools/resources/prompts detail';
  handle(m: RouteMatch, _r: IncomingMessage, res: ServerResponse): boolean {
    try {
      const client = McpManager.getInstance().getServer(m.params['id']);
      if (!client) { sendJson(res, 404, { error: 'Server not found' }); return true; }
      sendJson(res, 200, {
        id: client.id,
        name: client.name,
        transport: client.transportType,
        command: client.config.command,
        url: client.config.url,
        connected: client.connected,
        tools: client.tools,
        resources: client.resources,
        prompts: client.prompts,
        serverInfo: client.serverInfo,
        capabilities: client.capabilities,
      });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class McpCreateServerRoute implements RouteHandler {
  method = 'POST' as const;
  path = '/api/v1/mcp/servers';
  category = 'MCP';
  description = 'Create (or replace by name) an MCP server';
  async handle(_m: RouteMatch, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
      const body = (await readBody(req)) as unknown as Partial<McpServerConfig>;
      if (!body.name) { sendJson(res, 400, { error: 'name is required' }); return true; }
      const entry = await McpManager.getInstance().addServer(body);
      sendJson(res, 201, entry);
    } catch (err) { sendJson(res, 400, { error: (err as Error).message }); }
    return true;
  }
}

export class McpUpdateServerRoute implements RouteHandler {
  method = 'PUT' as const;
  path = '/api/v1/mcp/servers/:id';
  category = 'MCP';
  description = 'Update an MCP server config and reconnect';
  async handle(m: RouteMatch, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
      const body = (await readBody(req)) as unknown as Partial<McpServerConfig>;
      const updated = await McpManager.getInstance().updateServer(m.params['id'], body);
      sendJson(res, 200, updated);
    } catch (err) { sendJson(res, 400, { error: (err as Error).message }); }
    return true;
  }
}

export class McpDeleteServerRoute implements RouteHandler {
  method = 'DELETE' as const;
  path = '/api/v1/mcp/servers/:id';
  category = 'MCP';
  description = 'Delete an MCP server';
  async handle(m: RouteMatch, _r: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
      const deleted = await McpManager.getInstance().deleteServer(m.params['id']);
      if (!deleted) { sendJson(res, 404, { error: 'Server not found' }); return true; }
      sendJson(res, 200, { deleted: true });
    } catch (err) { sendJson(res, 400, { error: (err as Error).message }); }
    return true;
  }
}

export class McpReconnectServerRoute implements RouteHandler {
  method = 'POST' as const;
  path = '/api/v1/mcp/servers/:id/reconnect';
  category = 'MCP';
  description = 'Disconnect and reconnect an MCP server';
  async handle(m: RouteMatch, _r: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
      const state = await McpManager.getInstance().reconnect(m.params['id']);
      sendJson(res, 200, state);
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class McpGetLogsRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/mcp/logs';
  category = 'MCP';
  description = 'List recent MCP connection logs';
  handle(_m: RouteMatch, _r: IncomingMessage, res: ServerResponse): boolean {
    try {
      sendJson(res, 200, { logs: McpManager.getInstance().getLogs() });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}
