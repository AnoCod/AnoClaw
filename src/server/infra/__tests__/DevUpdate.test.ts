import { afterEach, describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { syncUnpacked } = require('../../../../scripts/dev-update.cjs') as {
  syncUnpacked(source: string, destination: string): void;
};

describe('development hot update', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
  });

  it('updates bundled content without deleting user plugins, data, or skills', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-dev-update-'));
    tempDirs.push(root);
    const source = path.join(root, 'source');
    const destination = path.join(root, 'destination');
    await Promise.all([
      fsp.mkdir(path.join(source, 'plugins', 'bundled'), { recursive: true }),
      fsp.mkdir(path.join(source, 'skills', 'bundled'), { recursive: true }),
      fsp.mkdir(path.join(source, 'dist'), { recursive: true }),
      fsp.mkdir(path.join(destination, 'plugins', 'custom'), { recursive: true }),
      fsp.mkdir(path.join(destination, 'plugins', 'bundled', 'data'), { recursive: true }),
      fsp.mkdir(path.join(destination, 'skills', 'custom'), { recursive: true }),
      fsp.mkdir(path.join(destination, 'dist'), { recursive: true }),
    ]);
    await Promise.all([
      fsp.writeFile(path.join(source, 'plugins', 'bundled', 'extension.js'), 'new'),
      fsp.writeFile(path.join(source, 'skills', 'bundled', 'SKILL.md'), 'new skill'),
      fsp.writeFile(path.join(source, 'dist', 'server.js'), 'new dist'),
      fsp.writeFile(path.join(destination, 'plugins', 'custom', 'extension.js'), 'custom'),
      fsp.writeFile(path.join(destination, 'plugins', 'bundled', 'data', 'state.json'), '{}'),
      fsp.writeFile(path.join(destination, 'skills', 'custom', 'SKILL.md'), 'custom skill'),
      fsp.writeFile(path.join(destination, 'dist', 'stale.js'), 'stale'),
    ]);

    syncUnpacked(source, destination);

    await expect(fsp.readFile(path.join(destination, 'plugins', 'custom', 'extension.js'), 'utf8')).resolves.toBe('custom');
    await expect(fsp.readFile(path.join(destination, 'plugins', 'bundled', 'data', 'state.json'), 'utf8')).resolves.toBe('{}');
    await expect(fsp.readFile(path.join(destination, 'skills', 'custom', 'SKILL.md'), 'utf8')).resolves.toBe('custom skill');
    await expect(fsp.readFile(path.join(destination, 'plugins', 'bundled', 'extension.js'), 'utf8')).resolves.toBe('new');
    await expect(fsp.access(path.join(destination, 'dist', 'stale.js'))).rejects.toBeTruthy();
  });
});
