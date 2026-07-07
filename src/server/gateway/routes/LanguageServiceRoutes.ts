// LanguageServiceRoutes — Monaco language intelligence bridge.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { ApiToken } from '../ApiAuth.js';
import { readBody, sendJson } from '../RouteHelpers.js';
import { handleLanguageServiceRequest } from '../handlers/LanguageServiceHandlers.js';

abstract class LanguageServiceRoute implements RouteHandler {
  readonly method = 'POST' as const;
  readonly category = 'Workspace';
  readonly permission = 'workspace:read';
  abstract readonly path: string;
  abstract readonly description: string;
  abstract readonly operation: 'completions' | 'hover' | 'definition' | 'diagnostics' | 'organize-imports';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleLanguageServiceRequest(this.operation, req, res, sendJson, readBody);
    return true;
  }
}

export class LanguageCompletionsRoute extends LanguageServiceRoute {
  readonly path = '/api/v1/workspace/language/completions';
  readonly description = 'Workspace language completions';
  readonly operation = 'completions' as const;
}

export class LanguageHoverRoute extends LanguageServiceRoute {
  readonly path = '/api/v1/workspace/language/hover';
  readonly description = 'Workspace language hover information';
  readonly operation = 'hover' as const;
}

export class LanguageDefinitionRoute extends LanguageServiceRoute {
  readonly path = '/api/v1/workspace/language/definition';
  readonly description = 'Workspace language go-to-definition';
  readonly operation = 'definition' as const;
}

export class LanguageDiagnosticsRoute extends LanguageServiceRoute {
  readonly path = '/api/v1/workspace/language/diagnostics';
  readonly description = 'Workspace language diagnostics';
  readonly operation = 'diagnostics' as const;
}

export class LanguageOrganizeImportsRoute extends LanguageServiceRoute {
  readonly path = '/api/v1/workspace/language/organize-imports';
  readonly description = 'Workspace TypeScript organize imports';
  readonly operation = 'organize-imports' as const;
}
