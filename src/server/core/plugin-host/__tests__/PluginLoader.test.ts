import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginLoader } from '../PluginLoader.js';

const cleanup: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anoclaw-plugin-loader-'));
  cleanup.push(root);
  return root;
}

function writePlugin(root: string, directoryName: string, manifest: Record<string, unknown>): void {
  const pluginDir = path.join(root, directoryName);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'extension.js'), 'export function activate() {}\n', 'utf8');
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(manifest), 'utf8');
}

afterEach(() => {
  for (const root of cleanup.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('PluginLoader path validation', () => {
  it('loads a manifest only when its name matches the directory', () => {
    const root = makeRoot();
    writePlugin(root, 'safe-plugin', {
      name: 'different-plugin',
      displayName: 'Different',
      version: '1.0.0',
      main: 'extension.js',
      activationEvents: [],
    });

    const state = new PluginLoader(root).loadOne('safe-plugin');

    expect(state?.status).toBe('error');
    expect(state?.errorMessage).toContain('does not match directory');
  });

  it('rejects a manifest entry that escapes the plugin directory', () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'outside.js'), 'export function activate() {}\n', 'utf8');
    writePlugin(root, 'safe-plugin', {
      name: 'safe-plugin',
      displayName: 'Safe',
      version: '1.0.0',
      main: '../outside.js',
      activationEvents: [],
    });

    const state = new PluginLoader(root).loadOne('safe-plugin');

    expect(state?.status).toBe('error');
    expect(state?.errorMessage).toContain('escapes plugin directory');
  });
});
