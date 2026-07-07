import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileOrganizationArtifact } from '../extension.js';

describe('anoclaw-files organize tool', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'anoclaw-files-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates a plan artifact without moving files by default', async () => {
    await writeFixtureFiles(root, {
      'notes.txt': 'meeting notes',
      'photo.jpg': 'fake image',
      'data.csv': 'name,value\nalpha,1',
    });
    const apiCall = vi.fn(async (_method: string, _path: string, body: Record<string, unknown>) => ({
      body: {
        artifact: {
          id: 'files-art-test',
          sessionId: body.sessionId,
          title: body.title,
        },
      },
    }));
    const fakeApi = {
      context: { storagePath: path.join(root, '.plugin-data') },
      api: { call: apiCall },
    };

    const result = await createFileOrganizationArtifact({
      folderPath: root,
    }, { sessionId: 'session-1', agentId: 'ceo', workspace: root }, fakeApi);

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.artifactId).toBe('files-art-test');
    expect(result.scannedFiles).toBe(3);
    expect(result.plannedMoves).toBe(3);
    expect(result.movedFiles).toBe(0);
    expect(result.preview).toContain('Documents/notes.txt');
    expect(result.preview).toContain('Images/photo.jpg');
    expect(result.preview).toContain('Spreadsheets/data.csv');
    await expect(fs.stat(path.join(root, 'notes.txt'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, 'Documents', 'notes.txt'))).rejects.toThrow();
    expect(apiCall).toHaveBeenCalledWith('POST', '/api/v1/artifacts', expect.objectContaining({
      sessionId: 'session-1',
      kind: 'automation_result',
      status: 'done',
      capabilityId: 'files.organize',
      preview: expect.objectContaining({ type: 'markdown' }),
    }));
  });

  it('moves files when apply is true and avoids destination conflicts', async () => {
    await fs.mkdir(path.join(root, 'Documents'), { recursive: true });
    await writeFixtureFiles(root, {
      'notes.txt': 'new notes',
      'photo.jpg': 'fake image',
      'Documents/notes.txt': 'existing notes',
    });
    const fakeApi = {
      context: { storagePath: path.join(root, '.plugin-data') },
    };

    const result = await createFileOrganizationArtifact({
      folderPath: root,
      apply: true,
    }, { sessionId: 'standalone', agentId: 'ceo', workspace: root }, fakeApi);

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.movedFiles).toBe(2);
    expect(result.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'Documents', status: 'moved' }),
      expect.objectContaining({ category: 'Images', status: 'moved' }),
    ]));
    await expect(fs.stat(path.join(root, 'notes.txt'))).rejects.toThrow();
    await expect(fs.readFile(path.join(root, 'Documents', 'notes.txt'), 'utf8')).resolves.toBe('existing notes');
    await expect(fs.readFile(path.join(root, 'Documents', 'notes-1.txt'), 'utf8')).resolves.toBe('new notes');
    await expect(fs.stat(path.join(root, 'Images', 'photo.jpg'))).resolves.toBeTruthy();
  });
});

async function writeFixtureFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
  }
}
