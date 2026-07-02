// PluginAPI.ts — The `anoclaw` API object passed to plugin's activate() function.
// Every method sends an RPC request over MessageChannel to the main thread.
// This runs INSIDE the Worker Thread.

import type {
  PluginLLMMessage, PluginLLMOptions, PluginLLMResponse,
  PluginGrepMatch, PluginMemorySaveInput, PluginMemorySearchOptions,
  PluginEventMessage,
} from './PluginRPC.js';
import { generateRPCLabel } from './PluginRPC.js';
import * as path from 'path';
import { SessionManager } from '../session/index.js';

// ── Exported interfaces ──

/** What the plugin sees — a typed API object */
export interface AnoClawAPI {
  tools: {
    register(toolDef: PluginToolDefinition): Promise<void>;
    /** Execute any registered tool directly */
    execute(name: string, params: Record<string, unknown>): Promise<string>;
  };
  api: {
    call(method: string, path: string, body?: Record<string, unknown>): Promise<ApiCallResult>;
  };
  log: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
  context: {
    pluginName: string;
    pluginPath: string;
    storagePath: string;
  };
  routes: {
    register(routes: PluginRouteDef[]): Promise<void>;
  };
  /** Call LLM directly using the system's configured provider */
  llm: {
    chat(messages: PluginLLMMessage[], options?: PluginLLMOptions): Promise<PluginLLMResponse>;
  };
  /** Workspace filesystem operations. Pass sessionId to scope to session workspace. */
  fs: {
    read(path: string, sessionId?: string): Promise<string>;
    write(path: string, content: string, sessionId?: string): Promise<void>;
    grep(pattern: string, glob?: string, sessionId?: string): Promise<PluginGrepMatch[]>;
    glob(pattern: string, sessionId?: string): Promise<string[]>;
  };
  /** Persistent memory CRUD */
  memory: {
    search(query: string, options?: PluginMemorySearchOptions): Promise<Record<string, unknown>[]>;
    save(entry: PluginMemorySaveInput): Promise<Record<string, unknown> | null>;
    list(options?: PluginMemorySearchOptions): Promise<Record<string, unknown>[]>;
    delete(name: string, options?: PluginMemorySearchOptions): Promise<void>;
  };
  /**
   * Subscribe to kernel events emitted via TypedEventBus.
   *
   * Commonly available events:
   *   delegation:started | delegation:working | delegation:tool_executing
   *   delegation:completed | delegation:error
   *   tool:execution_started | tool:execution_completed
   *   session:created | session:message_appended
   *   agent:status_changed | agent:registered
   *   llm:token_usage
   *   loop:compaction_triggered
   *   memory:saved
   */
  events: {
    on(event: string, handler: (data: unknown) => void): void;
    off(event: string, handler: (data: unknown) => void): void;
  };
  /** Push messages to connected WebSocket clients */
  ws: {
    broadcast(message: Record<string, unknown>): Promise<void>;
  };
  /** Inject dynamic sections into the system prompt */
  prompt: {
    inject(name: string, content: string, priority?: number): Promise<void>;
  };
  ui: {
    mount(slot: string, htmlContent: string, opts?: { position?: 'append' | 'prepend'; replace?: boolean }): Promise<void>;
    unmountAll(slot: string): Promise<void>;
  };
}

export interface PluginRouteDef {
  method: string;
  path: string;
  handler: string;
}

export interface PluginToolDefinition {
  name: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  category?: string;
}

export interface ApiCallResult {
  statusCode: number;
  body: Record<string, unknown>;
}

// ── Internal: event handler registry ──

interface EventSubscription {
  event: string;
  handler: (data: unknown) => void;
}

// ── Factory ──

function resolveToWorkspace(filePath: string, sessionId?: string): string {
  let root = process.cwd();
  if (sessionId) {
    const session = SessionManager.getInstance().session(sessionId);
    if (session?.workspace) root = session.workspace;
  }
  const resolved = path.resolve(root, filePath);
  if (!resolved.startsWith(path.resolve(root))) {
    throw new Error(`Path escapes workspace: ${filePath}`);
  }
  return resolved;
}

