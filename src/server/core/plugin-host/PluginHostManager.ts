// PluginHostManager.ts — Fleet manager for plugin Worker Threads.
// One Worker per plugin. If a plugin crashes, only its Worker restarts.
// Other plugins and the platform continue unaffected.

import { Worker } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { PromptAssembler } from '../prompt/PromptAssembler.js';
import { MemoryManager } from '../memory/MemoryManager.js';
import { createLogger } from '../logger.js';
import { extensionPoints } from './ExtensionPoints.js';
import { TypedEventBus } from '../events/index.js';
import { SessionStore } from '../session/SessionStore.js';
import { writablePath } from '../../infra/WritablePath.js';
import { SettingsManager } from '../../infra/storage/SettingsManager.js';
import { WsServer } from '../../infra/network/WsServer.js';
import { ApiServer } from '../../gateway/ApiServer.js';
import { PluginLoader } from './PluginLoader.js';
import { RpcDispatcher } from './RpcDispatcher.js';
import { generateRPCLabel } from './PluginRPC.js';
import type { PluginListItem, PluginState } from './PluginRPC.js';

const log = createLogger('anochat.plugins');
const MAX_RESULT_CHARS = 50_000; // Truncate tool/LLM results to prevent OOM

/** Ensure the resolved path stays within the project workspace */
function assertPathWithinWorkspace(filePath: string): void {
  const workspace = path.resolve(process.cwd());
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(workspace + path.sep) && resolved !== workspace) {
    throw new Error(`Path traversal denied: "${filePath}" is outside workspace`);
  }
}

function truncateResult(content: string): string {
  if (content.length <= MAX_RESULT_CHARS) return content;
  return content.slice(0, MAX_RESULT_CHARS) + `\n\n[truncated at ${MAX_RESULT_CHARS} chars, original ${content.length}]`;
}

export class PluginHostManager extends EventEmitter {
  private static _instance: PluginHostManager | null = null;

  static getInstance(): PluginHostManager {
    if (!this._instance) this._instance = new PluginHostManager();
    return this._instance;
  }

  /** Reset singleton — for test isolation */
  static resetInstance(): void {
    const inst = this._instance;
    if (inst) {
      inst._stopping = true;
      if (inst._watcher) { inst._watcher.close(); inst._watcher = null; }
      if (inst._debounceTimers) {
        for (const t of inst._debounceTimers.values()) clearTimeout(t);
        inst._debounceTimers.clear();
      }
      for (const [name, w] of inst._workers) {
        w.removeAllListeners();
        w.terminate().catch(() => {});
        for (const [, p] of inst._pending.get(name) || []) p.reject(new Error('PluginHostManager reset'));
        inst._cleanupPluginContributions(name);
      }
      inst._workers.clear();
      inst._pending.clear();
      inst._ready.clear();
      inst._installedTools.clear();
      inst._eventSubs.clear();
      if (inst._kernelEventForwardingUnsub) {
        inst._kernelEventForwardingUnsub();
        inst._kernelEventForwardingUnsub = null;
      }
      inst._kernelEventForwardingInstalled = false;
      inst._backoffs.clear();
      inst._crashCounts.clear();
    }
    this._instance = null;
  }

  private _workers = new Map<string, Worker>();                      // pluginName → Worker
  private _pending = new Map<string, Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>>(); // pluginName → (rpcId → promise)
  private _ready = new Set<string>();                                // pluginNames whose worker sent 'ready'
  private _installedTools = new Map<string, string>();               // toolName → pluginName
  private _backoffs = new Map<string, number>();                     // pluginName → current backoff ms
  private _crashCounts = new Map<string, number>();                  // pluginName → consecutive crashes
  private _watcher: fs.FSWatcher | null = null;
  private _stopping = false;
  private _eventSubs = new Map<string, Set<string>>();               // event → Set<pluginName>
  private _kernelEventForwardingInstalled = false;
  private _kernelEventForwardingUnsub: (() => void) | null = null;   // onAny() unsubscribe handle
  private _loader = new PluginLoader();
  private _rpcDispatcher = new RpcDispatcher(this._installedTools, this._eventSubs, this);

  // ── Worker lifecycle ──

