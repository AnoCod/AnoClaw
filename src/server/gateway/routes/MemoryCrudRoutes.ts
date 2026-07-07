// MemoryCrudRoutes — declarative RouteHandler classes for memory CRUD
// Migrated from legacy MemoryRoutes class

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson, readBody } from '../RouteHelpers.js';
import { PATHS } from '../../../shared/constants.js';
import { MemoryManager } from '../../core/memory/MemoryManager.js';
import { MemoryEntry, MemoryScope, MemoryType } from '../../core/memory/MemoryEntry.js';
import { requireWsAny } from '../WsRequired.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FrontendMemoryEntry {
  id: string;
  title: string;
  content: string;
  team: string;
  type: string;
  scope: string;
  agentId: string;
  updatedAt: number;
}

interface AgentMemoryEntry extends MemoryEntry {
  _sourceAgentId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectAllEntries(): Promise<AgentMemoryEntry[]> {
  const memoryManager = MemoryManager.getInstance();
  const baseDir = path.resolve(process.cwd(), PATHS.memory);
  const entries: AgentMemoryEntry[] = [];

  const teamEntries = await memoryManager.search('system', MemoryScope.Team, '');
  for (const e of teamEntries) {
    entries.push({ ...e, _sourceAgentId: 'team' });
  }

  const agentsDir = path.join(baseDir, 'agents');
  try {
    const dirs = await fs.promises.readdir(agentsDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const agentId = d.name;
      const agentEntries = await memoryManager.search(agentId, MemoryScope.Agent, '');
      for (const e of agentEntries) {
        entries.push({ ...e, _sourceAgentId: agentId });
      }
    }
  } catch {
    // agents/ directory may not exist yet
  }

  return entries;
}

function toFrontendMemoryEntry(entry: MemoryEntry, agentId?: string): FrontendMemoryEntry {
  const teamMap: Record<string, string> = {
    [MemoryScope.Team]: 'Team',
    [MemoryScope.Agent]: 'Personal',
    [MemoryScope.Session]: 'Session',
  };
  return {
    id: entry.name,
    title: entry.description || entry.name,
    content: entry.content,
    team: teamMap[entry.scope] || String(entry.scope),
    type: entry.type || 'reference',
    scope: entry.scope || 'agent',
    agentId: agentId || (entry.scope === MemoryScope.Team ? 'all' : (entry.sessionId || 'unknown')),
    updatedAt: entry.updatedAt || Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** GET /api/v1/memory — list all memory entries */
export class ListMemoryRoute implements RouteHandler {
  readonly method = 'GET';
  readonly path = '/api/v1/memory';
  readonly permission = 'memory:read';
  readonly category = 'Memory';
  readonly description = 'List all memory entries (team + all agents)';

  async handle(_match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    try {
      const allEntries = await collectAllEntries();
      const frontendEntries = allEntries.map((e) => toFrontendMemoryEntry(e, e._sourceAgentId));
      sendJson(res, 200, frontendEntries);
    } catch (err) {
      sendJson(res, 500, { error: 'Internal Error', message: (err as Error).message });
    }
    return true;
  }
}

/** POST /api/v1/memory — create a new memory entry */
export class CreateMemoryRoute implements RouteHandler {
  readonly method = 'POST';
  readonly path = '/api/v1/memory';
  readonly permission = 'memory:write';
  readonly category = 'Memory';
  readonly description = 'Create a new memory entry (name, type, description, content, scope, agentId)';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    if (!requireWsAny(res, sendJson)) return true;
    try {
      const body = await readBody(req);
      const name = (body.name as string)?.trim();
      if (!name) {
        sendJson(res, 400, { error: 'Bad Request', message: 'name is required' });
        return true;
      }
      const entry: MemoryEntry = {
        name,
        type: (body.type as MemoryType) || MemoryType.Reference,
        description: (body.description as string) || name,
        content: (body.content as string) || '',
        scope: (body.scope as MemoryScope) || MemoryScope.Team,
      };
      const agentId = (body.agentId as string) || 'system';
      const memoryManager = MemoryManager.getInstance();
      await memoryManager.save(agentId, entry.scope, entry);
      sendJson(res, 201, toFrontendMemoryEntry(entry, agentId));
    } catch (err) {
      sendJson(res, 500, { error: 'Internal Error', message: (err as Error).message });
    }
    return true;
  }
}

/** PATCH /api/v1/memory/:id — update a memory entry (id = entry name) */
export class UpdateMemoryRoute implements RouteHandler {
  readonly method = 'PATCH';
  readonly path = '/api/v1/memory/:id';
  readonly permission = 'memory:write';
  readonly category = 'Memory';
  readonly description = 'Update a memory entry by name (title, team, content)';

  async handle(match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    const name = match.params['id'];
    if (!requireWsAny(res, sendJson)) return true;
    try {
      const body = await readBody(req);
      const memoryManager = MemoryManager.getInstance();
      const allEntries = await collectAllEntries();
      const found = allEntries.find((e) => e.name === name);
      if (!found) {
        sendJson(res, 404, { error: 'Not Found', message: `Memory '${name}' not found` });
        return true;
      }

      const updated: MemoryEntry = { ...found };
      if (body.title) updated.description = body.title as string;
      if (body.team) {
        const scopeMap: Record<string, MemoryScope> = {
          Team: MemoryScope.Team,
          Personal: MemoryScope.Agent,
          Session: MemoryScope.Session,
        };
        updated.scope = scopeMap[body.team as string] || found.scope;
      }
      if (body.content) updated.content = body.content as string;

      const realAgentId = found._sourceAgentId;
      await memoryManager.save(realAgentId, updated.scope || MemoryScope.Agent, updated);
      sendJson(res, 200, toFrontendMemoryEntry(updated, realAgentId) as unknown as Record<string, unknown>);
    } catch (err) {
      sendJson(res, 500, { error: 'Internal Error', message: (err as Error).message });
    }
    return true;
  }
}

/** DELETE /api/v1/memory/:id — delete a memory entry (id = entry name) */
export class DeleteMemoryRoute implements RouteHandler {
  readonly method = 'DELETE';
  readonly path = '/api/v1/memory/:id';
  readonly permission = 'memory:write';
  readonly category = 'Memory';
  readonly description = 'Delete a memory entry by name';

  async handle(match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    const name = match.params['id'];
    if (!requireWsAny(res, sendJson)) return true;
    try {
      const memoryManager = MemoryManager.getInstance();
      const allEntries = await collectAllEntries();
      const found = allEntries.find((e) => e.name === name);
      if (!found) {
        sendJson(res, 404, { error: 'Not Found', message: `Memory '${name}' not found` });
        return true;
      }
      const realAgentId = found._sourceAgentId;
      const scope = (found.scope as MemoryScope) || MemoryScope.Agent;
      const deleted = await memoryManager.remove(realAgentId, scope, name);
      if (!deleted) {
        sendJson(res, 404, { error: 'Not Found', message: `Memory '${name}' could not be deleted` });
        return true;
      }
      sendJson(res, 200, { name, deleted: true });
    } catch (err) {
      sendJson(res, 500, { error: 'Internal Error', message: (err as Error).message });
    }
    return true;
  }
}
