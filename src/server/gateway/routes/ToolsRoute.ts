// ToolsRoute — GET /api/v1/tools and GET /api/v1/commands

import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson } from '../RouteHelpers.js';
import { ToolRegistry } from '../../core/tools/ToolRegistry.js';
import { CommandRegistry } from '../../core/commands/CommandRegistry.js';
import { ToolProfiler } from '../../infra/supervision/ToolProfiler.js';

export class ToolsListRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/tools';

  handle(_match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    const tools = ToolRegistry.getInstance().allToolsWithMeta();
    const groups = ToolRegistry.getInstance().groups();
    sendJson(res, 200, { tools, groups, total: tools.length });
    return true;
  }
}

export class CommandsListRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/commands';

  handle(_match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    const commands = CommandRegistry.getInstance().allCommandDefinitions();
    sendJson(res, 200, commands);
    return true;
  }
}

export class ToolsStatsRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/tools/stats';

  handle(_match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    const agg = ToolProfiler.getInstance().globalAggregate();
    sendJson(res, 200, agg as unknown as Record<string, unknown>);
    return true;
  }
}
