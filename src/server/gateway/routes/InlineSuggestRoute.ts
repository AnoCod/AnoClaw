// InlineSuggestRoute — POST /api/v1/inline-suggest
// Lightweight endpoint for Monaco inline code completion.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson, readBody } from '../RouteHelpers.js';
import { handleInlineSuggest } from '../handlers/InlineSuggestHandler.js';

export class InlineSuggestRoute implements RouteHandler {
  method = 'POST' as const;
  path = '/api/v1/inline-suggest';
  description = 'Monaco inline code completion';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleInlineSuggest(req, res, sendJson, readBody);
    return true;
  }
}
