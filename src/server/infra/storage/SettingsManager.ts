// SettingsManager — YAML/JSON config loader with nested key access and file watching

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as YAML from 'yaml';
import { PATHS } from '../../../shared/constants.js';
import { LogManager } from '../logging/LogManager.js';
import { writablePath } from '../WritablePath.js';

// ---------------------------------------------------------------------------
// Default settings
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: Record<string, unknown> = {
  // Server
  host: '127.0.0.1',
  port: 3456,
  apiPort: 15730,

  // LLM
  llm: {
    provider: 'openai-compatible',
    model: 'deepseek-chat',
    maxTokens: 200000,
    temperature: 1.0,
    apiKey: '',
    apiUrl: 'https://api.deepseek.com',
    contextWindow: 131072,
  },

  // Agent
  agent: {
    maxTurns: 0,
    stallDetectionNoToolTurns: 5,
    stallDetectionConsecutiveFailures: 3,
    heartbeatIntervalSec: 60,
    taskTimeoutSec: 600,
    unresponsiveThresholdSec: 180,
  },

  // Logging
  logging: {
    level: 'info',
    logDir: 'logs',
    maxFileBytes: 10 * 1024 * 1024,
    maxFiles: 10,
  },

  // Rate limiting
  rateLimit: {
    perMinute: 100,
    enabled: true,
  },

  // Workspace
  workspace: {
    root: 'company-workspace',
  },

  coordination: {
    autoSwarm: {
      enabled: true,
      minParallelTasks: 2,
    },
    maxConcurrentTasksPerRoot: 4,
    maxTeamMembers: 8,
    maxTaskRuntimeMs: 600000,
    maxAutomaticRetries: 2,
    autoDisbandGraceMs: 30000,
    messageBatchSize: 20,
    workspaceLeaseTtlMs: 30000,
  },

  // Features
  features: {
    enableMCP: true,
    enableSSE: true,
    enableCache: true,
    enableDelegation: true,
    enableSkills: true,
  },

  // UI
  ui: {
    lang: 'zh-CN',
    theme: 'dark',
    accentColor: '#0b8ce9',
    showThinkCards: true,
    showToolCards: true,
    compactionThreshold: 70,
  },
};

// ---------------------------------------------------------------------------
// SettingsManager
// ---------------------------------------------------------------------------

export class SettingsManager extends EventEmitter {
  private static _instance: SettingsManager;

  private _settings: Record<string, unknown> = {};
  private _watcher: fs.FSWatcher | null = null;
  private _configPath: string;
  private _extPoints: { get(point: string): ((...args: unknown[]) => unknown) | null } | null = null;
  private _saveQueue: Promise<void> = Promise.resolve();

  private static readonly LEGACY_LLM_KEYS: Record<string, string> = {
    provider: 'llm.provider',
    model: 'llm.model',
    apiUrl: 'llm.apiUrl',
    apiKey: 'llm.apiKey',
    contextWindow: 'llm.contextWindow',
  };

  setExtensionPoints(extPoints: { get(point: string): ((...args: unknown[]) => unknown) | null }): void {
    this._extPoints = extPoints;
  }

  private constructor() {
    super();
    this._configPath = writablePath(PATHS.config, 'settings.yaml');
    // Also try .json extension as fallback
  }

  static getInstance(): SettingsManager {
    if (!SettingsManager._instance) {
      SettingsManager._instance = new SettingsManager();
    }
    return SettingsManager._instance;
  }

  // -----------------------------------------------------------------------
  // Load
  // -----------------------------------------------------------------------

  async load(): Promise<void> {
    // Initialise with defaults
    this._settings = this.deepClone(DEFAULT_SETTINGS);

    // Try YAML first, then JSON
    const yamlPath = this._configPath;
    const jsonPath = writablePath(PATHS.config, 'settings.json');

    let raw: string | null = null;
    let loadedPath: string | null = null;

    try {
      raw = await fsp.readFile(yamlPath, 'utf-8');
      loadedPath = yamlPath;
    } catch {
      try {
        raw = await fsp.readFile(jsonPath, 'utf-8');
        loadedPath = jsonPath;
      } catch {
        // No config file exists yet — use defaults and write one out
        LogManager.getInstance().logger('anochat.system').info('No config file found, using defaults');
        await this.save(); // Write default config
        this._configPath = yamlPath; // Prefer YAML going forward
        this.startWatching();
        return;
      }
    }

    if (raw && loadedPath) {
      this._configPath = loadedPath;
      const parsed = this.parseConfig(raw, loadedPath);
      const { settings: migrated, changed } = this.migrateLegacySettings(parsed);
      this._settings = this.deepMerge(this.deepClone(DEFAULT_SETTINGS), migrated) as Record<string, unknown>;
      if (changed) await this.save();
      LogManager.getInstance().logger('anochat.system').info('Settings loaded', { file: path.basename(loadedPath) });
    }

    this.startWatching();
  }

  // -----------------------------------------------------------------------
  // Get / Set
  // -----------------------------------------------------------------------

  /**
   * Get a setting value by dot-notation key.
   * Example: get('llm.model'), get('agent.maxTurns', 0)
   */
  get<T>(key: string, defaultValue?: T): T {
    key = this.canonicalKey(key);
    if (this._extPoints) {
      const override = this._extPoints.get('settingsStore');
      if (override) {
        const result = override({ action: 'get', key, defaultValue }) as { value: T };
        if (result && result.value !== undefined) return result.value;
      }
    }
    const keys = key.split('.');
    let current: unknown = this._settings;

    for (const k of keys) {
      if (current === null || current === undefined) break;
      if (typeof current !== 'object') { current = undefined; break; }
      current = (current as Record<string, unknown>)[k];
    }

    // Fall back to DEFAULT_SETTINGS for any path that resolved to undefined
    if (current === undefined) {
      let defCurrent: unknown = DEFAULT_SETTINGS;
      for (const k of keys) {
        if (defCurrent === null || defCurrent === undefined) { defCurrent = undefined; break; }
        if (typeof defCurrent !== 'object') { defCurrent = undefined; break; }
        defCurrent = (defCurrent as Record<string, unknown>)[k];
      }
      if (defCurrent !== undefined) return defCurrent as T;
    }

    if (current === undefined && defaultValue !== undefined) {
      return defaultValue;
    }

    return current as T;
  }

