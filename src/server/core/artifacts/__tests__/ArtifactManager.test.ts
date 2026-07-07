import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactManager } from '../ArtifactManager.js';
import { TypedEventBus } from '../../events/TypedEventBus.js';

describe('ArtifactManager', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'anoclaw-artifacts-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates and persists an artifact with preview and initial version', async () => {
    const manager = new ArtifactManager(root);
    const events: string[] = [];
    const unsubCreated = TypedEventBus.on('artifact:created', () => events.push('created'));
    const unsubPreview = TypedEventBus.on('artifact:preview', () => events.push('preview'));

    const artifact = await manager.create({
      sessionId: 'session-1',
      title: 'Solar System PPT',
      kind: 'presentation',
      capabilityId: 'presentation.create',
      preview: { type: 'markdown', content: '# Solar System' },
      files: [{ path: 'slides.pptx', role: 'primary', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }],
    });

    expect(artifact.id).toMatch(/^art-/);
    expect(artifact.versions).toHaveLength(1);
    expect(artifact.preview?.content).toBe('# Solar System');
    expect(events).toEqual(['created', 'preview']);
    await expect(manager.get('session-1', artifact.id)).resolves.toEqual(artifact);

    unsubCreated();
    unsubPreview();
  });

  it('updates status, preview, metadata, and appends a version', async () => {
    const manager = new ArtifactManager(root);
    const doneIds: string[] = [];
    const unsubDone = TypedEventBus.on('artifact:done', (payload) => doneIds.push(payload.artifactId));

    const created = await manager.create({
      sessionId: 'session-1',
      title: 'Report',
      kind: 'document',
    });
    const updated = await manager.update('session-1', created.id, {
      status: 'done',
      preview: { type: 'markdown', content: 'Done' },
      metadata: { audience: 'team' },
      versionSummary: 'Final report',
    });

    expect(updated.status).toBe('done');
    expect(updated.doneAt).toBeTruthy();
    expect(updated.metadata.audience).toBe('team');
    expect(updated.versions).toHaveLength(2);
    expect(updated.versions[1].summary).toBe('Final report');
    expect(doneIds).toEqual([created.id]);

    unsubDone();
  });

  it('lists artifacts by session, kind, and status', async () => {
    const manager = new ArtifactManager(root);
    await manager.create({ sessionId: 'a', title: 'Slides', kind: 'presentation', status: 'ready' });
    await manager.create({ sessionId: 'a', title: 'Doc', kind: 'document' });
    await manager.create({ sessionId: 'b', title: 'Other Slides', kind: 'presentation' });

    const artifacts = await manager.list({ sessionId: 'a', kind: 'presentation', status: 'ready' });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].title).toBe('Slides');
  });
});
