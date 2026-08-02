import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installPluginFromUrl, PluginInstallError } from '../PluginInstaller.js';

const tempDirs: string[] = [];

function makeTempPluginsDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anoclaw-plugin-install-'));
  tempDirs.push(root);
  return path.join(root, 'plugins');
}

function jsonFetch(files: Record<string, string>): typeof fetch {
  return (async () => new Response(JSON.stringify({ files }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
}

function manifest(name = 'verified-plugin', page = true): string {
  return JSON.stringify({
    name,
    displayName: 'Verified Plugin',
    version: '1.0.0',
    main: 'extension.js',
    activationEvents: ['onStartup'],
    contributes: page ? { pages: [{ id: 'verified', title: 'Verified', html: 'frontend/index.html' }] } : {},
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('PluginInstaller', () => {
  it('publishes a fully validated bundle with one final rename', async () => {
    const pluginsDir = makeTempPluginsDir();
    const result = await installPluginFromUrl({
      url: 'https://plugins.example.test/verified.json',
      requestedName: 'verified-plugin',
      pluginsDir,
      fetchImpl: jsonFetch({
        'plugin.json': manifest(),
        'extension.js': 'export async function activate() {}',
        'frontend/index.html': '<!doctype html><title>Verified</title>',
      }),
    });

    expect(result.name).toBe('verified-plugin');
    expect(fs.existsSync(path.join(pluginsDir, 'verified-plugin', 'extension.js'))).toBe(true);
    expect(fs.readdirSync(pluginsDir).filter(name => name.startsWith('.install-'))).toEqual([]);
  });

  it('rejects requested-name and manifest-name mismatches without leaving a partial directory', async () => {
    const pluginsDir = makeTempPluginsDir();

    await expect(installPluginFromUrl({
      url: 'https://plugins.example.test/mismatch.json',
      requestedName: 'expected-plugin',
      pluginsDir,
      fetchImpl: jsonFetch({
        'plugin.json': manifest('different-plugin', false),
        'extension.js': 'export async function activate() {}',
      }),
    })).rejects.toThrow('does not match manifest name');

    expect(fs.existsSync(path.join(pluginsDir, 'expected-plugin'))).toBe(false);
    expect(fs.existsSync(path.join(pluginsDir, 'different-plugin'))).toBe(false);
  });

  it('requires every manifest-declared page before reporting installation success', async () => {
    const pluginsDir = makeTempPluginsDir();

    await expect(installPluginFromUrl({
      url: 'https://plugins.example.test/incomplete.json',
      pluginsDir,
      fetchImpl: jsonFetch({
        'plugin.json': manifest(),
        'extension.js': 'export async function activate() {}',
      }),
    })).rejects.toThrow('Plugin page file is missing');

    expect(fs.existsSync(path.join(pluginsDir, 'verified-plugin'))).toBe(false);
  });

  it('does not overwrite an existing plugin directory', async () => {
    const pluginsDir = makeTempPluginsDir();
    fs.mkdirSync(path.join(pluginsDir, 'verified-plugin'), { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'verified-plugin', 'keep.txt'), 'user data', 'utf8');

    const promise = installPluginFromUrl({
      url: 'https://plugins.example.test/existing.json',
      pluginsDir,
      fetchImpl: jsonFetch({
        'plugin.json': manifest('verified-plugin', false),
        'extension.js': 'export async function activate() {}',
      }),
    });
    await expect(promise).rejects.toBeInstanceOf(PluginInstallError);
    expect(fs.readFileSync(path.join(pluginsDir, 'verified-plugin', 'keep.txt'), 'utf8')).toBe('user data');
  });

  it('rejects an HTTPS source that redirects to an insecure download', async () => {
    const pluginsDir = makeTempPluginsDir();
    const response = new Response(JSON.stringify({ files: {} }), { status: 200 });
    Object.defineProperty(response, 'url', { value: 'http://plugins.example.test/bundle.json' });

    await expect(installPluginFromUrl({
      url: 'https://plugins.example.test/redirect.json',
      pluginsDir,
      fetchImpl: (async () => response) as typeof fetch,
    })).rejects.toThrow('redirected to an insecure URL');
  });
});
