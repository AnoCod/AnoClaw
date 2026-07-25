import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiServer } from '../ApiServer.js';
import type { RouteHandler } from '../RouteHandler.js';
import { ArtifactManager } from '../../core/artifacts/ArtifactManager.js';
import { SessionManager } from '../../core/session/SessionManager.js';
import { SessionStore } from '../../core/session/SessionStore.js';
import { JsonlStore } from '../../infra/storage/JsonlStore.js';
import {
  CreateArtifactRoute,
  DownloadArtifactFileRoute,
  GetArtifactRoute,
  ListArtifactsRoute,
  UpdateArtifactRoute,
} from '../routes/ArtifactRoutes.js';

describe('artifact API routes', () => {
  let api: ApiServer;
  let root: string;
  let workspace: string;
  let sessionId: string;
  let manager: ArtifactManager;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'anoclaw-artifact-routes-'));
    workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    SessionManager.resetInstance();
    SessionStore.resetInstance();
    JsonlStore.resetInstance();
    const sessions = SessionManager.getInstance();
    await sessions.initialize(path.join(root, 'sessions'));
    sessionId = (await sessions.createMainSession('artifact-test-agent', 'Artifact test', workspace)).id;
    manager = new ArtifactManager(path.join(root, 'artifacts'));
    api = ApiServer.getInstance();
    (api as unknown as { _routeTable: RouteHandler[] })._routeTable = [];
    (api as unknown as { _endpointRegistry: unknown[] })._endpointRegistry = [];
    (api as unknown as { _pluginRoutes: unknown[] })._pluginRoutes = [];
    api.registerRoute(new ListArtifactsRoute(manager));
    api.registerRoute(new CreateArtifactRoute(manager));
    api.registerRoute(new GetArtifactRoute(manager));
    api.registerRoute(new DownloadArtifactFileRoute(manager));
    api.registerRoute(new UpdateArtifactRoute(manager));
  });

  afterEach(async () => {
    SessionManager.resetInstance();
    SessionStore.resetInstance();
    JsonlStore.resetInstance();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('declares workspace permissions for every artifact route', () => {
    expect(new ListArtifactsRoute(manager).permission).toBe('workspace:read');
    expect(new GetArtifactRoute(manager).permission).toBe('workspace:read');
    expect(new DownloadArtifactFileRoute(manager).permission).toBe('workspace:read');
    expect(new CreateArtifactRoute(manager).permission).toBe('workspace:write');
    expect(new UpdateArtifactRoute(manager).permission).toBe('workspace:write');
  });

  it('creates, updates, gets, and lists artifacts', async () => {
    const created = await api.callInternal('POST', '/api/v1/artifacts', {
      sessionId,
      title: 'Solar System PPT',
      kind: 'presentation',
      capabilityId: 'artifact.create',
      preview: { type: 'markdown', content: '# Solar System' },
    });

    expect(created.statusCode).toBe(201);
    const artifactId = (created.body.artifact as { id: string }).id;

    const updated = await api.callInternal('PATCH', `/api/v1/artifacts/${sessionId}/${artifactId}`, {
      status: 'done',
      preview: { type: 'markdown', content: '# Final' },
      versionSummary: 'User accepted final deck',
    });

    expect(updated.statusCode).toBe(200);
    expect((updated.body.artifact as { status: string }).status).toBe('done');

    const fetched = await api.callInternal('GET', `/api/v1/artifacts/${sessionId}/${artifactId}`);
    expect(fetched.statusCode).toBe(200);
    expect((fetched.body.artifact as { title: string }).title).toBe('Solar System PPT');

    const listed = await api.callInternal('GET', `/api/v1/artifacts?sessionId=${sessionId}&kind=presentation`);
    expect(listed.statusCode).toBe(200);
    expect((listed.body.artifacts as unknown[])).toHaveLength(1);
  });

  it('rejects invalid artifact creation input', async () => {
    const result = await api.callInternal('POST', '/api/v1/artifacts', {
      sessionId,
      title: 'Missing kind',
    });

    expect(result.statusCode).toBe(400);
    expect(result.body.error).toBe('kind is required');
  });

  it('downloads an artifact file by index', async () => {
    const filePath = path.join(workspace, 'deck.pptx');
    await fs.writeFile(filePath, 'pptx-bytes');
    const created = await api.callInternal('POST', '/api/v1/artifacts', {
      sessionId,
      title: 'Downloadable PPT',
      kind: 'presentation',
      files: [{ path: filePath, label: 'deck.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }],
    });
    const artifactId = (created.body.artifact as { id: string }).id;

    const downloaded = await api.callInternal('GET', `/api/v1/artifacts/${sessionId}/${artifactId}/files/0`);

    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.body._raw).toBe('pptx-bytes');
  });

  it('rejects artifact files that escape through a symlink or junction', async () => {
    const outside = path.join(root, 'outside');
    const link = path.join(workspace, 'escape');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    const result = await api.callInternal('POST', '/api/v1/artifacts', {
      sessionId,
      title: 'Escaping artifact',
      kind: 'other',
      files: [{ path: path.join(link, 'secret.txt') }],
    });

    expect(result.statusCode).toBe(403);
    expect(result.body.error).toBe('Path escapes workspace root');
  });

  it('rejects an out-of-workspace file added during artifact update', async () => {
    const outsideFile = path.join(root, 'outside.txt');
    await fs.writeFile(outsideFile, 'secret');
    const created = await api.callInternal('POST', '/api/v1/artifacts', {
      sessionId,
      title: 'Safe artifact',
      kind: 'other',
    });
    const artifactId = (created.body.artifact as { id: string }).id;

    const result = await api.callInternal('PATCH', `/api/v1/artifacts/${sessionId}/${artifactId}`, {
      files: [{ path: outsideFile }],
    });

    expect(result.statusCode).toBe(403);
    expect(result.body.error).toBe('Path escapes workspace root');
  });

  it('revalidates stored artifact paths before download', async () => {
    const outsideFile = path.join(root, 'outside-download.txt');
    await fs.writeFile(outsideFile, 'secret');
    const artifact = await manager.create({
      sessionId,
      title: 'Legacy external artifact',
      kind: 'other',
      files: [{ path: outsideFile }],
    });

    const result = await api.callInternal(
      'GET',
      `/api/v1/artifacts/${sessionId}/${artifact.id}/files/0`,
    );

    expect(result.statusCode).toBe(403);
    expect(result.body.error).toBe('Path escapes workspace root');
  });
});
