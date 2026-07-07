// AgentControlRoutes — agent state, org movement, report chain, find, reload
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson, readBody } from '../RouteHelpers.js';
import { AgentRegistry } from '../../core/agent/AgentRegistry.js';
import { AgentState, AgentRole } from '../../../shared/types/agent.js';
import { TypedEventBus } from '../../core/events/TypedEventBus.js';
import { requireWsAny } from '../WsRequired.js';
import { hierarchyValidationMessage, levelForRole } from '../../core/agent/AgentConstraints.js';

export class SetAgentStateRoute implements RouteHandler {
  method = 'PATCH' as const; path = '/api/v1/agents/:id/state';
  category = 'Agents'; description = 'Activate or destroy an agent (body: { state: "Active"|"Destroyed" })';
  async handle(m: RouteMatch, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (!requireWsAny(res, sendJson)) return true;
    try {
      const agent = AgentRegistry.getInstance().agent(m.params['id']);
      if (!agent) { sendJson(res, 404, { error: 'Agent not found' }); return true; }
      const body = await readBody(req);
      const state = body.state as string;
      if (state !== AgentState.Active && state !== AgentState.Destroyed) {
        sendJson(res, 400, { error: 'state must be "Active" or "Destroyed"' }); return true;
      }
      agent.setState(state as AgentState);
      AgentRegistry.getInstance().saveAgent(agent.id);
      TypedEventBus.emit('agent:changed', { action: 'state', agentId: agent.id });
      sendJson(res, 200, { agentId: agent.id, state: agent.state });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class ReassignAgentParentRoute implements RouteHandler {
  method = 'PATCH' as const; path = '/api/v1/agents/:id/parent';
  category = 'Agents'; description = 'Move agent in org tree (body: { parentAgentId, level })';
  async handle(m: RouteMatch, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (!requireWsAny(res, sendJson)) return true;
    try {
      const agent = AgentRegistry.getInstance().agent(m.params['id']);
      if (!agent) { sendJson(res, 404, { error: 'Agent not found' }); return true; }
      const body = await readBody(req);
      const parentId = body.parentAgentId as string;
      if (!parentId) {
        sendJson(res, 400, { error: 'parentAgentId is required' }); return true;
      }
      const hierarchyError = hierarchyValidationMessage(agent.id, agent.role, parentId);
      if (hierarchyError) {
        sendJson(res, 400, { error: hierarchyError }); return true;
      }
      const level = levelForRole(agent.role);
      agent.reassignParent(parentId, level);
      AgentRegistry.getInstance().saveAgent(agent.id);
      TypedEventBus.emit('agent:changed', { action: 'parent', agentId: agent.id });
      sendJson(res, 200, { agentId: agent.id, parentAgentId: parentId, level });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class AgentReportChainRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/agents/:id/report-chain';
  category = 'Agents'; description = 'Get reporting chain from agent up to CEO';
  handle(m: RouteMatch, _r: IncomingMessage, res: ServerResponse): boolean {
    try {
      const reg = AgentRegistry.getInstance();
      const chain = reg.reportChain(m.params['id']);
      const details = chain.map(id => { const a = reg.agent(id); return a ? { id: a.id, name: a.name, role: a.role } : { id }; });
      sendJson(res, 200, { agentId: m.params['id'], chain: details });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class FindAgentRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/agents-find';
  category = 'Agents'; description = 'Fuzzy-find agent by ID or name (?q=...)';
  handle(_m: RouteMatch, req: IncomingMessage, res: ServerResponse): boolean {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const q = url.searchParams.get('q') || '';
      if (!q) { sendJson(res, 400, { error: 'q param required' }); return true; }
      const reg = AgentRegistry.getInstance();
      const found = reg.findAgent(q);
      if (!found) { sendJson(res, 404, { error: 'Agent not found' }); return true; }
      sendJson(res, 200, { id: found.id, name: found.name, role: found.role, level: found.level, parentAgentId: found.parentAgentId });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class ReloadAgentsRoute implements RouteHandler {
  method = 'POST' as const; path = '/api/v1/agents/reload';
  category = 'Agents'; description = 'Reload all agent configs from disk';
  async handle(_m: RouteMatch, _r: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (!requireWsAny(res, sendJson)) return true;
    try {
      const reg = AgentRegistry.getInstance();
      await reg.loadFromDirectory();
      TypedEventBus.emit('agent:changed', { action: 'reloaded', agentId: '*' });
      sendJson(res, 200, { reloaded: true, count: reg.allAgents().length });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class ListAgentsFilteredRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/agents-filtered';
  category = 'Agents'; description = 'List agents with role/parent filters (?role=Manager&parent=ceo)';
  handle(_m: RouteMatch, req: IncomingMessage, res: ServerResponse): boolean {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const role = url.searchParams.get('role') || '';
      const parent = url.searchParams.get('parent') || '';
      const reg = AgentRegistry.getInstance();
      let agents = reg.allAgents();
      if (role) agents = reg.agentsByRole(role as AgentRole);
      else if (parent) agents = reg.agentsByParent(parent);
      sendJson(res, 200, {
        agents: agents.map(a => ({ id: a.id, name: a.name, role: a.role, level: a.level, parentAgentId: a.parentAgentId, isActive: a.isActive })),
        total: agents.length,
      });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}