  /** Start workers for all plugins (one Worker per plugin). */
  start(): void {
    // Inject ExtensionPoints into kernel systems for plugin overrides
    try {
      PromptAssembler.getInstance().setExtensionPoints(extensionPoints);
      MemoryManager.getInstance().setExtensionPoints(extensionPoints);
      SessionStore.getInstance().setExtensionPoints(extensionPoints);
      SettingsManager.getInstance().setExtensionPoints(extensionPoints);
      log.info('ExtensionPoints injected into kernel');
    } catch (err) {
      log.warn('ExtensionPoints injection failed', { error: (err as Error).message });
    }

    // File watcher — auto-reload when plugin directories changed
    this._startFileWatcher();
    // Install kernel event forwarding for plugin event subscriptions
    this._installKernelEventForwarding();

    // Load all manifests and spawn one Worker per plugin
    const states = this._loader.loadAll();
    for (const s of states) {
      if (s.status === 'error') {
        log.warn('Skipping plugin with load error', { name: s.manifest.name, error: s.errorMessage });
        this._notifyPluginError(s.manifest.name, s.errorMessage || 'Load failed');
        continue;
      }
      this._spawnPluginWorker(s.manifest.name, s.pluginPath);
    }

    if (states.length === 0) {
      // Send ready even with no plugins so the system doesn't wait
      process.nextTick(() => this.emit('ready'));
    } else {
      log.info('Plugin fleet spawning', { count: states.length });
    }
  }

  /** Spawn a Worker for a single plugin. */
  private _spawnPluginWorker(pluginName: string, pluginPath: string): void {
    if (this._workers.has(pluginName)) return;

    const workerPath = writablePath('dist', 'server', 'core', 'plugin-host', 'PluginHost.js');

    let worker: Worker;
    try {
      worker = new Worker(workerPath, {
        workerData: { pluginName, pluginPath },
      });
    } catch (err) {
      log.error('Failed to spawn plugin worker', { pluginName, error: (err as Error).message });
      this._notifyPluginError(pluginName, (err as Error).message);
      this.emit('plugin-error', pluginName, err instanceof Error ? err : new Error(String(err)));
      return;
    }

    this._workers.set(pluginName, worker);
    this._pending.set(pluginName, new Map());
    this._installWorkerHandlers(worker, pluginName);

    log.info('Plugin worker spawned', { pluginName });
  }

  /** Stop all plugin workers gracefully. */
  async stop(): Promise<void> {
    this._stopping = true;
    if (this._watcher) { this._watcher.close(); this._watcher = null; }

    const shutdowns: Promise<void>[] = [];
    for (const [name, worker] of this._workers) {
      shutdowns.push(
        new Promise<void>(resolve => {
          worker.postMessage({ id: `shutdown-${name}`, method: 'shutdown', params: {} });
          setTimeout(() => {
            worker.terminate().catch(() => {});
            resolve();
          }, 2000);
        })
      );
      this._cleanupPluginContributions(name);
    }
    await Promise.all(shutdowns);
    this._workers.clear();
    this._ready.clear();
    this._stopping = false;
    log.info('All plugin workers stopped');
  }

  isRunning(): boolean {
    return this._workers.size > 0;
  }

  /** Check if a specific plugin has a running worker. */
  isPluginRunning(pluginName: string): boolean {
    return this._workers.has(pluginName) && this._ready.has(pluginName);
  }

  // ── RPC dispatch ──

