// ExtensionManager — singleton lifecycle manager for pluggable subsystems
// Extensions self-register via register(). At startup, startAll() topologically
// sorts by dependencies, skips disabled extensions (from settings), and starts them.
// At shutdown, stopAll() stops all running extensions in reverse order.

import type { Extension } from './Extension.js';
import { SettingsManager } from '../../infra/storage/SettingsManager.js';
import { createLogger } from '../logger.js';

const log = createLogger('anochat.extensions');

export class ExtensionManager {
  private static _instance: ExtensionManager;
  static getInstance(): ExtensionManager {
    return this._instance ?? (this._instance = new ExtensionManager());
  }
  static async resetInstance(): Promise<void> {
    if (this._instance) {
      await this._instance.stopAll();
      this._instance._extensions.clear();
      this._instance._started.clear();
      this._instance = undefined as unknown as ExtensionManager;
    }
  }

  private _extensions = new Map<string, Extension>();
  private _started = new Set<string>();

  /** Register an extension. Call during initialization, before startAll(). */
  register(ext: Extension): void {
    if (this._extensions.has(ext.id)) {
      log.warn('Duplicate extension registration', { id: ext.id });
      return;
    }
    this._extensions.set(ext.id, ext);
  }

  /** Start all registered extensions in dependency order, respecting feature flags. */
  async startAll(): Promise<void> {
    const settings = SettingsManager.getInstance();
    const disabled: string[] = settings.get<string[]>('extensions.disabled') || [];

    const order = this._topoSort();
    for (const id of order) {
      if (disabled.includes(id)) {
        log.info('Extension disabled by config', { id });
        continue;
      }
      const ext = this._extensions.get(id)!;
      try {
        await ext.start();
        this._started.add(id);
        log.info('Extension started', { id: ext.id });
      } catch (err) {
        log.error('Extension failed to start', { id: ext.id, error: (err as Error).message });
      }
    }
  }

  /** Stop all started extensions in reverse dependency order. */
  async stopAll(): Promise<void> {
    for (const id of [...this._started].reverse()) {
      const ext = this._extensions.get(id)!;
      try {
        await ext.stop();
        this._started.delete(id);
        log.info('Extension stopped', { id: ext.id });
      } catch (err) {
        log.error('Extension failed to stop', { id: ext.id, error: (err as Error).message });
      }
    }
  }

  /** Check if an extension is running. */
  isStarted(id: string): boolean {
    return this._started.has(id);
  }

  /** List all registered extension IDs. */
  get registeredIds(): string[] {
    return [...this._extensions.keys()];
  }

  /** Topological sort by dependencies. */
  private _topoSort(): string[] {
    const visited = new Set<string>();
    const result: string[] = [];
    const visiting = new Set<string>();

    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        log.warn('Circular dependency detected, skipping', { id });
        return;
      }
      visiting.add(id);
      const ext = this._extensions.get(id);
      if (ext) {
        for (const dep of ext.dependencies) {
          if (this._extensions.has(dep)) visit(dep);
        }
      }
      visiting.delete(id);
      visited.add(id);
      result.push(id);
    };

    for (const id of this._extensions.keys()) {
      visit(id);
    }
    return result;
  }
}
