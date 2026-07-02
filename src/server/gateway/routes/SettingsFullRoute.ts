// SettingsFullRoute — full settings read/write endpoints
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson, readBody } from '../RouteHelpers.js';
import { SettingsManager } from '../../infra/storage/SettingsManager.js';

export class GetSettingsRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/settings';
  category = 'System';
  description = 'Read full settings (hides LLM apiKey)';

  handle(_match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    try {
      const sm = SettingsManager.getInstance();
      const all = sm.all;
      // Sanitize: remove LLM apiKey from response
      if (all.llm && typeof all.llm === 'object') {
        const llm = { ...all.llm as Record<string, unknown> };
        delete llm.apiKey;
        all.llm = llm;
      }
      sendJson(res, 200, all);
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
      sendJson(res, 200, { key, value: sm.get(key) });
    } catch (err) {
      sendJson(res, 500, { error: 'Failed to update setting', message: (err as Error).message });
    }
    return true;
  }
}
