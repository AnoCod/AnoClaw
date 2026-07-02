// MemorySearchRoute — dedicated memory search endpoint
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson } from '../RouteHelpers.js';
import { MemoryManager } from '../../core/memory/MemoryManager.js';
import { MemoryScope, MemoryType } from '../../core/memory/MemoryEntry.js';

export class MemorySearchRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/memory/search';
  category = 'Memory';
  description = 'Fuzzy search memories with scope/type/agent filters';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    try {
      const url = new URL(req.url || '/', `http://localhost`);
      const q = url.searchParams.get('q') || '';
      const scopeStr = url.searchParams.get('scope') || 'all'; // team, agent, session, all
      const typeStr = url.searchParams.get('type') || '';       // user, feedback, project, reference
      const agentId = url.searchParams.get('agent') || 'system';
      const sessionId = url.searchParams.get('session') || undefined;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);

      const mm = MemoryManager.getInstance();
      let results: Array<{ name: string; type: string; scope: string; description: string; content: string; updatedAt?: number }>;

      // Determine search scope
      if (scopeStr === 'all') {
        results = await mm.searchAllScopes(agentId, q, sessionId);
      } else {
        const scope = scopeStr === 'agent' ? MemoryScope.Agent :
                      scopeStr === 'session' ? MemoryScope.Session : MemoryScope.Team;
        results = await mm.search(agentId, scope, q, sessionId);
      }

      // Filter by type
      if (typeStr) {
        const types = typeStr.split(',').map(t => t.trim().toLowerCase());
        results = results.filter(e => types.includes(e.type));
      }

      // Limit
      results = results.slice(0, limit);

      sendJson(res, 200, {
        results: results.map(e => ({
          name: e.name,
          type: e.type,
          scope: e.scope,
          description: e.description,
          content: e.content,
          updatedAt: e.updatedAt,
        })),
        query: q,
        total: results.length,
      });
    } catch (err) {
      sendJson(res, 500, { error: 'Search failed', message: (err as Error).message });
    }
    return true;
  }
}