  private _installWorkerHandlers(worker: Worker, pluginName: string): void {

    worker.on('message', async (msg: unknown) => {
      const request = msg as { id: string; method: string; params: unknown; result?: unknown; error?: { code: string; message: string } };

      // Handle the 'ready' signal — this worker's plugin has activated
      if (request.id === 'ready') {
        this._ready.add(pluginName);
        // Reset crash backoff on successful start
        if (this._crashCounts.get(pluginName)) {
          log.info('Plugin crash recovery succeeded', { pluginName });
          this._crashCounts.set(pluginName, 0);
          this._backoffs.set(pluginName, 0);
        }
        log.info('Plugin worker ready', { pluginName });
        this.emit('plugin-ready', pluginName);
        return;
      }

      // Handle fire-and-forget: auto-activate error
      if (request.id === 'auto-activate-error') {
        const errInfo = request.error as { code: string; message: string } | undefined;
        const message = errInfo?.message || 'Unknown plugin error';
        log.warn('Plugin auto-activate error', { pluginName, code: errInfo?.code, message });
        this._notifyPluginError(pluginName, message);
        this.emit('plugin-error', pluginName, new Error(message));
        // Worker will exit after reporting error — clean up
        this._workers.delete(pluginName);
        this._ready.delete(pluginName);
        return;
      }

      // Handle RPC callbacks (responses from worker to pending main→worker requests)
      const pending = this._pending.get(pluginName);
      if (request.id && pending?.has(request.id)) {
        const p = pending.get(request.id)!;
        pending.delete(request.id);
        if (request.error) {
          p.reject(new Error(`[${request.error.code}] ${request.error.message}`));
        } else {
          p.resolve(request.result);
        }
        return;
      }

      // Handle worker→main RPC requests (same dispatch for all workers)
      try {
        const result = await this._dispatchWorkerRPC(request.method, request.params);
        worker.postMessage({ id: request.id, result });
      } catch (err) {
        const msg2 = err instanceof Error ? err.message : String(err);
        worker.postMessage({ id: request.id, error: { code: 'MAIN_ERROR', message: msg2 } });
      }
    });

    worker.on('error', (err: Error) => {
      log.error('Plugin worker error', { pluginName, error: err.message });
      this.emit('plugin-error', pluginName, err);
      this._onWorkerCrash(pluginName);
    });

    worker.on('exit', (code: number) => {
      log.warn('Plugin worker exited', { pluginName, code });
      this._workers.delete(pluginName);
      this._ready.delete(pluginName);
      // Reject pending RPCs for this worker
      const pending = this._pending.get(pluginName);
      if (pending) {
        for (const [, p] of pending) p.reject(new Error(`Plugin "${pluginName}" worker exited`));
        pending.clear();
      }
      if (code !== 0 && !this._stopping) this._onWorkerCrash(pluginName);
    });
  }

  /** Auto-restart a single plugin worker with exponential backoff. */
  private _onWorkerCrash(pluginName: string): void {
    // NOTE: do NOT close the global fs.watcher — it monitors ALL plugins.
    // Only close it in stop() or resetInstance().

    this._cleanupPluginContributions(pluginName);

    // Exponential backoff per plugin
    const count = (this._crashCounts.get(pluginName) || 0) + 1;
    this._crashCounts.set(pluginName, count);
    const prevBackoff = this._backoffs.get(pluginName) || 500;
    const backoff = Math.min(30_000, prevBackoff * 2);
    this._backoffs.set(pluginName, backoff);

    log.warn('Plugin worker crash — restarting', { pluginName, crashCount: count, delayMs: backoff });

    // Load manifest to get pluginPath for restart
    const state = this._loader.loadOne(pluginName);

    setTimeout(() => {
      if (!this._stopping && state) {
        this._spawnPluginWorker(pluginName, state.pluginPath);
      }
      // Re-start file watcher after crash restart
      if (!this._watcher && !this._stopping) this._startFileWatcher();
    }, backoff);
  }

  /** Process a worker→main RPC method. Delegates to RpcDispatcher. */
  private async _dispatchWorkerRPC(method: string, params: unknown): Promise<unknown> {
    return this._rpcDispatcher.dispatch(method, params);
  }

  private _cleanupPluginContributions(pluginName: string): void {
    const removedTools: string[] = [];
    for (const [toolName, pn] of this._installedTools) {
      if (pn !== pluginName) continue;
      ToolRegistry.getInstance().deregisterTool(toolName);
      this._installedTools.delete(toolName);
      removedTools.push(toolName);
    }

    const emptyEvents: string[] = [];
    for (const [eventName, plugins] of this._eventSubs) {
      plugins.delete(pluginName);
      if (plugins.size === 0) emptyEvents.push(eventName);
    }
    for (const eventName of emptyEvents) {
      this._eventSubs.delete(eventName);
    }

    extensionPoints.unregisterAll(pluginName);

    let removedRoutes = 0;
    try {
      removedRoutes = ApiServer.getInstance().unregisterPluginRoutes(pluginName);
    } catch (err) {
      log.warn('Plugin route cleanup failed', { pluginName, error: (err as Error).message });
    }

    let removedPromptSections = 0;
    try {
      removedPromptSections = PromptAssembler.getInstance().unregisterSectionsByPrefix(`plugin:${pluginName}:`);
    } catch (err) {
      log.warn('Plugin prompt cleanup failed', { pluginName, error: (err as Error).message });
    }

    try {
      WsServer.getInstance().broadcast({ type: 'plugin:ui:removeByPlugin', pluginName });
    } catch (err) {
      log.debug('Plugin UI cleanup broadcast skipped', { pluginName, error: (err as Error).message });
    }

    if (removedTools.length > 0 || removedRoutes > 0 || removedPromptSections > 0 || emptyEvents.length > 0) {
      log.info('Plugin contributions cleaned up', {
        pluginName,
        tools: removedTools,
        routes: removedRoutes,
        promptSections: removedPromptSections,
        eventSubscriptions: emptyEvents.length,
      });
    }
  }

