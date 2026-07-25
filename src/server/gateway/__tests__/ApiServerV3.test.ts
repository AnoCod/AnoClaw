import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiServer } from '../ApiServer.js';

describe('ApiServer v3 integration', () => {
  let tempRoot = '';
  let previousCwd = '';
  let api: ApiServer;

  beforeAll(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-api-v3-'));
    previousCwd = process.cwd();
    process.chdir(tempRoot);
    api = ApiServer.getInstance();
  });

  afterAll(async () => {
    process.chdir(previousCwd);
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it('dispatches v3 through the shared raw HTTP server without changing v1 fallback semantics', async () => {
    const missing = await api.callInternal('GET', '/api/v3/company');
    expect(missing).toEqual({
      statusCode: 200,
      body: {
        data: null,
        revision: 0,
      },
    });

    const created = await api.callInternal('POST', '/api/v3/company', {
      name: 'Local Studio',
      defaultLocale: 'zh-CN',
      expectedRevision: 0,
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).toMatchObject({
      data: {
        name: 'Local Studio',
        defaultLocale: 'zh-CN',
      },
      revision: 1,
    });

    const legacyMiss = await api.callInternal('GET', '/api/v1/does-not-exist');
    expect(legacyMiss).toEqual({
      statusCode: 404,
      body: {
        error: 'Not Found',
        message: 'No route for GET /api/v1/does-not-exist',
      },
    });
  });
});
