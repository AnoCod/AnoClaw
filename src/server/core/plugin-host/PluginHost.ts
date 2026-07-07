// PluginHost.ts — Worker Thread entry point for the Plugin Host.
// Loads plugin manifests, imports entry modules, calls activate/deactivate.
// Communication with main thread via parentPort MessageChannel.
// This ENTIRE file runs inside a Node.js Worker Thread.
//
// Supports TWO plugin styles (detected at activation time):
//   1. Class-based: export default class MyPlugin extends PluginBase { ... }
//   2. Function-based: export async function activate(anoclaw) { ... }
//      + export async function executeTool(name, params, ctx) { ... }

import { parentPort, workerData } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { PluginLoader } from './PluginLoader.js';
import { createAnoClawAPI } from './PluginAPI.js';
import type { AnoClawAPI } from './PluginAPI.js';
import { PluginBase } from './PluginBase.js';

const ACTIVATE_TIMEOUT_MS = 15_000;

/**
 * Register kernel extension point overrides declared in plugin manifest.
 * Shared by both class-based and function-based activation paths.
 */
async function _registerExtensionPointOverrides(
  pluginPath: string,
  overrides: Record<string, string | null>,
  pluginName: string,
  logError: (msg: string) => void,
): Promise<Array<{ dispose(): void }>> {
  const disposables: Array<{ dispose(): void }> = [];
  if (!overrides || Object.keys(overrides).length === 0) return disposables;

  const { extensionPoints } = await import('./ExtensionPoints.js');
  for (const [pointName, handlerPath] of Object.entries(overrides)) {
    if (!handlerPath) continue;
    try {
      const compiledOverride = await compilePlugin(pluginPath, handlerPath);
      const overrideMod = await import(pathToFileURL(compiledOverride).href + '?t=' + Date.now());
      const handler = overrideMod.default || overrideMod.handler || overrideMod.activate ||
        (typeof overrideMod === 'function' ? overrideMod : null);
      if (typeof handler !== 'function') {
        throw new Error(`Override "${pointName}" must export a function`);
      }
      extensionPoints.register(pointName, pluginName, handler);
      disposables.push({ dispose() { extensionPoints.unregisterAll(pluginName); } });
    } catch (err) {
      logError(`Failed to register override "${pointName}": ${(err as Error).message}`);
    }
  }
  return disposables;
}

// ── RPC from main → worker ──
// Single listener: PluginAPI handles RPC responses + events;
// PluginHost handles RPC requests. Previously two separate
// parentPort.on('message', ...) registrations ran for every message.

let _handleApiMessage: ((msg: unknown) => void) | null = null;

parentPort?.on('message', async (msg: unknown) => {
  // Phase 1: let PluginAPI handle RPC responses and event pushes
  _handleApiMessage?.(msg);

  // Phase 2: handle RPC requests from main
  const request = msg as { id: string; method: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

  // Skip RPC responses (have result/error but no method) — Phase 1 handled those.
  if (!request.method) return;

  try {
    switch (request.method) {

      case 'plugin.deactivate': {
        deactivateCurrent();
        parentPort?.postMessage({ id: request.id, result: { deactivated: true } });
        break;
      }

      case 'tool.execute': {
        const p = request.params as { pluginName: string; toolName: string; params: Record<string, unknown>; ctx?: { sessionId: string; agentId: string; workspace: string } };
        try {
          const content = await Promise.race([
            executeCurrentTool(p.toolName, p.params, p.ctx || null),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Tool execution timed out (30s)')), 30_000)
            ),
          ]);
          parentPort?.postMessage({ id: request.id, result: { content } });
        } catch (err) {
          parentPort?.postMessage({ id: request.id, error: { code: 'EXECUTION_ERROR', message: (err as Error).message } });
        }
        break;
      }

      case 'plugin.execute': {
        const p = request.params as { pluginName: string; handler: string; body: unknown; params: Record<string, string>; query: string };
        const mod = _activeMod;
        if (!mod) {
          parentPort?.postMessage({ id: request.id, error: { code: 'NOT_ACTIVE', message: 'Plugin not active' } });
          break;
        }
        const handlerFn = mod[p.handler] as ((args: { body: unknown; params: Record<string, string>; query: string }) => Promise<unknown>) | undefined;
        if (typeof handlerFn !== 'function') {
          parentPort?.postMessage({ id: request.id, error: { code: 'NO_HANDLER', message: `Plugin does not export "${p.handler}"` } });
          break;
        }
        try {
          const result = await handlerFn({ body: p.body, params: p.params, query: p.query });
          parentPort?.postMessage({ id: request.id, result });
        } catch (err) {
          parentPort?.postMessage({ id: request.id, error: { code: 'HANDLER_ERROR', message: (err as Error).message } });
        }
        break;
      }

      case 'shutdown': {
        deactivateCurrent();
        parentPort?.postMessage({ id: request.id, result: 'ok' });
        setTimeout(() => process.exit(0), 50);
        break;
      }

      case 'event': {
        break; // Handled by PluginAPI's own listener
      }

      default: {
        // Not a PluginHost method — likely a PluginAPI RPC request.
        // PluginAPI has its own parentPort listener, so silently ignore here
        // to avoid double-processing and spurious UNKNOWN_METHOD errors.
      }
    }
  } catch (err) {
    parentPort?.postMessage({
      id: request.id,
      error: { code: 'WORKER_ERROR', message: (err as Error).message },
    });
  }
});