  // ── Communication ──

  /** Send an RPC from main to a specific plugin's worker and wait for response. */
  async executeHandler(pluginName: string, handler: string, reqData: { body: unknown; params: Record<string, string>; query: string }): Promise<unknown> {
    return this._sendToWorker(pluginName, 'plugin.execute', { pluginName, handler, ...reqData });
  }

  private async _sendToWorker(pluginName: string, method: string, params: unknown, timeoutMs: number = 30_000): Promise<unknown> {
    const worker = this._workers.get(pluginName);
    if (!worker) throw new Error(`Plugin "${pluginName}" worker not running`);

    const id = `${pluginName}:${method}:${generateRPCLabel(method, pluginName)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this._pending.get(pluginName);
        pending?.delete(id);
        reject(new Error(`RPC timeout: ${method} exceeded ${timeoutMs}ms`));
      }, timeoutMs);

      const pending = this._pending.get(pluginName);
      if (!pending) {
        clearTimeout(timer);
        reject(new Error(`Plugin "${pluginName}" has no pending queue`));
        return;
      }
      pending.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v); },
        reject: (e: Error) => { clearTimeout(timer); reject(e); },
      });
      worker.postMessage({ id, method, params });
    });
  }

  /** Request a plugin's worker to execute a tool (with 30s timeout + result truncation). */
  async executePluginTool(
    pluginName: string,
    toolName: string,
    toolParams: Record<string, unknown>,
    ctx: { sessionId: string; agentId: string; workspace: string },
  ): Promise<string> {
    const result = await this._sendToWorker(pluginName, 'tool.execute', { pluginName, toolName, params: toolParams, ctx });
    const r = result as { content: string };
    return truncateResult(r.content);
  }

  /** List all plugins with their current status across all workers. */
  async listPlugins(): Promise<PluginListItem[]> {
    const states = this._loader.loadAll();
    return states.map(s => {
      const isActive = this._ready.has(s.manifest.name);
      return {
        name: s.manifest.name,
        displayName: s.manifest.displayName,
        version: s.manifest.version,
        publisher: s.manifest.publisher,
        description: s.manifest.description,
        status: isActive ? 'activated' : s.status,
        errorMessage: s.errorMessage,
        contributes: s.manifest.contributes,
      };
    });
  }

  private _waitForPluginReady(
    name: string,
    state: PluginState,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<PluginState> {
    return new Promise<PluginState>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        this.off('plugin-ready', onReady);
        this.off('plugin-error', onError);
      };
      const onReady = (pluginName: string) => {
        if (pluginName !== name) return;
        cleanup();
        resolve({ ...state, status: 'activated', activatedAt: new Date().toISOString() });
      };
      const onError = (pluginName: string, error: Error) => {
        if (pluginName !== name) return;
        cleanup();
        reject(error);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(timeoutMessage));
      }, timeoutMs);

      this.on('plugin-ready', onReady);
      this.on('plugin-error', onError);
      if (this._ready.has(name)) onReady(name);
    });
  }

  /** Reload a single plugin: terminate old worker, spawn new one. */
  async reloadPlugin(name: string): Promise<PluginState> {
    // Terminate old worker first
    const oldWorker = this._workers.get(name);
    if (oldWorker) {
      this._cleanupPluginContributions(name);

      oldWorker.removeAllListeners();
      try { oldWorker.postMessage({ id: `shutdown-${name}`, method: 'shutdown', params: {} }); } catch {}
      oldWorker.terminate().catch(() => {});
      this._workers.delete(name);
      this._ready.delete(name);
    }

    // Load fresh manifest
    const state = this._loader.loadOne(name);
    if (!state) throw new Error(`Plugin "${name}" not found`);
    if (state.status === 'error') throw new Error(state.errorMessage || 'Plugin validation failed');

    // Spawn new worker
    const waitForReady = this._waitForPluginReady(name, state, 20_000, `Reload timed out after 20s`);
    this._spawnPluginWorker(name, state.pluginPath);
    return waitForReady;
  }

  /** Activate a single plugin (spawn worker on demand, wait for ready). */
  async activatePlugin(name: string): Promise<PluginState> {
    if (this._ready.has(name)) {
      const state = this._loader.loadOne(name);
      return { ...(state || { manifest: { name, displayName: name, version: '0.0.0', main: '', activationEvents: [] }, pluginPath: '' }), status: 'activated' as const };
    }
    const state = this._loader.loadOne(name);
    if (!state) throw new Error(`Plugin "${name}" not found`);
    const waitForReady = this._waitForPluginReady(name, state, 20_000, `Plugin "${name}" activation timed out after 20s`);
    this._spawnPluginWorker(name, state.pluginPath);
    return waitForReady;
  }

  /** Deactivate a single plugin (terminate its worker). */
  async deactivatePlugin(name: string): Promise<{ deactivated: boolean }> {
    const worker = this._workers.get(name);
    this._cleanupPluginContributions(name);
    if (!worker) return { deactivated: false };

    worker.removeAllListeners();
    try { worker.postMessage({ id: `shutdown-${name}`, method: 'shutdown', params: {} }); } catch {}
    worker.terminate().catch(() => {});
    this._workers.delete(name);
    this._ready.delete(name);
    return { deactivated: true };
  }

  /** Watch plugins/ directory and auto-reload on changes */
  private _startFileWatcher(): void {
    const pluginsDir = writablePath('plugins');
    if (!fs.existsSync(pluginsDir)) return;

    this._watcher = fs.watch(pluginsDir, { recursive: true }, (_eventType, filename) => {
      if (!filename || filename.startsWith('.') || filename.endsWith('.disabled')) return;      // Extract plugin name (first segment of path, e.g. "my-plugin/extension.js" → "my-plugin")
      const name = filename.split(/[\\/]/)[0];
      if (!name) return;
      clearTimeout(this._debounceTimers?.get(name));
      const timers = this._debounceTimers || new Map<string, ReturnType<typeof setTimeout>>();
      this._debounceTimers = timers;
      timers.set(name, setTimeout(async () => {
        timers.delete(name);
        log.info('Plugin change detected, auto-reloading', { plugin: name });
        try {
          await this.reloadPlugin(name);
          log.info('Plugin auto-reloaded', { plugin: name });
          // Notify all connected clients to refresh plugin list and pages
          WsServer.getInstance().broadcast({ type: 'pluginsChanged' });
        } catch (err) {
          log.warn('Plugin auto-reload failed', { plugin: name, error: (err as Error).message });
          this._notifyPluginError(name, (err as Error).message);
        }
      }, 1000));
    });
    log.info('Plugin file watcher started', { dir: pluginsDir });
  }
  private _debounceTimers: Map<string, ReturnType<typeof setTimeout>> | null = null;

  /**
   * Forward kernel events to plugin Workers.
   *
   * All events flow through a single integration point: TypedEventBus.onAny().
   * Any core service that emits on TypedEventBus (MemoryManager, SessionManager,
   * AgentLoop, LLM provider, etc.) is automatically forwarded to subscribed plugins.
   * No per-service wiring needed.
   */
  private _installKernelEventForwarding(): void {
    if (this._kernelEventForwardingInstalled) return;
    this._kernelEventForwardingInstalled = true;

    const forward = (eventName: string, ...args: unknown[]) => {
      const subs = this._eventSubs.get(eventName);
      if (!subs || subs.size === 0) return;
      const data = args.length === 1 ? args[0] : args;
      // Forward to all workers that have subscribed to this event
      for (const pluginName of subs) {
        const worker = this._workers.get(pluginName);
        if (worker) {
          worker.postMessage({ method: 'event', params: { event: eventName, data } });
        }
      }
    };

    // Permanent subscription — runs for entire PluginHostManager lifetime.
    // Plugin workers come and go, but EventBus forwarding is always-on.
    this._kernelEventForwardingUnsub = TypedEventBus.onAny((event, payload) => {
      forward(event, payload);
    });
  }

  /** Notify users of plugin load failures — toast via WebSocket + system event. */
  private _notifyPluginError(pluginName: string, error: string): void {
    TypedEventBus.emit('plugin:load_failed', { pluginName, error: error.slice(0, 500) });
    // Toast to frontend — errors are system-level, not agent session events
    try {
      WsServer.getInstance().broadcast({
        type: 'system:toast',
        toastType: 'error',
        message: `Plugin "${pluginName}" failed to load: ${error.slice(0, 300)}`,
        duration: 8000,
      });
    } catch { /* best-effort — WsServer may not be attached yet */ }
  }
}
