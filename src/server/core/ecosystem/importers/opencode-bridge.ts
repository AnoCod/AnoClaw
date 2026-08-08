/**
 * OpenCode plugin bridge — production path loads plugin modules in a Worker
 * thread; test path supports in-process loading. Tools are registered into
 * ToolRegistry and hooks are mapped to TypedEventBus where names overlap.
 */

import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Tool } from '../../tools/Tool.js';
import { makeError, makeResult } from '../../tools/ToolResult.js';
import { ToolRegistry } from '../../tools/ToolRegistry.js';
import { TypedEventBus } from '../../events/TypedEventBus.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { runOpenCodePluginModule, type OpenCodeToolDef } from './opencode-plugin-runtime.js';

export interface OpenCodeBridgeHandle {
  entryId: string;
  toolNames: string[];
  mappedHooks: number;
  unmappedHooks: string[];
  dispose(): Promise<void>;
}

export interface OpenCodeBridgeOptions {
  /** Use in-process dynamic import instead of a worker (tests only). */
  worker?: boolean;
  timeoutMs?: number;
}

const HOOK_EVENT_MAP: Record<string, string[]> = {
  'tool.execute.before': ['tool:execution_started'],
  'tool.execute.after': ['tool:execution_completed'],
  'file.edited': [],
  'session.created': ['session:created'],
  'session.compacted': [],
  'session.idle': [],
  'session.status': [],
  'session.updated': [],
  'permission.asked': [],
  'permission.replied': [],
  'todo.updated': ['todo:updated'],
  'message.updated': [],
  'message.removed': [],
  'message.part.updated': [],
  'message.part.removed': [],
  'installation.updated': [],
  'command.executed': [],
  'shell.env': [],
  'server.connected': [],
};

function sanitizeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
}

class OpenCodeTool extends Tool {
  private _bridge: OpenCodePluginBridge;
  private _def: OpenCodeToolDef;

  constructor(bridge: OpenCodePluginBridge, def: OpenCodeToolDef) {
    super();
    this._bridge = bridge;
    this._def = def;
  }

  name(): string { return this._bridge.mountName(this._def.name); }
  description(): string { return this._def.description || `OpenCode tool "${this._def.name}" (bridged)`; }
  parametersSchema(): Record<string, unknown> {
    return this._def.parameters ?? { type: 'object', properties: {} };
  }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    try {
      const output = await this._bridge.invoke(this._def.name, params, ctx);
      if (typeof output === 'string') return makeResult(output);
      return makeResult(JSON.stringify(output ?? '', null, 2));
    } catch (err) {
      return makeError((err as Error).message);
    }
  }
}

export class OpenCodePluginBridge {
  private _pluginPath: string;
  private _cwd: string;
  private _options: Required<OpenCodeBridgeOptions>;
  private _worker: Worker | null = null;
  private _runtime: ReturnType<typeof runOpenCodePluginModule> | null = null;
  private _pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private _nextId = 1;
  private _registeredTools: string[] = [];
  private _unsubscribers: Array<() => void> = [];
  private _ready: Promise<{ toolDefs: OpenCodeToolDef[]; hookNames: string[] }>;
  private _disposed = false;

  constructor(pluginPath: string, cwd: string, options: OpenCodeBridgeOptions = {}) {
    this._pluginPath = path.resolve(pluginPath);
    this._cwd = cwd;
    this._options = {
      worker: options.worker ?? true,
      timeoutMs: options.timeoutMs ?? 30_000,
    };
    this._ready = this._start();
  }

  get entryId(): string { return sanitizeName(path.basename(path.dirname(this._pluginPath))); }

  mountName(original: string): string {
    return `opencode_${this.entryId}_${sanitizeName(original)}`;
  }

