// AgentRoutes — legacy agent CRUD handlers wrapped as RouteHandler classes
// Wraps existing handler functions from handlers/AgentHandlers.ts

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { ApiToken } from '../ApiAuth.js';
import {
  handleListAgents, handleGetAgent, handleCreateAgent,
  handleUpdateAgent, handleDeleteAgent, handleAgentStatus, handleTestAgentConnection,
} from '../handlers/AgentHandlers.js';
import { sendJson, readBody } from '../RouteHelpers.js';

export class ListAgentsRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/agents';
  description = 'List all agents';
  category = 'Agents';
  permission = 'agents:read';
  handle = (_match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean => {
    handleListAgents(res, sendJson);
    return true;
  };
}

export class GetAgentRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/agents/:id';
  description = 'Get agent config';
  category = 'Agents';
  permission = 'agents:read';
  handle = (match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean => {
    handleGetAgent(match.params.id, res, sendJson);
    return true;
  };
}

export class CreateAgentRoute implements RouteHandler {
  method = 'POST' as const;
  path = '/api/v1/agents';
  description = 'Create a new agent';
  category = 'Agents';
  permission = 'agents:write';
  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleCreateAgent(req, res, sendJson, readBody);
    return true;
  }
}

export class TestAgentConnectionRoute implements RouteHandler {
  method = 'POST' as const;
  path = '/api/v1/agents/test-connection';
  description = 'Test an agent model connection';
  category = 'Agents';
  permission = 'agents:write';
  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleTestAgentConnection(req, res, sendJson, readBody);
    return true;
  }
}

export class UpdateAgentRoute implements RouteHandler {
  method = 'PATCH' as const;
  path = '/api/v1/agents/:id';
  description = 'Update agent config';
  category = 'Agents';
  permission = 'agents:write';
  async handle(match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleUpdateAgent(match.params.id, req, res, sendJson, readBody);
    return true;
  }
}

export class DeleteAgentRoute implements RouteHandler {
  method = 'DELETE' as const;
  path = '/api/v1/agents/:id';
  description = 'Delete an agent';
  category = 'Agents';
  permission = 'agents:write';
  async handle(match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleDeleteAgent(match.params.id, req, res, sendJson, 'localhost');
    return true;
  }
}

export class AgentStatusRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/agents/:id/status';
  description = 'Agent runtime status';
  category = 'Agents';
  permission = 'agents:read';
  handle = (match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean => {
    handleAgentStatus(match.params.id, res, sendJson);
    return true;
  };
}
