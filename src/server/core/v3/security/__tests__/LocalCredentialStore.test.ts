import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalCredentialStore } from '../LocalCredentialStore.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    fsp.rm(root, { recursive: true, force: true })
  ));
});

describe('LocalCredentialStore', () => {
  it('encrypts API keys at rest and returns them only from the local secret boundary', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-v3-secret-'));
    temporaryRoots.push(root);
    const filePath = path.join(root, 'credentials.v3.json');
    const store = new LocalCredentialStore(filePath, () => '2026-07-25T00:00:00.000Z');

    const metadata = await store.save({
      provider: 'openai-compatible',
      apiUrl: 'https://llm.example.test',
      model: 'model-v3',
      contextWindow: 128_000,
      apiKey: 'sk-super-secret',
    });
    expect(metadata).not.toHaveProperty('apiKey');

    const raw = await fsp.readFile(filePath, 'utf-8');
    expect(raw).not.toContain('sk-super-secret');
    expect(raw).toContain('enc:');

    const loaded = await store.load();
    expect(loaded).toMatchObject({
      credentialRef: 'local-llm',
      provider: 'openai-compatible',
      apiKey: 'sk-super-secret',
    });
  });

  it('returns null when no credential is configured', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-v3-secret-'));
    temporaryRoots.push(root);
    const store = new LocalCredentialStore(path.join(root, 'missing.json'));
    await expect(store.load()).resolves.toBeNull();
    await expect(store.exists()).resolves.toBe(false);
  });
});
