import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiServer } from '../ApiServer.js';
import type { RouteHandler } from '../RouteHandler.js';
import { ArtifactManager } from '../../core/artifacts/ArtifactManager.js';
import {
  CreateArtifactRoute,
  GetArtifactRoute,
  ListArtifactsRoute,
  UpdateArtifactRoute,
} from '../routes/ArtifactRoutes.js';

describe('artifact API routes', () => {
  let api: ApiServer;
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'anoclaw-artifact-routes-'));
    const manager = new ArtifactManager(root);
    api = ApiServer.getInstance();
    (api as unknown as { _routeTable: RouteHandler[] })._routeTable = [];
    (api as unknown as { _endpointRegistry: unknown[] })._endpointRegistry = [];
    (api as unknown as { _pluginRoutes: unknown[] })._pluginRoutes = [];
    api.registerRoute(new ListArtifactsRoute(manager));
    api.registerRoute(new CreateArtifactRoute(manager));
    api.registerRoute(new GetArtifactRoute(manager));
    api.registerRoute(new UpdateArtifactRoute(manager));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates, updates, gets, and lists artifacts', async () => {
    const created = await api.callInternal('POST', '/api/v1/artifacts', {
      sessionId: 'session-1',
      title: 'Solar System PPT',
      kind: 'presentation',
      capabilityId: 'presentation.create',
      preview: { type: 'markdown', content: '# Solar System' },
    });

    expect(created.statusCode).toBe(201);
    const artifactId = (created.body.artifact as { id: string }).id;

    const updated = await api.callInternal('PATCH', `/api/v1/artifacts/session-1/${artifactId}`, {
      status: 'done',
      preview: { type: 'markdown', content: '# Final' },
      versionSummary: 'User accepted final deck',
    });

    expect(updated.statusCode).toBe(200);
    expect((updated.body.artifact as { status: string }).status).toBe('done');

    const fetched = await api.callInternal('GET', `/api/v1/artifacts/session-1/${artifactId}`);
    expect(fetched.statusCode).toBe(200);
    expect((fetched.body.artifact as { title: string }).title).toBe('Solar System PPT');

    const listed = await api.callInternal('GET', '/api/v1/artifacts?sessionId=session-1&kind=presentation');
    expect(listed.statusCode).toBe(200);
    expect((listed.body.artifacts as unknown[])).toHaveLength(1);
  });

  it('rejects invalid artifact creation input', async () => {
    const result = await api.callInternal('POST', '/api/v1/artifacts', {
      sessionId: 'session-1',
      title: 'Missing kind',
    });

    expect(result.statusCode).toBe(400);
    expect(result.body.error).toBe('kind is required');
  });
});