// ── Single-plugin state ──

const _pluginName: string = (workerData as { pluginName: string })?.pluginName || '';
const _pluginPath: string = (workerData as { pluginPath: string })?.pluginPath || '';
let _activeMod: Record<string, unknown> | null = null;
let _activeInstance: PluginBase | null = null;
let _activeAPI: AnoClawAPI | null = null;
let _activeDisposables: Array<{ dispose(): void }> = [];

// ── Plugin lifecycle ──

async function compilePlugin(pluginPath: string, mainFile: string): Promise<string> {
  const ext = path.extname(mainFile).toLowerCase();
  if (ext !== '.ts' && ext !== '.tsx') {
    return path.join(pluginPath, mainFile);
  }

  const srcPath = path.join(pluginPath, mainFile);
  const cacheDir = path.join(pluginPath, '.compile-cache');
  const outPath = path.join(cacheDir, path.basename(mainFile).replace(/\.tsx?$/, '.mjs'));

  try {
    const srcStat = fs.statSync(srcPath);
    const outStat = fs.statSync(outPath);
    if (outStat.mtimeMs > srcStat.mtimeMs) {
      return outPath;
    }
  } catch { /* file doesn't exist yet */ }

  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  try {
    const esbuild = await import('esbuild');
    const result = await esbuild.build({
      entryPoints: [srcPath],
      bundle: false,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      outfile: outPath,
      write: true,
      sourcemap: false,
      logLevel: 'error',
    });
    if (result.errors.length > 0) {
      throw new Error(`Compilation errors: ${result.errors.map(e => e.text).join('; ')}`);
    }
    return outPath;
  } catch (err) {
    throw new Error(`TypeScript compilation failed: ${(err as Error).message}`);
  }
}

function detectPluginStyle(mod: Record<string, unknown>): 'class' | 'function' {
  const def = mod.default;
  if (def && typeof def === 'function' && def.prototype instanceof PluginBase) {
    return 'class';
  }
  return 'function';
}

async function executeCurrentTool(toolName: string, toolParams: Record<string, unknown>, ctx: { sessionId: string; agentId: string; workspace: string } | null): Promise<string> {
  // Class-based
  if (_activeInstance) {
    return _activeInstance.onToolExecute(toolName, toolParams, ctx);
  }
  // Function-based
  if (_activeMod && typeof _activeMod.executeTool === 'function') {
    return _activeMod.executeTool(toolName, toolParams, ctx);
  }
  throw new Error('Plugin not active or does not export "executeTool"');
}

function deactivateCurrent(): void {
  // Dispose all contributions
  for (const d of [..._activeDisposables].reverse()) {
    try { d.dispose(); } catch { /* no-op */ }
  }
  _activeDisposables = [];

  // Tell main to deregister tools
  parentPort?.postMessage({ id: `dereg-${_pluginName}`, method: 'tools.deregister', params: { pluginName: _pluginName } });

  _activeMod = null;
  _activeInstance = null;
  _activeAPI = null;
}

// ── Single-plugin auto-activation ──

