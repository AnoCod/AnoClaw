// ExtensionPoints.ts — Kernel override hook system.
// Plugins with "overrides" in their manifest can replace kernel functions.
// The kernel checks if an override exists before using its built-in default.

import { createLogger } from '../logger.js';

const log = createLogger('anochat.extpoints');

// Overridable kernel extension points (valid override keys in plugin.json "overrides"):
//   promptAssembler, memoryStore, sessionStore,
//   settingsStore, llmProvider, toolExecutor, agentLoop

/** Signature for an override handler. Type depends on the extension point. */
type OverrideHandler = (...args: unknown[]) => unknown;

/**
 * Singleton registry of overridden extension points.
 * Plugins call `register()` during activate. Kernel calls `get()` at runtime.
 * If no override registered, get() returns null — kernel uses default.
 */
class ExtensionPointRegistry {
  private _overrides = new Map<string, OverrideHandler>();
  private _pluginOwners = new Map<string, string>(); // extPoint → pluginName

  /** Register an override handler for an extension point. One per point (last write wins). */
  register(point: string, pluginName: string, handler: OverrideHandler): void {
    const prev = this._pluginOwners.get(point);
    if (prev) {
      log.warn('Extension point overridden', { point, previousPlugin: prev, newPlugin: pluginName });
    }
    this._overrides.set(point, handler);
    this._pluginOwners.set(point, pluginName);
    log.info('Extension point registered', { point, pluginName });
  }

  /** Remove all overrides from a plugin. Called on plugin deactivation. */
  unregisterAll(pluginName: string): void {
    const toRemove: string[] = [];
    for (const [point, owner] of this._pluginOwners) {
      if (owner === pluginName) toRemove.push(point);
    }
    for (const point of toRemove) {
      this._overrides.delete(point);
      this._pluginOwners.delete(point);
      log.info('Extension point removed', { point, pluginName });
    }
  }

  /** Get the override handler for a point, or null if not overridden. */
  get(point: string): OverrideHandler | null {
    return this._overrides.get(point) || null;
  }

  /** Check if an extension point has an override */
  has(point: string): boolean {
    return this._overrides.has(point);
  }

  /** List all overridden points with their plugin owners */
  list(): Array<{ point: string; plugin: string }> {
    return [...this._pluginOwners.entries()].map(([point, plugin]) => ({ point, plugin }));
  }
}

export const extensionPoints = new ExtensionPointRegistry();
