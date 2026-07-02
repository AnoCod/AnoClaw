// MemoryExtractRoute — auto-extract memories from text
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson, readBody } from '../RouteHelpers.js';
import { MemoryManager } from '../../core/memory/MemoryManager.js';

export class MemoryExtractRoute implements RouteHandler {
  method = 'POST' as const;
  path = '/api/v1/memory/extract';
  category = 'Memory';
  description = 'Auto-extract fact memories from given text (matches remember:/learned:/decided: patterns)';
  permission = 'memory:write';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    try {
      const body = await readBody(req);
      const text = body.text as string;
      const agentId = (body.agentId as string) || 'system';
      if (!text || typeof text !== 'string') {
        sendJson(res, 400, { error: 'text field is required' });
        return true;
      }
      const mm = MemoryManager.getInstance();
      const count = await mm.autoExtract(agentId, [{ role: 'user', content: text }]);
      sendJson(res, 200, { extracted: count });
    } catch (err) {
      sendJson(res, 500, { error: 'Extract failed', message: (err as Error).message });
    }
    return true;
  }
}
