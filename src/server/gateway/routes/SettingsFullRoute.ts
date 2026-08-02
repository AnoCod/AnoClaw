// SettingsFullRoute — full settings read/write endpoints
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson, readBody } from '../RouteHelpers.js';
import { SettingsManager } from '../../infra/storage/SettingsManager.js';

const SECRET_KEY_PATTERN = /(?:api[-_]?key|token|secret(?:[-_]?hash)?|password|private[-_]?key)$/i;

function sanitizeSettings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSettings);
  if (!value || typeof value !== 'object') return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    sanitized[key] = sanitizeSettings(child);
  }
  return sanitized;
}

export class GetSettingsRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/settings';
  category = 'System';
  description = 'Read full settings (hides LLM apiKey)';
  permission = 'admin';

  handle(_match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    try {
      const sm = SettingsManager.getInstance();
      sendJson(res, 200, sanitizeSettings(sm.all) as Record<string, unknown>);
    } catch (err) {
      sendJson(res, 500, { error: 'Failed to read settings', message: (err as Error).message });
    }
    return true;
  }
}

export class PutSettingRoute implements RouteHandler {
  method = 'PUT' as const;
  path = '/api/v1/settings/:key';
  category = 'System';
  description = 'Update a setting value (dot-notation key)';
  permission = 'admin';

  async handle(
    match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null,
  ): Promise<boolean> {
    try {
      const key = match.params['key'];
      if (!key) {
        sendJson(res, 400, { error: 'key path param is required' });
        return true;
      }
      const body = await readBody(req);
      if (!('value' in body)) {
        sendJson(res, 400, { error: 'value field is required in body' });
        return true;
      }
      const sm = SettingsManager.getInstance();
      await sm.set(key, body.value);
      await sm.save();
      if (SECRET_KEY_PATTERN.test(key.split('.').at(-1) || '')) {
        sendJson(res, 200, { key, configured: Boolean(body.value) });
      } else {
        sendJson(res, 200, { key, value: sm.get(key) });
      }
    } catch (err) {
      sendJson(res, 500, { error: 'Failed to update setting', message: (err as Error).message });
    }
    return true;
  }
}
