// PluginStorage — simple file-based K/V store for plugins
// Stores data under plugins/<name>/data/<key>.json
// Used by PluginStorageRoutes and PluginConfigRoutes

import * as fs from 'fs';
import * as path from 'path';
import { PATHS } from '../../../shared/constants.js';
import { writablePath } from '../../infra/WritablePath.js';

const PLUGINS_DIR = writablePath(PATHS.plugins);

/** Reject names that could escape via path traversal or contain OS-illegal chars. */
function safeName(name: string): void {
  if (/[/\\]/.test(name) || name === '..' || name === '.') {
    throw new Error(`Invalid name: "${name}"`);
  }
  // Windows-illegal filename characters
  if (/[<>:"|?*]/.test(name)) {
    throw new Error(`Invalid name (contains OS-illegal character): "${name}"`);
  }
}

export class PluginStorage {
  /** List all keys in a plugin's storage */
  static listKeys(pluginName: string): string[] {
    safeName(pluginName);
    const dir = PluginStorage._dataDir(pluginName);
    try {
      return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
    } catch {
      return [];
    }
  }

  /** Get a value by key */
  static get<T = unknown>(pluginName: string, key: string): T | null {
    safeName(pluginName); safeName(key);
    const filePath = PluginStorage._filePath(pluginName, key);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** Set a value by key (atomic write: temp file + rename) */
  static set<T = unknown>(pluginName: string, key: string, value: T): void {
    safeName(pluginName); safeName(key);
    const dir = PluginStorage._dataDir(pluginName);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const filePath = PluginStorage._filePath(pluginName, key);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  /** Delete a key */
  static delete(pluginName: string, key: string): boolean {
    safeName(pluginName); safeName(key);
    const filePath = PluginStorage._filePath(pluginName, key);
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /** Get plugin config (convenience wrapper around 'config' key) */
  static getConfig<T = Record<string, unknown>>(pluginName: string): T | null {
    return PluginStorage.get<T>(pluginName, '_config');
  }

  /** Set plugin config */
  static setConfig(pluginName: string, config: Record<string, unknown>): void {
    PluginStorage.set(pluginName, '_config', config);
  }

  private static _dataDir(pluginName: string): string {
    return path.join(PLUGINS_DIR, pluginName, 'data');
  }

  private static _filePath(pluginName: string, key: string): string {
    return path.join(PluginStorage._dataDir(pluginName), `${key}.json`);
  }
}
