// AgentHandlers — agent CRUD HTTP handlers extracted from ApiServer
// Handles: list, get, create, update, delete agents
// Part of the AnoClaw v2.0 rewrite: Gateway system (SA-10)

import * as http from 'http';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { AgentRegistry } from '../../core/agent/AgentRegistry.js';
import { loadAgentConfig, saveAgentConfig, defaultConfig } from '../../core/agent/AgentConfig.js';
import { Agent } from '../../core/agent/Agent.js';
import { hasMainAgentConflict, hierarchyValidationMessage, normalizeAgentHierarchy } from '../../core/agent/AgentConstraints.js';
import { testAgentConnection, validateAgentConnectionInput } from '../../core/agent/AgentConnectionTest.js';
import { TypedEventBus } from '../../core/events/TypedEventBus.js';
import { requireWsAny } from '../WsRequired.js';
import type { AgentConfig } from '../../../shared/types/agent.js';
import { PATHS } from '../../../shared/constants.js';
import type { SendJson, ReadBody } from '../RouteHelpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Serialize Agent object to API response format.
 *  apiKey is masked for list/get — only create returns the raw key. */
function serializeAgent(a: Agent): Record<string, unknown> {
  return {
    id: a.id,
    name: a.name,
    role: a.role,
    parentAgentId: a.parentAgentId,
    level: a.level,
    teamName: a.teamName,
    provider: a.provider,
    apiUrl: a.apiUrl,
    apiKey: a.apiKey ? '********' : '',
    model: a.modelName,
    contextWindow: a.contextWindow,
    preferredLanguage: a.preferredLanguage,
    conversationLanguage: a.conversationLanguage,
    agentPrompt: a.agentPrompt,
    allowedTools: a.allowedTools(),
    enabledSkills: a.enabledSkills(),
    isActive: a.isActive,
    state: a.state,
    createdAt: a.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Exported handler functions
// ---------------------------------------------------------------------------

/** GET /api/v1/agents */
export function handleListAgents(
  res: http.ServerResponse,
  sendJson: SendJson,
): void {
  const registry = AgentRegistry.getInstance();
  const agents = registry.allAgents();

  sendJson(res, 200, {
    agents: agents.map((a) => serializeAgent(a)),
    total: agents.length,
  });
}

/** GET /api/v1/agents/:id */
export function handleGetAgent(
  agentId: string,
  res: http.ServerResponse,
  sendJson: SendJson,
): void {
  const registry = AgentRegistry.getInstance();
  const agent = registry.agent(agentId);

  if (!agent) {
    sendJson(res, 404, { error: 'Not Found', message: `Agent '${agentId}' not found` });
    return;
  }

  sendJson(res, 200, serializeAgent(agent));
}

/** POST /api/v1/agents — Create new agent */
export async function handleCreateAgent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sendJson: SendJson,
  readBody: ReadBody,
): Promise<void> {
  if (!requireWsAny(res, sendJson)) return;

  const body = await readBody(req);
  try {
    const config = defaultConfig(normalizeAgentHierarchy(body as Partial<AgentConfig>));
    if (hasMainAgentConflict(config.id, config.role)) {
      sendJson(res, 409, { error: 'Conflict', message: 'Only one MainAgent/CEO is allowed' });
      return;
    }
    const hierarchyError = hierarchyValidationMessage(config.id, config.role, config.parentAgentId);
    if (hierarchyError) {
      sendJson(res, 400, { error: 'Bad Request', message: hierarchyError });
      return;
    }
    await saveAgentConfig(config);
    const agent = new Agent(config);
    AgentRegistry.getInstance().registerAgent(agent);

    TypedEventBus.emit('agent:registered', {
      agentId: agent.id,
      role: agent.role,
      name: agent.name,
    });

    const { apiKey, ...safeConfig } = config;
    sendJson(res, 201, safeConfig as unknown as Record<string, unknown>);
  } catch (err) {
    sendJson(res, 400, { error: 'Bad Request', message: (err as Error).message });
  }
}

/** PATCH /api/v1/agents/:id — Update agent config */
export async function handleTestAgentConnection(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sendJson: SendJson,
  readBody: ReadBody,
): Promise<void> {
  const body = await readBody(req) as Record<string, unknown>;
  try {
    const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
    let savedApiKey = '';
    let savedProvider = '';
    let savedApiUrl = '';
    let savedModel = '';

    if (agentId) {
      const existingConfig = await loadAgentConfig(agentId);
      savedApiKey = existingConfig.apiKey || '';
      savedProvider = existingConfig.provider || '';
      savedApiUrl = existingConfig.apiUrl || '';
      savedModel = existingConfig.model || '';
    }

    const input = {
      provider: String(body.provider || savedProvider || ''),
      apiUrl: String(body.apiUrl || savedApiUrl || ''),
      apiKey: String(body.apiKey || savedApiKey || ''),
      model: String(body.model || savedModel || ''),
    };

    const validationError = validateAgentConnectionInput(input);
    if (validationError) {
      sendJson(res, 400, { ok: false, error: 'Bad Request', message: validationError });
      return;
    }

    const result = await testAgentConnection(input);
    sendJson(res, result.ok ? 200 : 502, result as unknown as Record<string, unknown>);
  } catch (err) {
    if ((err as Error).message.includes('not found')) {
      sendJson(res, 404, { ok: false, error: 'Not Found', message: (err as Error).message });
    } else {
      sendJson(res, 500, { ok: false, error: 'Connection Test Failed', message: (err as Error).message });
    }
  }
}

export async function handleUpdateAgent(
  agentId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sendJson: SendJson,
  readBody: ReadBody,
): Promise<void> {
  if (!requireWsAny(res, sendJson)) return;

  const body = await readBody(req);
  try {
    const existingConfig = await loadAgentConfig(agentId);
    // Preserve existing apiKey when incoming value is empty or all-asterisk (masked)
    const incomingApiKey = (body as any).apiKey;
    if (!incomingApiKey || /^\*+$/.test(incomingApiKey)) {
      delete (body as any).apiKey;
    }
    const updated = defaultConfig(normalizeAgentHierarchy({ ...existingConfig, ...body, id: agentId }));
    if (hasMainAgentConflict(agentId, updated.role)) {
      sendJson(res, 409, { error: 'Conflict', message: 'Only one MainAgent/CEO is allowed' });
      return;
    }
    const hierarchyError = hierarchyValidationMessage(agentId, updated.role, updated.parentAgentId);
    if (hierarchyError) {
      sendJson(res, 400, { error: 'Bad Request', message: hierarchyError });
      return;
    }
    await saveAgentConfig(updated);

    // Update agent in memory
    const registry = AgentRegistry.getInstance();
    const existing = registry.agent(agentId);
    if (existing) {
      registry.unregisterAgent(agentId);
    }
    const agent = new Agent(updated);
    registry.registerAgent(agent);

    TypedEventBus.emit('agent:config_updated', {
      agentId,
      role: agent.role,
      name: agent.name,
    });

    sendJson(res, 200, {
      status: 'saved',
      agentId,
      file: `${PATHS.agents}/${agentId}.json`,
    });
  } catch (err) {
    if ((err as Error).message.includes('not found')) {
      sendJson(res, 404, { error: 'Not Found', message: (err as Error).message });
    } else {
      sendJson(res, 400, { error: 'Bad Request', message: (err as Error).message });
    }
  }
}

/** DELETE /api/v1/agents/:id — Delete agent (MainAgent cannot be deleted).
 *  Query param: ?cascade=true recursively delete all descendant agents. */
export async function handleDeleteAgent(
  agentId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sendJson: SendJson,
  host: string,
): Promise<void> {
  if (!requireWsAny(res, sendJson)) return;

  try {
    const registry = AgentRegistry.getInstance();
    const agent = registry.agent(agentId);

    // First check: agent must exist
    if (!agent) {
      sendJson(res, 404, { error: 'Not Found', message: `Agent '${agentId}' not found` });
      return;
    }

    if (agent.role === 'MainAgent') {
      sendJson(res, 403, { error: 'Forbidden', message: 'MainAgent cannot be deleted' });
      return;
    }

    const url = new URL(req.url || '/', `http://${host}`);
    const cascade = url.searchParams.get('cascade') === 'true';
    const descendants = registry.descendantsOf(agentId);

    if (descendants.length > 0 && !cascade) {
      sendJson(res, 409, {
        error: 'Conflict',
        message: `Agent '${agent.name}' has ${descendants.length} descendant agent(s). Use cascade=true to delete the whole subtree.`,
        childAgentIds: descendants.map((a) => a.id),
      });
      return;
    }

    if (cascade) {
      for (const descendant of descendants.reverse()) {
        const id = descendant.id;
        registry.unregisterAgent(id);
        await fsp.unlink(path.resolve(process.cwd(), PATHS.agents, `${id}.json`)).catch(() => {});
        await fsp.rm(path.resolve(process.cwd(), PATHS.memory, 'agents', id), { recursive: true, force: true }).catch(() => {});
        TypedEventBus.emit('agent:unregistered', {
          agentId: id,
          role: descendant.role,
          name: descendant.name,
        });
      }
    }

    registry.unregisterAgent(agentId);
    await fsp.unlink(path.resolve(process.cwd(), PATHS.agents, `${agentId}.json`)).catch(() => {});
    await fsp.rm(path.resolve(process.cwd(), PATHS.memory, 'agents', agentId), { recursive: true, force: true }).catch(() => {});
    TypedEventBus.emit('agent:unregistered', {
      agentId,
      role: agent.role,
      name: agent.name,
    });
    sendJson(res, 200, {
      status: 'deleted',
      agentId,
      cascade,
      deletedAgentIds: [agentId, ...descendants.map((a) => a.id)],
    });
  } catch (err) {
    sendJson(res, 400, { error: 'Bad Request', message: (err as Error).message });
  }
}

/** GET /api/v1/agents/:id/status */
export function handleAgentStatus(
  agentId: string,
  res: http.ServerResponse,
  sendJson: SendJson,
): void {
  const registry = AgentRegistry.getInstance();
  const agent = registry.agent(agentId);

  if (!agent) {
    sendJson(res, 404, { error: 'Not Found', message: `Agent '${agentId}' not found` });
    return;
  }

  const statusMap: Record<string, string> = {};
  for (const [sid, status] of agent.allSessionStatuses()) {
    statusMap[sid] = status;
  }

  sendJson(res, 200, {
    agentId: agent.id,
    name: agent.name,
    isActive: agent.isActive,
    state: agent.state,
    sessionCount: agent.servingSessionCount,
    sessionStatuses: statusMap,
  });
}
