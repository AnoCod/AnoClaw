import { describe, it, expect, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiCallTool } from '../builtin/ApiCallTool.js';
import { Tool, RiskLevel } from '../Tool.js';
import { ToolRegistry } from '../ToolRegistry.js';
import { ApiServer } from '../../../gateway/ApiServer.js';
import type { RouteHandler, RouteMatch } from '../../../gateway/RouteHandler.js';
import { readBody, sendJson } from '../../../gateway/RouteHelpers.js';
import type { ApiToken } from '../../../gateway/ApiAuth.js';
import { ToolsListRoute } from '../../../gateway/routes/ToolsRoute.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import type { ToolResult } from '../../../../shared/types/tool.js';

const ctx: ExecutionContext = {
  sessionId: 'api-call-test-session',
  agentId: 'api-call-test-agent',
  workspace: process.cwd(),
  userConfirmed: true,
};

describe('ApiCallTool', () => {
  let api: ApiServer;
  let tool: ApiCallTool;

  beforeEach(() => {
    api = ApiServer.getInstance();
    (api as unknown as { _routeTable: RouteHandler[] })._routeTable = [];
    (api as unknown as { _endpointRegistry: unknown[] })._endpointRegistry = [];
    (api as unknown as { _pluginRoutes: unknown[] })._pluginRoutes = [];
    ToolRegistry.resetInstance();
    ToolRegistry.getInstance().registerTool(new MemorySearchFixtureTool(), 'memory');
    tool = new ApiCallTool();

    api.registerRoute(new LargePayloadRoute());
    api.registerRoute(new SlowRoute());
    api.registerRoute(new ItemDetailRoute());
    api.registerRoute(new ItemUpdateRoute());
    api.registerRoute(new ToolsListRoute());
    api.registerNonDeclarativeEndpoint('POST', '/api/v1/memory', 'Create a memory entry', 'Memory');
  });

  it('builds API paths from params and query objects', async () => {
    const result = await tool.execute({
      path: '/api/v1/items/:id?existing=1',
      params: { id: 'alpha/beta' },
      query: {
        groupId: 'core team',
        tag: ['a', 'b'],
        active: true,
        omitted: null,
      },
    }, ctx);

    expect(result.success).toBe(true);
    const body = JSON.parse(result.content) as {
      id: string;
      existing: string | null;
      groupId: string | null;
      tags: string[];
      active: string | null;
      hasOmitted: boolean;
    };

    expect(body.id).toBe('alpha/beta');
    expect(body.existing).toBe('1');
    expect(body.groupId).toBe('core team');
    expect(body.tags).toEqual(['a', 'b']);
    expect(body.active).toBe('true');
    expect(body.hasOmitted).toBe(false);
    expect((result.structured as Record<string, unknown>).path).toContain('/api/v1/items/alpha%2Fbeta?');
  });

  it('supports PUT requests end to end', async () => {
    const schema = tool.parametersSchema() as {
      properties: { method: { enum: string[] } };
    };
    expect(schema.properties.method.enum).toContain('PUT');

    const result = await tool.execute({
      method: 'PUT',
      path: '/api/v1/items/:id',
      params: { id: 'item-1' },
      body: { name: 'Updated Item' },
    }, ctx);

    expect(result.success).toBe(true);
    const body = JSON.parse(result.content) as {
      updated: boolean;
      id: string;
      body: Record<string, unknown>;
    };
    expect(body).toEqual({
      updated: true,
      id: 'item-1',
      body: { name: 'Updated Item' },
    });
    expect((result.structured as Record<string, unknown>).method).toBe('PUT');
  });

  it('discovers endpoints with text, method, and limit filters', async () => {
    const result = await tool.execute({
      action: 'discover',
      search: 'update item',
      method: 'PUT',
      limit: 5,
    }, ctx);

    expect(result.success).toBe(true);
    const body = JSON.parse(result.content) as {
      endpoints: Array<{ method: string; path: string; description: string; category?: string }>;
      total: number;
      availableTotal: number;
      filters: Record<string, unknown>;
    };

    expect(body.availableTotal).toBeGreaterThanOrEqual(3);
    expect(body.total).toBe(1);
    expect(body.endpoints).toEqual([
      expect.objectContaining({
        method: 'PUT',
        path: '/api/v1/items/:id',
        description: 'Update item detail',
      }),
    ]);
    expect(body.filters).toEqual(expect.objectContaining({ method: 'PUT', search: 'update item', limit: 5 }));
    const structured = result.structured as Record<string, unknown>;
    expect(structured.action).toBe('discover');
    expect(structured.resultCount).toBe(1);
  });

  it('defaults to discovery when search is provided without a path', async () => {
    const result = await tool.execute({ search: 'memory' }, ctx);

    expect(result.success).toBe(true);
    const body = JSON.parse(result.content) as {
      endpoints: Array<{ path: string }>;
    };
    expect(body.endpoints.map((endpoint) => endpoint.path)).toContain('/api/v1/memory');
  });

  it('discovers tools as a first-class action', async () => {
    const schema = tool.parametersSchema() as {
      properties: { action: { enum: string[] } };
    };
    expect(schema.properties.action.enum).toContain('tools');

    const result = await tool.execute({
      action: 'tools',
      search: 'memory query',
      readOnly: true,
      detail: true,
      limit: 3,
    }, ctx);

    expect(result.success).toBe(true);
    const body = JSON.parse(result.content) as {
      tools: Array<{
        name: string;
        isReadOnly: boolean;
        parameterNames: string[];
        parameters?: Record<string, unknown>;
      }>;
      total: number;
      filters: Record<string, unknown>;
      detail: boolean;
    };

    expect(body.total).toBe(1);
    expect(body.detail).toBe(true);
    expect(body.filters).toEqual(expect.objectContaining({ search: 'memory query', readOnly: true, limit: 3 }));
    expect(body.tools[0]).toEqual(expect.objectContaining({
      name: 'MemorySearchFixture',
      isReadOnly: true,
      parameterNames: ['query', 'limit'],
    }));
    expect(body.tools[0].parameters).toEqual(expect.objectContaining({ type: 'object' }));

    const structured = result.structured as Record<string, unknown>;
    expect(structured.action).toBe('tools');
    expect(structured.method).toBe('GET');
    expect(structured.path).toContain('/api/v1/tools?');
    expect(structured.resultCount).toBe(1);
    expect(tool.userFacingName({ action: 'tools', search: 'memory' })).toBe('Tools');
    expect(tool.getToolUseSummary({ action: 'tools', search: 'memory' })).toBe('tools: memory');
  });

  it('returns a focused error for missing path params', async () => {
    const result = await tool.execute({ path: '/api/v1/items/:id' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe('Missing path params: id');
  });

  it('rejects ambiguous or unsafe request shapes instead of silently coercing them', async () => {
    await expectFailure(
      { action: 'unknown', path: '/api/v1/items/:id', params: { id: 'item-1' } },
      'Unsupported action "unknown". Use call, discover, or tools.',
    );
    await expectFailure(
      { path: 'https://example.test/api/v1/items/item-1' },
      'Only /api/ paths are allowed',
    );
    await expectFailure(
      { path: '/api/v1/items/:id', params: { id: ['bad'] } },
      'params.id must be a string, number, boolean, null, or undefined',
    );
    await expectFailure(
      { path: '/api/v1/items/:id', params: { id: 'item-1' }, query: { nested: { nope: true } } },
      'query.nested must be a string, number, boolean, array, null, or undefined',
    );
    await expectFailure(
      { path: '/api/v1/items/:id', params: { id: 'item-1' }, body: { ignored: true } },
      'body is not supported for GET requests; use query instead',
    );

    async function expectFailure(input: Record<string, unknown>, message: string): Promise<void> {
      const result = await tool.execute(input, ctx);
      expect(result.success).toBe(false);
      expect(result.errorMessage).toBe(message);
      expect(result.structured).toMatchObject({ status: 'invalid_request' });
    }
  });

  it('returns a bounded JSON preview envelope for oversized responses', async () => {
    const result = await tool.execute({
      path: '/api/v1/items/large',
      max_response_chars: 500,
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.wasTruncated).toBe(true);
    const body = JSON.parse(result.content) as {
      _truncated: boolean;
      responseChars: number;
      maxResponseChars: number;
      preview: string;
    };
    expect(body._truncated).toBe(true);
    expect(body.responseChars).toBeGreaterThan(500);
    expect(body.maxResponseChars).toBe(500);
    expect(body.preview).toContain('ApiCall response truncated');
    expect(result.structured).toMatchObject({
      path: '/api/v1/items/large',
      wasTruncated: true,
      maxResponseChars: 500,
    });
  });

  it('times out stalled internal routes with structured feedback', async () => {
    const result = await tool.execute({
      path: '/api/v1/items/slow',
      timeout_ms: 100,
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('ApiCall timed out after 100ms');
    expect(result.structured).toMatchObject({
      path: '/api/v1/items/slow',
      status: 'timeout',
      timeoutMs: 100,
    });
  });
});

class ItemDetailRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/items/:id';
  description = 'Read item detail';
  category = 'Items';

  handle(
    match: RouteMatch,
    _req: IncomingMessage,
    res: ServerResponse,
    _token: ApiToken | null,
  ): boolean {
    sendJson(res, 200, {
      id: match.params.id,
      existing: match.query.get('existing'),
      groupId: match.query.get('groupId'),
      tags: match.query.getAll('tag'),
      active: match.query.get('active'),
      hasOmitted: match.query.has('omitted'),
    });
    return true;
  }
}

class ItemUpdateRoute implements RouteHandler {
  method = 'PUT' as const;
  path = '/api/v1/items/:id';
  description = 'Update item detail';
  category = 'Items';

  async handle(
    match: RouteMatch,
    req: IncomingMessage,
    res: ServerResponse,
    _token: ApiToken | null,
  ): Promise<boolean> {
    const body = await readBody(req);
    sendJson(res, 200, { updated: true, id: match.params.id, body });
    return true;
  }
}

class LargePayloadRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/items/large';
  description = 'Read large payload';
  category = 'Items';

  handle(
    _match: RouteMatch,
    _req: IncomingMessage,
    res: ServerResponse,
    _token: ApiToken | null,
  ): boolean {
    sendJson(res, 200, {
      id: 'large',
      data: 'x'.repeat(5000),
      tail: 'large payload tail',
    });
    return true;
  }
}

class SlowRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/items/slow';
  description = 'Slow item detail';
  category = 'Items';

  async handle(
    _match: RouteMatch,
    _req: IncomingMessage,
    res: ServerResponse,
    _token: ApiToken | null,
  ): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, 250));
    sendJson(res, 200, { ok: true });
    return true;
  }
}

class MemorySearchFixtureTool extends Tool {
  static category = 'Memory';

  name(): string { return 'MemorySearchFixture'; }
  description(): string { return 'Search memory entries by query text.'; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        limit: { type: 'number', description: 'Maximum results.' },
      },
      required: ['query'],
    };
  }
  riskLevel(): RiskLevel { return RiskLevel.Safe; }
  isReadOnly(): boolean { return true; }
  isConcurrencySafe(): boolean { return true; }
  async execute(_params: Record<string, unknown>, _ctx: ExecutionContext): Promise<ToolResult> {
    return this.makeResult('[]');
  }
}