async function activateCurrentPlugin(): Promise<void> {
  if (!_pluginName || !_pluginPath) {
    parentPort?.postMessage({
      id: 'auto-activate-error',
      error: { code: 'NO_PLUGIN', message: 'No plugin specified in workerData' },
    });
    return;
  }

  const loader = new PluginLoader();
  const state = loader.loadOne(_pluginName);
  if (!state) {
    parentPort?.postMessage({
      id: 'auto-activate-error',
      error: { code: 'NOT_FOUND', message: `${_pluginName}: plugin.json not found` },
    });
    return;
  }
  if (state.status === 'error') {
    parentPort?.postMessage({
      id: 'auto-activate-error',
      error: { code: 'LOAD_ERROR', message: `${_pluginName}: ${state.errorMessage}` },
    });
    return;
  }

  // Compile TypeScript if needed
  let resolvedPath: string;
  try {
    resolvedPath = await compilePlugin(state.pluginPath, state.manifest.main);
  } catch (err) {
    parentPort?.postMessage({
      id: 'auto-activate-error',
      error: { code: 'COMPILE_ERROR', message: `${_pluginName}: ${(err as Error).message}` },
    });
    return;
  }

  let mod: Record<string, unknown>;
  try {
    (globalThis as any).PluginBase = PluginBase;
    mod = await import(pathToFileURL(resolvedPath).href + '?t=' + Date.now());
  } catch (err) {
    parentPort?.postMessage({
      id: 'auto-activate-error',
      error: { code: 'IMPORT_ERROR', message: `${_pluginName}: ${(err as Error).message}` },
    });
    return;
  }

  const { api, handleMessage } = createAnoClawAPI(
    (msg) => parentPort?.postMessage(msg),
    _pluginName,
    _pluginPath,
  );
  _handleApiMessage = handleMessage;

  const style = detectPluginStyle(mod);

  // ── Class-based ──
  if (style === 'class') {
    const PluginCtor = mod.default as new (api: AnoClawAPI) => PluginBase;
    const instance = new PluginCtor(api);
    try {
      const result = await Promise.race([
        instance._activate(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Activate timed out after ${ACTIVATE_TIMEOUT_MS}ms`)), ACTIVATE_TIMEOUT_MS)
        ),
      ]);
      _activeInstance = instance;
      _activeMod = mod;
      _activeAPI = api;
      _activeDisposables = Array.isArray(result) ? result : [];

      // Register kernel extension point overrides
      const extDisposables = await _registerExtensionPointOverrides(
        state.pluginPath,
        state.manifest.contributes?.overrides || {},
        _pluginName,
        (msg) => api.log.error(msg),
      );
      _activeDisposables.push(...extDisposables);
    } catch (err) {
      parentPort?.postMessage({
        id: 'auto-activate-error',
        error: { code: 'ACTIVATE_ERROR', message: `${_pluginName}: ${(err as Error).message}` },
      });
      return;
    }
  } else {
    // ── Function-based ──
    if (typeof mod.activate !== 'function') {
      parentPort?.postMessage({
        id: 'auto-activate-error',
        error: { code: 'NO_ACTIVATE', message: `${_pluginName}: must export "activate" function or default class extending PluginBase` },
      });
      return;
    }
    try {
      const result = await Promise.race([
        (mod.activate as (api: AnoClawAPI) => Promise<Array<{ dispose(): void }> | void>)(api),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Activate timed out after ${ACTIVATE_TIMEOUT_MS}ms`)), ACTIVATE_TIMEOUT_MS)
        ),
      ]);
      _activeMod = mod;
      _activeAPI = api;
      _activeDisposables = Array.isArray(result) ? result : [];

      // Register kernel extension point overrides
      const extDisposables2 = await _registerExtensionPointOverrides(
        state.pluginPath,
        state.manifest.contributes?.overrides || {},
        _pluginName,
        (msg) => api.log.error(msg),
      );
      _activeDisposables.push(...extDisposables2);
    } catch (err) {
      parentPort?.postMessage({
        id: 'auto-activate-error',
        error: { code: 'ACTIVATE_ERROR', message: `${_pluginName}: ${(err as Error).message}` },
      });
      return;
    }
  }

  parentPort?.postMessage({ id: 'ready', result: { pluginName: _pluginName } });
}

activateCurrentPlugin().catch(err => {
  parentPort?.postMessage({
    id: 'auto-activate-error',
    error: { code: 'AUTO_ACTIVATE_FAILED', message: `${_pluginName}: ${String(err)}` },
  });
});