  /**
   * Set a setting value by dot-notation key (in memory only; call save() to persist).
   */
  async set(key: string, value: unknown): Promise<void> {
    key = this.canonicalKey(key);
    const keys = key.split('.');
    const lastKey = keys.pop()!;

    let target: Record<string, unknown> = this._settings;
    for (const k of keys) {
      if (!(k in target) || typeof target[k] !== 'object' || target[k] === null) {
        target[k] = {};
      }
      target = target[k] as Record<string, unknown>;
    }

    target[lastKey] = value;

    this.emit('changed', key, value);
  }

  // -----------------------------------------------------------------------
  // Save
  // -----------------------------------------------------------------------

  async save(): Promise<void> {
    this._saveQueue = this._saveQueue.catch(() => undefined).then(async () => {
      const ext = path.extname(this._configPath).toLowerCase();
      const content = ext === '.json'
        ? JSON.stringify(this._settings, null, 2)
        : YAML.stringify(this._settings, { indent: 2, lineWidth: 0 });
      const directory = path.dirname(this._configPath);
      const tempPath = path.join(
        directory,
        `.${path.basename(this._configPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
      );

      await fsp.mkdir(directory, { recursive: true });
      try {
        const handle = await fsp.open(tempPath, 'wx', 0o600);
        try {
          await handle.writeFile(content, 'utf-8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fsp.rename(tempPath, this._configPath);
      } finally {
        await fsp.rm(tempPath, { force: true }).catch(() => undefined);
      }
    });
    return this._saveQueue;
  }

  // -----------------------------------------------------------------------
  // File watching
  // -----------------------------------------------------------------------

  private startWatching(): void {
    // Don't double-watch
    if (this._watcher) return;

    const watchDir = path.dirname(this._configPath);
    const watchFile = path.basename(this._configPath);

    try {
      this._watcher = fs.watch(watchDir, async (eventType, filename) => {
        if (filename !== watchFile) return;
        if (eventType !== 'change') return;

        // Debounce — wait a tick for the write to finish
        await new Promise((r) => setTimeout(r, 100));

        try {
          const raw = await fsp.readFile(this._configPath, 'utf-8');
          const parsed = this.parseConfig(raw, this._configPath);
          this._settings = this.deepMerge(this.deepClone(DEFAULT_SETTINGS), parsed) as Record<string, unknown>;
          LogManager.getInstance().logger('anochat.system').info('Config reloaded from disk');
        } catch {
          // File may be temporarily locked or malformed — ignore
        }
      });

      this._watcher.on('error', (err) => {
        // On Windows, watching can fail for some directories; not fatal
        LogManager.getInstance().logger('anochat.system').warn('File watch error', { error: err.message });
      });
    } catch {
      // fs.watch may not be available on all platforms/network drives
    }
  }

  /** Stop file watching (for clean shutdown) */
  stopWatching(): void {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
  }

  // -----------------------------------------------------------------------
  // Parsing
  // -----------------------------------------------------------------------

  private parseConfig(raw: string, filePath: string): Record<string, unknown> {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.json') {
      return JSON.parse(raw) as Record<string, unknown>;
    }

    // YAML
    const parsed = YAML.parse(raw);
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Config file must contain a YAML object (mapping) at the top level');
    }
    return parsed as Record<string, unknown>;
  }

  private canonicalKey(key: string): string {
    return SettingsManager.LEGACY_LLM_KEYS[key] || key;
  }

  private migrateLegacySettings(source: Record<string, unknown>): {
    settings: Record<string, unknown>;
    changed: boolean;
  } {
    const settings = this.deepClone(source);
    const llm = settings.llm && typeof settings.llm === 'object' && !Array.isArray(settings.llm)
      ? { ...(settings.llm as Record<string, unknown>) }
      : {};
    let changed = false;

    for (const [legacyKey, canonicalPath] of Object.entries(SettingsManager.LEGACY_LLM_KEYS)) {
      if (!(legacyKey in settings)) continue;
      const canonicalKey = canonicalPath.slice('llm.'.length);
      if (llm[canonicalKey] === undefined) llm[canonicalKey] = settings[legacyKey];
      delete settings[legacyKey];
      changed = true;
    }

    if (Object.keys(llm).length > 0 || settings.llm !== undefined) settings.llm = llm;
    return { settings, changed };
  }

  // -----------------------------------------------------------------------
  // Utility
  // -----------------------------------------------------------------------

  /** Deep-clone a plain object */
  private deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
  }

  /** Deep merge: source values override target values */
  private deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    const result = { ...target };

    for (const [key, val] of Object.entries(source)) {
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        const targetVal = result[key];
        if (targetVal !== null && typeof targetVal === 'object' && !Array.isArray(targetVal)) {
          result[key] = this.deepMerge(
            targetVal as Record<string, unknown>,
            val as Record<string, unknown>,
          );
        } else {
          result[key] = this.deepClone(val);
        }
      } else {
        result[key] = this.deepClone(val);
      }
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  /** Return a deep copy of all settings (safe to read, mutating has no effect) */
  get all(): Record<string, unknown> {
    return this.deepClone(this._settings);
  }
}
