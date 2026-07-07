// SettingsRoutes — UI settings persistence via SettingsManager
// GET /api/v1/settings/ui — returns current UI settings
// PUT /api/v1/settings/ui — updates UI settings

import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson, readBody } from '../RouteHelpers.js';
import { SettingsManager } from '../../infra/storage/SettingsManager.js';
import { requireWsAny } from "../WsRequired.js";
import { LogManager } from '../../infra/logging/LogManager.js';

const UI_DEFAULTS: Record<string, unknown> = {
  lang: 'zh-CN',
  userMode: 'simple',
  theme: 'dark',
  accentColor: '#ffffff',
  showThinkCards: true,
  showToolCards: true,
  compactionThreshold: 70,
};

export class GetSettingsRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/settings/ui';
  permission = 'admin';

  async handle(
    _match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null,
  ): Promise<boolean> {
    const sm = SettingsManager.getInstance();
    const ui = sm.get<Record<string, unknown>>('ui', {});
    sendJson(res, 200, { ...UI_DEFAULTS, ...ui });
    return true;
  }
}

export class PutSettingsRoute implements RouteHandler {
  method = 'PUT' as const;
  path = '/api/v1/settings/ui';
  permission = 'admin';

  async handle(
    _match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null,
  ): Promise<boolean> {
    if (!requireWsAny(res, sendJson)) return true;
    try {
      const body = await readBody(req);
      const sm = SettingsManager.getInstance();
      const current = sm.get<Record<string, unknown>>('ui', {});
      const merged = { ...UI_DEFAULTS, ...current, ...body };
      await sm.set('ui', merged);
      await sm.save();
      LogManager.getInstance().logger('anochat.api').info('Settings updated', { keys: Object.keys(body) });
      sendJson(res, 200, merged);
    } catch (err) {
      sendJson(res, 500, { error: 'Failed to save settings', message: (err as Error).message });
    }
    return true;
  }
}
