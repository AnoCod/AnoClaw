import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ApiServer } from '../ApiServer.js';
import type { RouteHandler } from '../RouteHandler.js';
import { GetSettingsRoute } from '../routes/SettingsRoutes.js';
import {
  GetSettingsRoute as GetFullSettingsRoute,
  PutSettingRoute,
} from '../routes/SettingsFullRoute.js';
import { SettingsManager } from '../../infra/storage/SettingsManager.js';

describe('UI settings API routes', () => {
  let api: ApiServer;
  let settings: SettingsManager;
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-ui-settings-'));

    api = ApiServer.getInstance();
    (api as unknown as { _routeTable: RouteHandler[] })._routeTable = [];
    (api as unknown as { _endpointRegistry: unknown[] })._endpointRegistry = [];
    (api as unknown as { _pluginRoutes: unknown[] })._pluginRoutes = [];

    (SettingsManager as unknown as { _instance?: SettingsManager })._instance = undefined;
    settings = SettingsManager.getInstance();
    (settings as unknown as { _configPath: string })._configPath = path.join(tempDir, 'settings.yaml');
    (settings as unknown as { _settings: Record<string, unknown> })._settings = {
      ui: {
        lang: 'en-US',
        theme: 'light',
        retiredPreference: 'obsolete',
      },
    };

    api.registerRoute(new GetSettingsRoute());
  });

  afterEach(async () => {
    settings.stopWatching();
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('returns and persists only supported UI settings', async () => {
    const result = await api.callInternal('GET', '/api/v1/settings/ui');

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({
      lang: 'en-US',
      theme: 'light',
      accentColor: '#0b8ce9',
      showThinkCards: true,
      showToolCards: true,
      compactionThreshold: 70,
    });
    expect(settings.get<Record<string, unknown>>('ui')).toEqual(result.body);
  });

  it('recursively removes credentials from the full settings response', async () => {
    (settings as unknown as { _settings: Record<string, unknown> })._settings = {
      apiKey: 'legacy-secret',
      llm: { apiKey: 'nested-secret', model: 'safe-model' },
      gateway: {
        botToken: 'gateway-secret',
        clientSecret: 'client-secret',
        webhookSecretHash: 'secret-hash',
        enabled: true,
      },
    };
    api.registerRoute(new GetFullSettingsRoute());

    const result = await api.callInternal('GET', '/api/v1/settings');

    expect(result.statusCode).toBe(200);
    expect(JSON.stringify(result.body)).not.toContain('secret');
    expect(result.body).toEqual({
      llm: { model: 'safe-model' },
      gateway: { enabled: true },
    });
  });

  it('stores a legacy apiKey update canonically without echoing the secret', async () => {
    (settings as unknown as { _settings: Record<string, unknown> })._settings = { llm: {} };
    api.registerRoute(new PutSettingRoute());

    const result = await api.callInternal('PUT', '/api/v1/settings/apiKey', { value: 'new-secret' });

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ key: 'apiKey', configured: true });
    expect(settings.get('llm.apiKey')).toBe('new-secret');
    expect(JSON.stringify(result.body)).not.toContain('new-secret');
  });
});
