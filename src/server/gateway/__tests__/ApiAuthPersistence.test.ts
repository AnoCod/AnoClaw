import { afterEach, describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { initAuthStore, tokenCount, validateToken } from '../ApiAuth.js';

describe('API authentication bootstrap', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
  });

  it('persists the complete generated administrator token and reloads it', async () => {
    const configDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-api-auth-'));
    tempDirs.push(configDir);

    await initAuthStore(configDir);

    const configPath = path.join(configDir, 'api.json');
    const stored = JSON.parse(await fsp.readFile(configPath, 'utf8')) as {
      tokens: Array<{ token: string; permissions: string[] }>;
    };
    expect(stored.tokens).toHaveLength(1);
    expect(stored.tokens[0].token).toMatch(/^ano_sk_[a-f0-9]{32}$/);
    expect(stored.tokens[0].permissions).toContain('admin');
    expect(validateToken(stored.tokens[0].token)).not.toBeNull();

    await initAuthStore(configDir);
    expect(tokenCount()).toBe(1);
    expect(validateToken(stored.tokens[0].token)).not.toBeNull();
  });
});