  async start(): Promise<OpenCodeBridgeHandle> {
    const { toolDefs, hookNames } = await this._ready;
    const registry = ToolRegistry.getInstance();
    for (const def of toolDefs) {
      const name = this.mountName(def.name);
      if (registry.hasTool(name)) continue;
      registry.registerTool(new OpenCodeTool(this, def), 'opencode', { source: 'external', pluginName: `ecosystem:${this.entryId}` });
      this._registeredTools.push(name);
    }

    let mappedHooks = 0;
    const unmappedHooks: string[] = [];
    for (const hook of hookNames) {
      const events = HOOK_EVENT_MAP[hook] ?? [];
      if (events.length === 0) {
        unmappedHooks.push(hook);
        continue;
      }
      for (const event of events) {
        this._unsubscribers.push(
          TypedEventBus.on(event, (payload: unknown) => {
            void this.invoke(hook, payload).catch(() => {});
          }),
        );
      }
      mappedHooks++;
    }

    return {
      entryId: this.entryId,
      toolNames: [...this._registeredTools],
      mappedHooks,
      unmappedHooks,
      dispose: () => this.dispose(),
    };
  }

  async invoke(name: string, params: unknown, ctx?: unknown): Promise<unknown> {
    if (this._disposed) throw new Error('OpenCode bridge is disposed');
    if (this._options.worker) {
      return this._invokeWorker(name, params, ctx);
    }
    if (!this._runtime) throw new Error('OpenCode bridge not started');
    return this._runtime.invoke(name, params, ctx === undefined ? [] : [ctx]);
  }

  async dispose(): Promise<void> {
    this._disposed = true;
    const registry = ToolRegistry.getInstance();
    for (const name of this._registeredTools) {
      try { registry.deregisterTool(name); } catch { /* best-effort */ }
    }
    this._registeredTools = [];
    for (const unsub of this._unsubscribers) { try { unsub(); } catch { /* best-effort */ } }
    this._unsubscribers = [];
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('OpenCode bridge disposed'));
    }
    this._pending.clear();
    if (this._worker) {
      await this._worker.terminate().catch(() => {});
      this._worker = null;
    }
  }

  private async _start(): Promise<{ toolDefs: OpenCodeToolDef[]; hookNames: string[] }> {
    if (this._options.worker) return this._startWorker();
    const mod = await import(pathToFileURL(this._pluginPath).href) as Record<string, unknown>;
    this._runtime = runOpenCodePluginModule(mod, this._cwd);
    return { toolDefs: this._runtime.toolDefs, hookNames: this._runtime.hookNames };
  }

  private _startWorker(): Promise<{ toolDefs: OpenCodeToolDef[]; hookNames: string[] }> {
    return new Promise((resolve, reject) => {
      const workerUrl = new URL('./opencode-worker.js', import.meta.url);
      const worker = new Worker(workerUrl, {
        workerData: { pluginPath: this._pluginPath, cwd: this._cwd },
      });
      this._worker = worker;
      const timer = setTimeout(() => {
        reject(new Error(`OpenCode plugin load timeout after ${this._options.timeoutMs}ms`));
      }, this._options.timeoutMs);

      worker.on('message', (msg) => {
        if (msg.type === 'ready') {
          clearTimeout(timer);
          resolve({ toolDefs: msg.toolDefs ?? [], hookNames: msg.hookNames ?? [] });
        } else if (msg.type === 'error') {
          clearTimeout(timer);
          reject(new Error(msg.message));
        } else if (msg.type === 'invokeResult') {
          const pending = this._pending.get(msg.id);
          if (!pending) return;
          this._pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) pending.reject(new Error(msg.error));
          else pending.resolve(msg.output);
        }
      });
      worker.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      worker.on('exit', () => {
        this._worker = null;
      });
    });
  }

  private _invokeWorker(name: string, params: unknown, ctx?: unknown): Promise<unknown> {
    if (!this._worker) return Promise.reject(new Error('OpenCode worker is not running'));
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`OpenCode hook invocation timeout: ${name}`));
      }, this._options.timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._worker!.postMessage({ type: 'invoke', id, name, params, extra: ctx === undefined ? [] : [ctx] });
    });
  }
}

export const OPENCODE_HOOK_EVENT_MAP = HOOK_EVENT_MAP;
