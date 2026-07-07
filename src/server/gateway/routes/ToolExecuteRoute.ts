// ToolExecuteRoute — Execute any built-in tool by name.
// POST /api/v1/tools/execute
// Body: { toolName: string, params: object }
// Returns the tool's result (content, success, errorMessage).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteMatch, RouteHandler } from '../RouteHandler.js';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson, readBody, sendRedirect } from '../RouteHelpers.js';
import { ToolRegistry } from '../../core/tools/ToolRegistry.js';
import { SessionManager } from '../../core/session/SessionManager.js';
import type { ExecutionContext } from '../../../shared/types/session.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('anochat.route.tool-exec');

export class ToolExecuteRoute implements RouteHandler {
  readonly method = 'POST';
  readonly path = '/api/v1/tools/execute';
  readonly description = 'Execute any built-in tool by name with parameters. Returns the tool result (content, success, errorMessage).';
  readonly category = 'Tool';
  readonly permission = 'admin';

  async handle(
    _match: RouteMatch,
    req: IncomingMessage,
    res: ServerResponse,
    _token: ApiToken | null,
  ): Promise<boolean> {
    try {
      const body = await readBody(req);
      const toolName = body.toolName as string | undefined;
      if (!toolName) { sendJson(res, 400, { error: 'Missing "toolName" field' }); return true; }

      const params = (body.params as Record<string, unknown>) || {};
      const registry = ToolRegistry.getInstance();

      const tool = registry.allTools().find(t => t.name() === toolName);
      if (!tool) {
        sendJson(res, 404, { error: `Tool "${toolName}" not found` });
        return true;
      }

      const sessionId = (body.sessionId as string) || `tool-exec-${toolName}`;
      const requestedMode = normalizeToolExecutionMode(body.mode);
      const ctx: ExecutionContext = {
        sessionId,
        agentId: (body.agentId as string) || 'tool-exec',
        workspace: SessionManager.getInstance().session(sessionId)?.workspace || process.cwd(),
        userConfirmed: body.userConfirmed === true,
        ...(requestedMode ? { mode: requestedMode } : {}),
      };

      const result = await registry.execute(toolName, params, ctx);
      sendJson(res, 200, {
        content: result.content,
        success: result.success,
        errorMessage: result.errorMessage,
        structured: result.structured || null,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Tool execute failed', { error: msg });
      sendJson(res, 500, { error: 'Tool execute failed', message: msg });
      return true;
    }
  }
}

function normalizeToolExecutionMode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  switch (value) {
    case 'Ask':
    case 'ask':
      return 'ask';
    case 'AutoEdit':
    case 'auto-edit':
    case 'auto_edit':
      return 'auto_edit';
    case 'Plan':
    case 'plan':
    case 'read_only':
    case 'readOnly':
      return 'read_only';
    case 'Auto':
    case 'auto':
      return 'auto';
    default:
      return value;
  }
}

/** Redirect old singular path to new plural path */
export class ToolExecuteRedirectRoute implements RouteHandler {
  readonly method = 'POST';
  readonly path = '/api/v1/tool/execute';

  handle(_match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    sendRedirect(res, '/api/v1/tools/execute');
    return true;
  }
}
