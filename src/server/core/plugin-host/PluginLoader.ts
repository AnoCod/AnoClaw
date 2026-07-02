// PluginLoader.ts — Scans plugins/ directory, parses plugin.json manifests
// Validates required fields, resolves paths, returns PluginState array.

import * as fs from 'fs';
import * as path from 'path';
import { PATHS } from '../../../shared/constants.js';
import type { PluginManifest, PluginState } from './PluginRPC.js';
import { writablePath } from '../../infra/WritablePath.js';

/** Reject names that could escape via path traversal */
function safeName(name: string): void {
  if (/[/\\]/.test(name) || name === '..' || name === '.') {
    throw new Error(`Invalid plugin name: "${name}"`);
  }
}

export class PluginLoader {

  /** Base plugins directory (resolved from repo root) */
  private _pluginsDir: string;

  constructor(pluginsDir?: string) {
    this._pluginsDir = pluginsDir || writablePath(PATHS.plugins);
  }

  get pluginsDir(): string { return this._pluginsDir; }

  /** Scan plugins/ and load all valid manifests. Returns PluginState for each. */
  loadAll(): PluginState[] {
    const states: PluginState[] = [];

    if (!fs.existsSync(this._pluginsDir)) {
      fs.mkdirSync(this._pluginsDir, { recursive: true });
      return states;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this._pluginsDir, { withFileTypes: true });
    } catch {
      return states;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;

      try {
        const state = this.loadOne(entry.name);
        if (state) states.push(state);
      } catch (err) {
        // One bad plugin shouldn't block others from loading
        states.push({
          manifest: { name: entry.name, displayName: entry.name, version: '0.0.0', main: '', activationEvents: [] },
          pluginPath: path.join(this._pluginsDir, entry.name),
          status: 'error',
          errorMessage: `Load failed: ${(err as Error).message}`,
        });
      }
    }

    return states;
  }

  /** Load a single plugin by directory name. Returns null if invalid. */
  loadOne(pluginName: string): PluginState | null {
    safeName(pluginName);
    const pluginPath = path.join(this._pluginsDir, pluginName);
    const manifestPath = path.join(pluginPath, 'plugin.json');

    if (!fs.existsSync(manifestPath)) {
      return null;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(manifestPath, 'utf-8');
    } catch {
      return null;
    }

    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(raw) as PluginManifest;
    } catch {
      return makeErrorState(pluginPath, 'Invalid JSON in plugin.json');
    }

    if (!manifest.name) return makeErrorState(pluginPath, 'Missing "name" in plugin.json');
    if (!manifest.main) return makeErrorState(pluginPath, 'Missing "main" in plugin.json');

    // Resolve main entry to absolute path
    const mainPath = path.resolve(pluginPath, manifest.main);
    if (!fs.existsSync(mainPath)) {
      return makeErrorState(pluginPath, `Entry file not found: ${manifest.main}`);
    }

    return {
      manifest,
      pluginPath,
      status: 'loaded',
    };
  }
}

function makeErrorState(pluginPath: string, message: string): PluginState {
  const name = path.basename(pluginPath);
  return {
    manifest: { name, displayName: name, version: '0.0.0', main: '', activationEvents: [] },
    pluginPath,
    status: 'error',
    errorMessage: message,
  };
}