export function createAnoClawAPI(
  sendMessage: (msg: unknown) => void,
  pluginName: string,
  pluginPath: string,
): { api: AnoClawAPI; handleMessage: (msg: unknown) => void } {
  const pending = new Map<string, RPCCallbacks>();
  const eventSubs: EventSubscription[] = [];

  // ── Message handler (caller registers as the sole parentPort.on('message') listener) ──

  const handleMessage = (msg: unknown) => {
    const message = msg as { id: string; method?: string; result?: unknown; error?: { code: string; message: string }; params?: { event: string; data: unknown } };

    // Event push from main → dispatch to registered handlers
    if (message.method === 'event' && message.params) {
      const { event, data } = message.params;
      for (const sub of eventSubs) {
        if (sub.event === event) {
          try { sub.handler(data); } catch { /* user handler error, ignore */ }
        }
      }
      return;
    }

    // RPC response
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id);
    if (message.error) {
      p.reject(new Error(`[${message.error.code}] ${message.error.message}`));
    } else {
      p.resolve(message.result);
    }
  };

  // ── RPC helpers ──

  function rpc(method: string, params: unknown, isFireAndForget: boolean = false): Promise<unknown> {
    const id = generateRPCLabel(method, pluginName);
    if (isFireAndForget) {
      sendMessage({ id, method, params });
      return Promise.resolve(undefined);
    }
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      sendMessage({ id, method, params });
    });
  }

  const storagePath = path.join(pluginPath, 'data');

  // ── Build the API ──

  const api: AnoClawAPI = {
    // ── Existing ──

    tools: {
      async register(toolDef: PluginToolDefinition): Promise<void> {
        await rpc('tools.register', {
          pluginName,
          toolDef: { ...toolDef, category: toolDef.category || 'Plugin' },
        });
      },

      async execute(name: string, params: Record<string, unknown>): Promise<string> {
        const result = await rpc('tools.execute', { pluginName, toolName: name, toolParams: params });
        const r = result as { content: string };
        return r.content;
      },
    },

    api: {
      async call(method: string, path: string, body?: Record<string, unknown>): Promise<ApiCallResult> {
        const result = await rpc('api.call', { method, path, body });
        return result as ApiCallResult;
      },
    },

    log: {
      info(msg: string) { rpc('log', { pluginName, level: 'info', message: msg }, true); },
      warn(msg: string) { rpc('log', { pluginName, level: 'warn', message: msg }, true); },
      error(msg: string) { rpc('log', { pluginName, level: 'error', message: msg }, true); },
    },

    context: { pluginName, pluginPath, storagePath },

    routes: {
      async register(routes: PluginRouteDef[]): Promise<void> {
        await rpc('routes.register', { pluginName, routes });
      },
    },

    // ── New: LLM ──

    llm: {
      async chat(messages: PluginLLMMessage[], options?: PluginLLMOptions): Promise<PluginLLMResponse> {
        const result = await rpc('llm.chat', { pluginName, messages, options: options || {} });
        return result as PluginLLMResponse;
      },
    },

    // ── New: Filesystem (scoped to session workspace when sessionId provided) ──

    fs: {
      async read(filePath: string, sessionId?: string): Promise<string> {
        const resolvedPath = resolveToWorkspace(filePath, sessionId);
        const result = await rpc('fs.read', { pluginName, path: resolvedPath });
        return (result as { content: string }).content;
      },
      async write(filePath: string, content: string, sessionId?: string): Promise<void> {
        const resolvedPath = resolveToWorkspace(filePath, sessionId);
        await rpc('fs.write', { pluginName, path: resolvedPath, content });
      },
      async grep(pattern: string, glob?: string, sessionId?: string): Promise<PluginGrepMatch[]> {
        const resolvedGlob = glob ? resolveToWorkspace(glob, sessionId) : '**/*';
        const result = await rpc('fs.grep', { pluginName, pattern, glob: resolvedGlob });
        return (result as { matches: PluginGrepMatch[] }).matches;
      },
      async glob(pattern: string, sessionId?: string): Promise<string[]> {
        const resolvedPattern = resolveToWorkspace(pattern, sessionId);
        const result = await rpc('fs.glob', { pluginName, pattern: resolvedPattern });
        return (result as { files: string[] }).files;
      },
    },

    // ── New: Memory ──

    memory: {
      async search(query: string, options?: PluginMemorySearchOptions): Promise<Record<string, unknown>[]> {
        const result = await rpc('memory.search', { pluginName, query, options: options || {} });
        return (result as { entries: Record<string, unknown>[] }).entries;
      },
      async save(entry: PluginMemorySaveInput): Promise<Record<string, unknown> | null> {
        const result = await rpc('memory.save', { pluginName, entry });
        return (result as { entry: Record<string, unknown> | null }).entry;
      },
      async list(options?: PluginMemorySearchOptions): Promise<Record<string, unknown>[]> {
        const result = await rpc('memory.list', { pluginName, options: options || {} });
        return (result as { entries: Record<string, unknown>[] }).entries;
      },
      async delete(name: string, options?: PluginMemorySearchOptions): Promise<void> {
        await rpc('memory.delete', { pluginName, name, options: options || {} });
      },
    },

    // ── New: Events ──

    events: {
      on(event: string, handler: (data: unknown) => void): void {
        eventSubs.push({ event, handler });
        // Tell main to subscribe — fire and forget, only on first subscriber for this event
        const existingCount = eventSubs.filter(s => s.event === event).length;
        if (existingCount === 1) {
          rpc('events.subscribe', { pluginName, event }, true);
        }
      },
      off(event: string, handler: (data: unknown) => void): void {
        const idx = eventSubs.findIndex(s => s.event === event && s.handler === handler);
        if (idx >= 0) eventSubs.splice(idx, 1);
        // Tell main to unsubscribe if no more handlers for this event
        const remaining = eventSubs.filter(s => s.event === event).length;
        if (remaining === 0) {
          rpc('events.unsubscribe', { pluginName, event }, true);
        }
      },
    },

    // ── New: WebSocket ──

    ws: {
      async broadcast(message: Record<string, unknown>): Promise<void> {
        await rpc('ws.broadcast', { pluginName, message });
      },
    },

    // ── New: Prompt injection ──

    prompt: {
      async inject(name: string, content: string, priority?: number): Promise<void> {
        await rpc('prompt.inject', { pluginName, name, content, priority: priority ?? 50 });
      },
    },

    // ── New: UI ──

    ui: {
      async mount(slot: string, htmlContent: string, opts?: { position?: 'append' | 'prepend'; replace?: boolean }): Promise<void> {
        await rpc('ui.mount', { pluginName, slot, htmlContent, opts: opts || {} });
      },
      async unmountAll(slot: string): Promise<void> {
        await rpc('ui.unmountAll', { pluginName, slot });
      },
    },
  };

  return { api, handleMessage };
}

// Re-export RPCCallbacks for internal use
import type { RPCCallbacks } from './PluginRPC.js';
