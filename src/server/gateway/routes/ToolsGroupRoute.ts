// ToolsGroupRoute — list tools organized by group
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson } from '../RouteHelpers.js';
import { ToolRegistry } from '../../core/tools/ToolRegistry.js';

export class ToolsGroupRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/tools/groups';
  category = 'Tools';
  description = 'List all tools organized by group';

  handle(_match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    try {
      const tr = ToolRegistry.getInstance();
      const groups = tr.groups();
      const grouped: Record<string, Array<{ name: string; description: string; isReadOnly: boolean; isConcurrencySafe: boolean }>> = {};

      for (const group of groups) {
        const tools = tr.toolsByGroup(group);
        grouped[group] = tools.map(t => ({
          name: t.name(),
          description: t.description(),
          isReadOnly: tr.isReadOnly(t.name()),
          isConcurrencySafe: tr.isConcurrencySafe(t.name()),
        }));
      }

      sendJson(res, 200, {
        groups,
        totalTools: tr.allTools().length,
        toolsByGroup: grouped,
      });
    } catch (err) {
      sendJson(res, 500, { error: 'Failed to list tools', message: (err as Error).message });
    }
    return true;
  }
}
