// ToolsRoute — GET /api/v1/tools and GET /api/v1/commands

import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson } from '../RouteHelpers.js';
import { ToolRegistry } from '../../core/tools/ToolRegistry.js';
import type { ToolDetailMeta, ToolMeta } from '../../core/tools/ToolRegistry.js';
import { CommandRegistry } from '../../core/commands/CommandRegistry.js';
import { ToolProfiler } from '../../infra/supervision/ToolProfiler.js';

type ToolListItem = ToolMeta | ToolDetailMeta;

function parsePositiveLimit(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function parseBoolean(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  return undefined;
}

export function wantsDetails(value: string | null): boolean {
  if (!value) return false;
  return ['1', 'true', 'full', 'detail', 'details'].includes(value.trim().toLowerCase());
}

function toolHaystack(tool: ToolListItem): string {
  return [
    tool.name,
    tool.displayName,
    tool.description,
    tool.group,
    tool.category,
    tool.source,
    tool.pluginName || '',
    tool.riskLevel,
    tool.minRole,
    ...tool.parameterNames,
  ].join(' ').toLowerCase();
}

export function filterToolMeta(tools: ToolListItem[], searchParams: URLSearchParams): {
  tools: ToolListItem[];
  filters: Record<string, string | number | boolean>;
  limit: number;
} {
  const search = (searchParams.get('q') || searchParams.get('search') || '').trim().toLowerCase();
  const group = (searchParams.get('group') || '').trim().toLowerCase();
  const source = (searchParams.get('source') || '').trim().toLowerCase();
  const risk = (searchParams.get('risk') || '').trim().toLowerCase();
  const readOnly = parseBoolean(searchParams.get('readOnly') || searchParams.get('readonly'));
  const limit = parsePositiveLimit(searchParams.get('limit'), 200, 500);

  let filtered = [...tools];
  if (group) filtered = filtered.filter((tool) => tool.group.toLowerCase().includes(group) || tool.category.toLowerCase().includes(group));
  if (source) filtered = filtered.filter((tool) => tool.source.toLowerCase() === source);
  if (risk) filtered = filtered.filter((tool) => tool.riskLevel.toLowerCase() === risk);
  if (readOnly !== undefined) filtered = filtered.filter((tool) => tool.isReadOnly === readOnly);
  if (search) {
    const terms = search.split(/\s+/).filter(Boolean);
    filtered = filtered.filter((tool) => terms.every((term) => toolHaystack(tool).includes(term)));
  }

  const filters: Record<string, string | number | boolean> = { limit };
  if (search) filters.search = search;
  if (group) filters.group = group;
  if (source) filters.source = source;
  if (risk) filters.risk = risk;
  if (readOnly !== undefined) filters.readOnly = readOnly;

  return { tools: filtered.slice(0, limit), filters, limit };
}

export class ToolsListRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/tools';

  category = 'Tools';
  description = 'List and search registered tools with optional detailed metadata';

  handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const includeDetails = wantsDetails(url.searchParams.get('detail'));
    const allTools = ToolRegistry.getInstance().allToolsWithMeta({ includeDetails });
    const { tools, filters } = filterToolMeta(allTools, url.searchParams);
    const groups = ToolRegistry.getInstance().groups();
    sendJson(res, 200, {
      tools,
      groups,
      total: tools.length,
      availableTotal: allTools.length,
      detail: includeDetails,
      filters,
    });
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
  permission = 'sessions:read';

  handle(_match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    const agg = ToolProfiler.getInstance().globalAggregate();
    sendJson(res, 200, agg as unknown as Record<string, unknown>);
    return true;
  }
}
