// MemoryRoutes — memory-related HTTP endpoints extracted from ApiServer
// Handles: list, update, delete memory entries (team + agent scopes)
// Part of the AnoClaw v2.0 rewrite: Gateway system (SA-10)

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import type { ApiServer } from '../ApiServer.js';
import type { ApiToken } from '../ApiAuth.js';
import { ApiPermission } from '../../../shared/types/gateway.js';
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

/** Internal: MemoryEntry with the agent directory it was loaded from */
interface AgentMemoryEntry extends MemoryEntry {
  _sourceAgentId: string;
}

// ---------------------------------------------------------------------------
// MemoryRoutes
// ---------------------------------------------------------------------------

export class MemoryRoutes {
  constructor(private _apiServer: ApiServer) {}

  /**
   * Route memory-related requests.
   * Returns true if the request was handled, false otherwise.
   */
  handle(
    method: string,
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    token: ApiToken | null,
  ): boolean {
    // ── Memory ──
    if (pathname === '/api/v1/memory' && method === 'GET') {
      this._apiServer.requirePermission(token, ApiPermission.MemoryRead);
      this.handleListMemories(req, res);
      return true;
    }
    if (pathname === '/api/v1/memory' && method === 'POST') {
      this._apiServer.requirePermission(token, ApiPermission.MemoryWrite);
      this.handleCreateMemory(req, res);
      return true;
    }
    const memoryByIdMatch = pathname.match(/^\/api\/v1\/memory\/([a-zA-Z0-9_\-\.]+)$/);
    if (memoryByIdMatch && method === 'PATCH') {
      this._apiServer.requirePermission(token, ApiPermission.MemoryWrite);
      this.handleUpdateMemory(memoryByIdMatch[1], req, res);
      return true;
    }
    if (memoryByIdMatch && method === 'DELETE') {
      this._apiServer.requirePermission(token, ApiPermission.MemoryWrite);
      this.handleDeleteMemory(memoryByIdMatch[1], res);
      return true;
    }

    return false;
  }

  // ── Memory helpers ──

  /** Collect all memory entries from team/ and all agents/ subdirectories */
  private async _collectAllEntries(): Promise<AgentMemoryEntry[]> {
    const memoryManager = MemoryManager.getInstance();
    const baseDir = path.resolve(process.cwd(), PATHS.memory);
    const entries: AgentMemoryEntry[] = [];

    // Team memories
    const teamEntries = await memoryManager.search('system', MemoryScope.Team, '');
    for (const e of teamEntries) {
      entries.push({ ...e, _sourceAgentId: 'team' });
    }

    // Agent personal memories — iterate over all agent directories
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
      // agents/ directory may not exist yet — no agent memories
    }

    return entries;
  }

  /** Transform a backend MemoryEntry into the frontend-compatible format */
  private toFrontendMemoryEntry(entry: MemoryEntry, agentId?: string): FrontendMemoryEntry {
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

  // ── Memory endpoint handlers ──

  /** GET /api/v1/memory — list all memory entries */
  private async handleListMemories(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const allEntries = await this._collectAllEntries();
      const frontendEntries = allEntries.map((e) => this.toFrontendMemoryEntry(e, e._sourceAgentId));
      this._apiServer.sendJson(res, 200, frontendEntries);
    } catch (err) {
      this._apiServer.sendJson(res, 500, { error: 'Internal Error', message: (err as Error).message });
    }
  }

  /** POST /api/v1/memory — create a new memory entry */
  private async handleCreateMemory(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!requireWsAny(res, this._apiServer.sendJson.bind(this._apiServer))) return;
    try {
      const body = await this._apiServer.readBody(req);
      const name = (body.name as string)?.trim();
      if (!name) {
        this._apiServer.sendJson(res, 400, { error: 'Bad Request', message: 'name is required' });
        return;
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
      this._apiServer.sendJson(res, 201, this.toFrontendMemoryEntry(entry, agentId));
    } catch (err) {
      this._apiServer.sendJson(res, 500, { error: 'Internal Error', message: (err as Error).message });
    }
  }

  /** PATCH /api/v1/memory/:id — update a memory entry (id = entry name) */
  private async handleUpdateMemory(
    name: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!requireWsAny(res, this._apiServer.sendJson.bind(this._apiServer))) return;
    try {
      const body = await this._apiServer.readBody(req);
      const memoryManager = MemoryManager.getInstance();
      const allEntries = await this._collectAllEntries();
      const found = allEntries.find((e) => e.name === name);
      if (!found) {
        this._apiServer.sendJson(res, 404, { error: 'Not Found', message: `Memory '${name}' not found` });
        return;
      }

      // H-7: Create a new object instead of mutating the found entry (prevents cache pollution)
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

      // CR-2: Use the real agentId from the source directory, not 'system'
      const realAgentId = found._sourceAgentId;
      await memoryManager.save(realAgentId, updated.scope || MemoryScope.Agent, updated);
      this._apiServer.sendJson(res, 200, this.toFrontendMemoryEntry(updated, realAgentId) as unknown as Record<string, unknown>);
    } catch (err) {
      this._apiServer.sendJson(res, 500, { error: 'Internal Error', message: (err as Error).message });
    }
  }

  /** DELETE /api/v1/memory/:id — delete a memory entry (id = entry name) */
  private async handleDeleteMemory(
    name: string,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!requireWsAny(res, this._apiServer.sendJson.bind(this._apiServer))) return;
    try {
      const memoryManager = MemoryManager.getInstance();
      const allEntries = await this._collectAllEntries();
      const found = allEntries.find((e) => e.name === name);
      if (!found) {
        this._apiServer.sendJson(res, 404, { error: 'Not Found', message: `Memory '${name}' not found` });
        return;
      }
      const realAgentId = found._sourceAgentId;
      const scope = (found.scope as MemoryScope) || MemoryScope.Agent;
      const deleted = await memoryManager.remove(realAgentId, scope, name);
      if (!deleted) {
        this._apiServer.sendJson(res, 404, { error: 'Not Found', message: `Memory '${name}' could not be deleted` });
        return;
      }
      this._apiServer.sendJson(res, 200, { name, deleted: true });
    } catch (err) {
      this._apiServer.sendJson(res, 500, { error: 'Internal Error', message: (err as Error).message });
    }
  }
}
