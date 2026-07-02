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
import { MemoryScope, MemoryType } from '../memory/MemoryEntry.js';
import { ApiServer } from '../../gateway/ApiServer.js';
import { createLogger } from '../logger.js';
import { PluginToolProxy } from './PluginToolProxy.js';
import { extensionPoints } from './ExtensionPoints.js';
import { TypedEventBus } from '../events/index.js';
import { SessionStore } from '../session/SessionStore.js';
import { writablePath } from '../../infra/WritablePath.js';
import { SettingsManager } from '../../infra/storage/SettingsManager.js';
import { createLLMProvider } from '../../infra/llm/provider-factory.js';
import { APIScheduler } from '../../infra/llm/APIScheduler.js';
import { WsServer } from '../../infra/network/WsServer.js';
import { PluginLoader } from './PluginLoader.js';
import type { PluginState, PluginLLMMessage, PluginLLMOptions, PluginMemorySearchOptions } from './PluginRPC.js';
import type { ExecutionContext } from '../../../shared/types/session.js';
import type { LLMOptions } from '../../../shared/types/llm.js';

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
      }
      inst._workers.clear();
      inst._pending.clear();
      inst._ready.clear();
      inst._installedTools.clear();
      inst._eventSubs.clear();
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
  private _loader = new PluginLoader();

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
        log.warn('Plugin auto-activate error', { pluginName, code: errInfo?.code, message: errInfo?.message });
        this._notifyPluginError(pluginName, errInfo?.message || 'Unknown plugin error');
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

    // Unregister this plugin's tools (worker is gone, tools won't respond)
    const toRemove: string[] = [];
    for (const [toolName, pn] of this._installedTools) {
      if (pn === pluginName) toRemove.push(toolName);
    }
    for (const toolName of toRemove) {
      ToolRegistry.getInstance().deregisterTool(toolName);
      this._installedTools.delete(toolName);
    }

    // Clean up event subscriptions for this plugin
    for (const [, plugins] of this._eventSubs) {
      plugins.delete(pluginName);
    }

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

  /** Process a worker→main RPC method */
  private async _dispatchWorkerRPC(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'tools.register': {
        const p = params as {
          pluginName: string;
          toolDef: { name: string; description: string; parametersSchema: Record<string, unknown>; category: string };
        };
        this._registerPluginTool(p.pluginName, p.toolDef);
        return { registered: true };
      }

      case 'api.call': {
        const p = params as { method: string; path: string; body?: Record<string, unknown> };
        const api = ApiServer.getInstance();
        const result = await api.callInternal(p.method, p.path, p.body);
        return result;
      }

      case 'tools.deregister': {
        const p = params as { pluginName: string };
        this._deregisterPluginTools(p.pluginName);
        // Also clean up event subscriptions for this plugin
        for (const [eventName, plugins] of this._eventSubs) {
          plugins.delete(p.pluginName);
          if (plugins.size === 0) this._eventSubs.delete(eventName);
        }
        return { deregistered: true };
      }

      case 'routes.register': {
        const p = params as { pluginName: string; routes: Array<{ method: string; path: string; handler: string }> };
        ApiServer.getInstance().registerPluginRoutes(p.pluginName, p.routes);
        return { registered: p.routes.length };
      }

      case 'log': {
        const p = params as { pluginName: string; level: string; message: string };
        switch (p.level) {
          case 'error': log.error(`[${p.pluginName}] ${p.message}`); break;
          case 'warn': log.warn(`[${p.pluginName}] ${p.message}`); break;
          default: log.info(`[${p.pluginName}] ${p.message}`); break;
        }
        return null;
      }

      // ── MCP / Meeting / Gateway / Workflow services ──
      // Removed from kernel — plugins must self-host these features.
      // Plugin extension.js can call anoclaw.api.call() to reach
      // the plugin's own HTTP endpoints instead.
      case 'mcp.listServers':
      case 'mcp.getServer':
      case 'meeting.create':
      case 'gateway.send':
      case 'gateway.status':
      case 'workflow.list':
      case 'workflow.get':
      case 'workflow.save':
      case 'workflow.delete':
        throw new Error(`Service '${method}' has moved to plugin — use anoclaw.api.call() instead`);

      // ── Extended Plugin API (Phase 2) ──

      case 'tools.execute': {
        const p = params as { pluginName: string; toolName: string; toolParams: Record<string, unknown> };
        const ctx: ExecutionContext = {
          sessionId: `plugin:${p.pluginName}`,
          agentId: `plugin:${p.pluginName}`,
          workspace: process.cwd(),
          userConfirmed: true,
        };
        const result = await ToolRegistry.getInstance().execute(p.toolName, p.toolParams, ctx);
        return { content: truncateResult(result.content), success: result.success, errorMessage: result.errorMessage };
      }

      case 'llm.chat': {
        const p = params as { pluginName: string; messages: PluginLLMMessage[]; options: PluginLLMOptions };
        const settings = SettingsManager.getInstance();
        const model = p.options.model || settings.get<string>('model', 'deepseek-chat');
        const apiUrl = settings.get<string>('apiUrl', 'https://api.deepseek.com');
        const apiKey = settings.get<string>('apiKey', '');
        const provider = settings.get<string>('provider', 'openai-compatible');
        const temperature = p.options.temperature ?? settings.get<number>('llm.temperature', 0.7);
        const maxTokens = p.options.maxTokens || settings.get<number>('llm.maxTokens', 4096);

        const llmOptions: LLMOptions = {
          model,
          maxTokens,
          temperature,
          contextWindow: 128000,
          apiUrl,
          apiKey,
        };

        const llmProvider = createLLMProvider(provider, extensionPoints);
        const rawMsgs = p.messages as Array<{ role: string; content: string }>;

        // Extract system messages — chat() injects them via systemPrompt parameter,
        // _buildOpenAIMessages skips inline system messages, so passing them inline
        // causes them to be dropped silently.
        const systemMsgs = rawMsgs.filter(m => m.role === 'system').map(m => m.content);
        const systemPrompt = systemMsgs.join('\n\n');
        const msgs = rawMsgs.filter(m => m.role !== 'system');

        await APIScheduler.getInstance().acquireSlot(apiKey, maxTokens);

        const stream = llmProvider.chat(msgs, [], systemPrompt, llmOptions);
        let content = '';

        for await (const event of stream) {
          switch (event.type) {
            case 'text_delta': content += event.content || ''; break;
            case 'done': break;
            case 'error': log.warn('Plugin LLM stream error', { pluginName: p.pluginName, error: event.errorMessage }); break;
          }
        }

        return { content: truncateResult(content), finishReason: 'stop', usage: { inputTokens: Math.ceil(JSON.stringify(msgs).length / 4), outputTokens: Math.ceil(content.length / 4) } };
      }

      case 'fs.read': {
        const p = params as { pluginName: string; path: string };
        const resolvedPath = path.resolve(p.path);
        assertPathWithinWorkspace(resolvedPath);
        const content = fs.readFileSync(resolvedPath, 'utf-8');
        return { content };
      }

      case 'fs.write': {
        const p = params as { pluginName: string; path: string; content: string };
        const resolvedPath = path.resolve(p.path);
        assertPathWithinWorkspace(resolvedPath);
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(resolvedPath, p.content, 'utf-8');
        return { written: true };
      }

      case 'fs.grep': {
        const p = params as { pluginName: string; pattern: string; glob: string };
        const ctx: ExecutionContext = {
          sessionId: `plugin:${p.pluginName}`,
          agentId: `plugin:${p.pluginName}`,
          workspace: process.cwd(),
          userConfirmed: true,
        };
        const result = await ToolRegistry.getInstance().execute('Grep', { pattern: p.pattern, path: p.glob || '.' }, ctx);
        // Parse grep output "file:line:content" lines
        const lines = (result.content || '').split('\n').filter(Boolean);
        const matches = lines.map(line => {
          const idx = line.indexOf(':');
          const idx2 = line.indexOf(':', idx + 1);
          if (idx < 0 || idx2 < 0) return { file: line, line: 0, content: '' };
          return {
            file: line.slice(0, idx),
            line: parseInt(line.slice(idx + 1, idx2), 10) || 0,
            content: line.slice(idx2 + 1),
          };
        });
        return { matches };
      }

      case 'fs.glob': {
        const p = params as { pluginName: string; pattern: string };
        const ctx: ExecutionContext = {
          sessionId: `plugin:${p.pluginName}`,
          agentId: `plugin:${p.pluginName}`,
          workspace: process.cwd(),
          userConfirmed: true,
        };
        const result = await ToolRegistry.getInstance().execute('Glob', { pattern: p.pattern, path: '.' }, ctx);
        const files = (result.content || '').split('\n').filter(Boolean);
        return { files };
      }

      case 'memory.search': {
        const p = params as { pluginName: string; query: string; options: PluginMemorySearchOptions };
        const mm = MemoryManager.getInstance();
        const agentId = p.options.agentId || p.pluginName;
        const scope = (p.options.scope as MemoryScope) || MemoryScope.Team;
        const entries = await mm.search(agentId, scope, p.query, p.options.sessionId, p.options.subScope, p.options.fuzzy ?? true);
        const limited = p.options.limit ? entries.slice(0, p.options.limit) : entries;
        return { entries: limited.map(e => ({ ...e })) };
      }

      case 'memory.save': {
        const p = params as { pluginName: string; entry: { name: string; type: string; description: string; content: string; scope: string; sessionId?: string; subScope?: 'team' | 'personal' } };
        const mm = MemoryManager.getInstance();
        const agentId = p.pluginName;
        const saved = await mm.saveFromParams(agentId, {
          scope: p.entry.scope,
          type: p.entry.type,
          name: p.entry.name,
          description: p.entry.description,
          content: p.entry.content,
        });
        return { entry: { ...saved } };
      }

      case 'memory.list': {
        const p = params as { pluginName: string; options: PluginMemorySearchOptions };
        const mm = MemoryManager.getInstance();
        const agentId = p.options.agentId || p.pluginName;
        const scope = (p.options.scope as MemoryScope) || MemoryScope.Team;
        const entries = await mm.search(agentId, scope, '', p.options.sessionId, p.options.subScope, false);
        const limited = p.options.limit ? entries.slice(0, p.options.limit) : entries;
        return { entries: limited.map(e => ({ ...e })) };
      }

      case 'memory.delete': {
        const p = params as { pluginName: string; name: string; options: PluginMemorySearchOptions };
        const mm = MemoryManager.getInstance();
        const agentId = p.options.agentId || p.pluginName;
        const scope = (p.options.scope as MemoryScope) || MemoryScope.Team;
        const removed = await mm.remove(agentId, scope, p.name, p.options.sessionId, p.options.subScope);
        return { deleted: removed };
      }

      case 'events.subscribe': {
        const p = params as { pluginName: string; event: string };
        if (!this._eventSubs.has(p.event)) this._eventSubs.set(p.event, new Set());
        this._eventSubs.get(p.event)!.add(p.pluginName);
        log.info('Plugin subscribed to event', { pluginName: p.pluginName, event: p.event });
        return { subscribed: true };
      }

      case 'events.unsubscribe': {
        const p = params as { pluginName: string; event: string };
        const subs = this._eventSubs.get(p.event);
        if (subs) {
          subs.delete(p.pluginName);
          if (subs.size === 0) this._eventSubs.delete(p.event);
        }
        log.info('Plugin unsubscribed from event', { pluginName: p.pluginName, event: p.event });
        return { unsubscribed: true };
      }

      case 'ws.broadcast': {
        const p = params as { pluginName: string; message: Record<string, unknown> };
        WsServer.getInstance().broadcast(p.message);
        return { broadcast: true };
      }

      case 'prompt.inject': {
        const p = params as { pluginName: string; name: string; content: string; priority: number };
        const pa = PromptAssembler.getInstance();
        const sectionName = `plugin:${p.pluginName}:${p.name}`;
        pa.registerSection({
          name: sectionName,
          cacheBreak: false,
          compute: () => p.content,
        }, 'dynamic');
        log.info('Plugin prompt injected', { pluginName: p.pluginName, name: p.name });
        return { injected: true };
      }

      case 'ui.mount': {
        const p = params as { pluginName: string; slot: string; htmlContent: string; opts: { position?: string; replace?: boolean } };
        WsServer.getInstance().broadcast({
          type: 'plugin:ui:mount',
          slot: p.slot,
          htmlContent: p.htmlContent,
          opts: p.opts || {},
          pluginName: p.pluginName,
        });
        return { ok: true };
      }

      case 'ui.unmountAll': {
        const p = params as { pluginName: string; slot: string };
        WsServer.getInstance().broadcast({
          type: 'plugin:ui:unmountAll',
          slot: p.slot,
          pluginName: p.pluginName,
        });
        return { ok: true };
      }

      default:
        throw new Error(`Unknown RPC method: ${method}`);
    }
  }

  // ── Tool management ──

  private _registerPluginTool(
    pluginName: string,
    toolDef: { name: string; description: string; parametersSchema: Record<string, unknown>; category: string },
  ): void {
    // Deregister old tool with same name first (handles reload case)
    if (this._installedTools.has(toolDef.name)) {
      ToolRegistry.getInstance().deregisterTool(toolDef.name);
    }
    const proxy = new PluginToolProxy(pluginName, toolDef, this);
    ToolRegistry.getInstance().registerTool(proxy, toolDef.category || 'Plugin');
    this._installedTools.set(toolDef.name, pluginName);
    log.info('Plugin tool registered', { pluginName, toolName: toolDef.name });
  }

  private _deregisterPluginTools(pluginName: string): void {
    const toRemove: string[] = [];
    for (const [toolName, pn] of this._installedTools) {
      if (pn === pluginName) toRemove.push(toolName);
    }
    for (const toolName of toRemove) {
      ToolRegistry.getInstance().deregisterTool(toolName);
      this._installedTools.delete(toolName);
    }
    if (toRemove.length > 0) {
      log.info('Plugin tools deregistered', { pluginName, count: toRemove.length });
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

    const id = `${pluginName}:${method}:${Math.random().toString(36).slice(2, 8)}`;
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
  async listPlugins(): Promise<
    Array<{ name: string; displayName: string; version: string; status: string; errorMessage?: string }>
  > {
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

  /** Reload a single plugin: terminate old worker, spawn new one. */
  async reloadPlugin(name: string): Promise<PluginState> {
    // Terminate old worker first
    const oldWorker = this._workers.get(name);
    if (oldWorker) {
      // Deregister tools before killing worker (same as deactivate)
      const toRemove: string[] = [];
      for (const [toolName, pn] of this._installedTools) {
        if (pn === name) toRemove.push(toolName);
      }
      for (const toolName of toRemove) {
        ToolRegistry.getInstance().deregisterTool(toolName);
        this._installedTools.delete(toolName);
      }
      // Clean up event subscriptions
      for (const [, plugins] of this._eventSubs) {
        plugins.delete(name);
      }

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
    this._spawnPluginWorker(name, state.pluginPath);

    // Wait for ready signal (max 20s)
    const result = await new Promise<PluginState>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Reload timed out after 20s`));
      }, 20_000);
      const check = () => {
        if (this._ready.has(name)) {
          clearTimeout(timeout);
          this.off('plugin-ready', check);
          resolve({ ...state, status: 'activated', activatedAt: new Date().toISOString() });
        }
      };
      this.on('plugin-ready', check);
    });
    return result;
  }

  /** Activate a single plugin (spawn worker on demand). */
  async activatePlugin(name: string): Promise<PluginState> {
    if (this._ready.has(name)) {
      const state = this._loader.loadOne(name);
      return { ...(state || { manifest: { name, displayName: name, version: '0.0.0', main: '', activationEvents: [] }, pluginPath: '' }), status: 'activated' as const };
    }
    const state = this._loader.loadOne(name);
    if (!state) throw new Error(`Plugin "${name}" not found`);
    this._spawnPluginWorker(name, state.pluginPath);
    return { ...state, status: 'loaded' as const };
  }

  /** Deactivate a single plugin (terminate its worker). */
  async deactivatePlugin(name: string): Promise<{ deactivated: boolean }> {
    const worker = this._workers.get(name);
    if (!worker) return { deactivated: false };

    // Deregister tools
    const toRemove: string[] = [];
    for (const [toolName, pn] of this._installedTools) {
      if (pn === name) toRemove.push(toolName);
    }
    for (const toolName of toRemove) {
      ToolRegistry.getInstance().deregisterTool(toolName);
      this._installedTools.delete(toolName);
    }

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

    TypedEventBus.onAny((event, payload) => {
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
