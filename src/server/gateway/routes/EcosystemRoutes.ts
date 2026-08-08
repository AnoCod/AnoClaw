/**
 * Ecosystem Routes — overview, scan preview, sync, and per-entry controls for
 * the ecosystem bridge (Codex / Claude Code / OpenClaw / OpenCode / Hermes).
 */

import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson } from '../RouteHelpers.js';
import { EcosystemRegistry } from '../../core/ecosystem/EcosystemRegistry.js';

export class EcosystemOverviewRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/ecosystem/overview';
  category = 'Ecosystem';
  description = 'List ecosystem bridge kinds, roots, and discovered entries';
  async handle(_m: RouteMatch, _r: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
      const data = await EcosystemRegistry.getInstance().overview();
      sendJson(res, 200, data);
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class EcosystemScanRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/ecosystem/scan';
  category = 'Ecosystem';
  description = 'Dry-run scan: preview discovered ecosystem assets without mounting';
  async handle(_m: RouteMatch, _r: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
      const entries = await EcosystemRegistry.getInstance().scan();
      sendJson(res, 200, { entries, total: entries.length });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class EcosystemSyncRoute implements RouteHandler {
  method = 'POST' as const;
  path = '/api/v1/ecosystem/sync';
  category = 'Ecosystem';
  description = 'Re-scan sources and mount all enabled ecosystem entries';
  async handle(_m: RouteMatch, _r: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
      const result = await EcosystemRegistry.getInstance().sync();
      sendJson(res, 200, result);
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class EcosystemEnableRoute implements RouteHandler {
  method = 'POST' as const;
  path = '/api/v1/ecosystem/entries/:id/enable';
  category = 'Ecosystem';
  description = 'Enable and live-mount an ecosystem entry';
  async handle(m: RouteMatch, _r: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
      const view = await EcosystemRegistry.getInstance().enable(m.params['id']);
      sendJson(res, 200, view);
    } catch (err) { sendJson(res, 400, { error: (err as Error).message }); }
    return true;
  }
}

export class EcosystemDisableRoute implements RouteHandler {
  method = 'POST' as const;
  path = '/api/v1/ecosystem/entries/:id/disable';
  category = 'Ecosystem';
  description = 'Disable and unmount an ecosystem entry';
  async handle(m: RouteMatch, _r: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
      const view = await EcosystemRegistry.getInstance().disable(m.params['id']);
      sendJson(res, 200, view);
    } catch (err) { sendJson(res, 400, { error: (err as Error).message }); }
    return true;
  }
}

export class EcosystemTrustRoute implements RouteHandler {
  method = 'POST' as const;
  path = '/api/v1/ecosystem/entries/:id/trust';
  category = 'Ecosystem';
  description = 'Mark an ecosystem plugin entry as trusted (required before enabling code plugins)';
  async handle(m: RouteMatch, _r: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
      const view = await EcosystemRegistry.getInstance().trust(m.params['id']);
      sendJson(res, 200, view);
    } catch (err) { sendJson(res, 400, { error: (err as Error).message }); }
    return true;
  }
}

export class EcosystemForgetRoute implements RouteHandler {
  method = 'DELETE' as const;
  path = '/api/v1/ecosystem/entries/:id';
  category = 'Ecosystem';
  description = 'Forget an ecosystem entry (does not delete source files)';
  async handle(m: RouteMatch, _r: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
      const result = await EcosystemRegistry.getInstance().forget(m.params['id']);
      sendJson(res, 200, result);
    } catch (err) { sendJson(res, 400, { error: (err as Error).message }); }
    return true;
  }
}
