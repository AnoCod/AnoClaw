# Plugin Host System

Worker-thread-isolated plugin system (VSCode Extension model). Each plugin runs in its own Node.js Worker Thread with crash isolation. Plugins communicate with the kernel via bidirectional MessageChannel RPC. Supports two plugin styles: class-based (`PluginBase`) and function-based (`activate()`).

## Public API

### PluginHostManager (Singleton)

```ts
import { PluginHostManager } from './PluginHostManager.js';
const phm = PluginHostManager.getInstance();
```

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `start()` | — | `void` | Scan `plugins/`, spawn one Worker per plugin, inject ExtensionPoints, start file watcher |
| `stop()` | — | `Promise<void>` | Gracefully shut down all plugin workers |
| `listPlugins()` | — | `Promise<Array<PluginState>>` | List all plugins with status, version, contributes |
| `reloadPlugin(name)` | `name: string` | `Promise<PluginState>` | Terminate old worker, reload manifest, spawn new worker |
| `activatePlugin(name)` | `name: string` | `Promise<PluginState>` | Spawn worker for a plugin on demand |
| `deactivatePlugin(name)` | `name: string` | `Promise<{ deactivated: boolean }>` | Terminate plugin worker + deregister tools |
| `executePluginTool(pluginName, toolName, params, ctx)` | `pluginName: string`, `toolName: string`, `params: Record<string, unknown>`, `ctx: ExecutionContext` | `Promise<string>` | Execute a plugin tool via RPC (30s timeout) |
| `executeHandler(pluginName, handler, reqData)` | `pluginName: string`, `handler: string`, `reqData: { body, params, query }` | `Promise<unknown>` | Execute a named handler exported by the plugin |
| `isRunning()` | — | `boolean` | Whether any workers are running |
| `isPluginRunning(pluginName)` | `pluginName: string` | `boolean` | Whether a specific plugin is activated |

### PluginToolProxy

```ts
class PluginToolProxy extends Tool {
  constructor(pluginName: string, toolDef: PluginToolDefinition, hostManager: PluginHostManager);
  // Standard Tool interface — proxies execute() to plugin worker via RPC
  // category = 'Plugin', riskLevel = High, timeout = 30s
}
```

### ExtensionPoints

```ts
const extensionPoints: ExtensionPointRegistry;

class ExtensionPointRegistry {
  register(point: string, pluginName: string, handler: OverrideHandler): void;
  unregisterAll(pluginName: string): void;
  get(point: string): OverrideHandler | null;
  has(point: string): boolean;
  list(): Array<{ point: string; plugin: string }>;
}
```

**8 Overridable Points:**

| Point | Kernel Consumer | Purpose |
|-------|----------------|---------|
| `promptAssembler` | PromptAssembler | Replace system prompt assembly |
| `memoryStore` | MemoryManager | Replace memory read/write |
| `sessionStore` | SessionStore | Replace session persistence |
| `settingsStore` | SettingsManager | Replace settings storage |
| `llmProvider` | Provider factory | Replace LLM provider |
| `toolExecutor` | ToolRegistry | Replace tool execution |
| `agentLoop` | AgentLoop | Replace agent loop logic |

### PluginStorage

```ts
class PluginStorage {
  static listKeys(pluginName: string): string[];
  static get<T>(pluginName: string, key: string): T | null;
  static set<T>(pluginName: string, key: string, value: T): void;
  static delete(pluginName: string, key: string): boolean;
  static getConfig<T>(pluginName: string): T | null;
  static setConfig(pluginName: string, config: Record<string, unknown>): void;
}
// Data stored at plugins/<name>/data/<key>.json
```

### PluginRPC Types

```ts
interface PluginManifest {
  name: string;
  displayName: string;
  version: string;
  description?: string;
  publisher?: string;
  main: string;                          // Entry file (.js or .ts)
  activationEvents: string[];
  contributes?: {
    tools?: Array<{ name?: string }>;
    pages?: Array<{ id, title, icon?, order?, html? }>;
    skills?: string[];
    commands?: Array<{ id, label }>;
    configuration?: { title?, properties };
    apiRoutes?: Array<{ method, path }>;
    overrides?: Record<string, string | null>;
  };
  engines?: { anoclaw: string };
}

interface PluginState {
  manifest: PluginManifest;
  pluginPath: string;
  status: 'loaded' | 'activated' | 'error';
  errorMessage?: string;
  activatedAt?: string;
}
```

### AnoClawAPI (Plugin-side)

The `anoclaw` object passed to `activate(anoclaw)`:

```ts
interface AnoClawAPI {
  tools: {
    register(toolDef: PluginToolDefinition): Promise<void>;
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
  context: { pluginName: string; pluginPath: string; storagePath: string };
  routes: {
    register(routes: PluginRouteDef[]): Promise<void>;
  };
  llm: {
    chat(messages: PluginLLMMessage[], options?: PluginLLMOptions): Promise<PluginLLMResponse>;
  };
  fs: {
    read(path: string, sessionId?: string): Promise<string>;
    write(path: string, content: string, sessionId?: string): Promise<void>;
    grep(pattern: string, glob?: string, sessionId?: string): Promise<PluginGrepMatch[]>;
    glob(pattern: string, sessionId?: string): Promise<string[]>;
  };
  memory: {
    search(query: string, options?: PluginMemorySearchOptions): Promise<Record<string, unknown>[]>;
    save(entry: PluginMemorySaveInput): Promise<Record<string, unknown> | null>;
    list(options?: PluginMemorySearchOptions): Promise<Record<string, unknown>[]>;
    delete(name: string, options?: PluginMemorySearchOptions): Promise<void>;
  };
  events: {
    on(event: string, handler: (data: unknown) => void): void;
    off(event: string, handler: (data: unknown) => void): void;
  };
  ws: {
    broadcast(message: Record<string, unknown>): Promise<void>;
  };
  prompt: {
    inject(name: string, content: string, priority?: number): Promise<void>;
  };
  ui: {
    mount(slot: string, htmlContent: string, opts?: { position?, replace? }): Promise<void>;
    unmountAll(slot: string): Promise<void>;
  };
}
```

## Plugin Lifecycle

```
PluginLoader.scan('plugins/')
  └→ Parse plugin.json → validate manifest
      └→ PluginHostManager.start()
          └→ Spawn Worker (PluginHost.js)
              └→ Worker loads plugin.json
                  └→ Compile TypeScript (esbuild, if .ts)
                      └→ Dynamic import extension.js
                          ├→ Class-based: new PluginCtor(api) → instance._activate()
                          └→ Function-based: mod.activate(api)
                              └→ Register tools / routes / overrides
                                  └→ Send 'ready' signal to main thread
                                      └→ Plugin activated ✓
```

### Crash Recovery

- Each plugin has its own Worker — crash isolation
- On crash: deregister tools, clean event subs, exponential backoff restart (500ms → 1s → 2s → ... → 30s max)
- Crash count tracked per plugin

### File Watcher

- `fs.watch` on `plugins/` directory (recursive)
- 1-second debounce per plugin
- Auto-reloads on any file change
- Broadcasts `pluginsChanged` to all WS clients

### Two Plugin Styles

**Class-based** (recommended for complex plugins):
```ts
import { PluginBase } from 'anoclaw';
export default class MyPlugin extends PluginBase {
  async _activate() { /* register tools, routes */ }
  async onToolExecute(name, params, ctx) { /* handle tool calls */ }
}
```

**Function-based** (simpler):
```ts
export async function activate(anoclaw) {
  await anoclaw.tools.register({ name: 'MyTool', ... });
}
export async function executeTool(name, params, ctx) {
  if (name === 'MyTool') return `result`;
}
```

## RPC Protocol

Bidirectional JSON messaging over `MessageChannel`:

```
Main → Worker:  { id, method, params }
Worker → Main:  { id, result } | { id, error: { code, message } }

Main ← Worker (event push): { method: 'event', params: { event, data } }
```

**Main→Worker methods**: `tool.execute`, `plugin.execute`, `plugin.deactivate`, `shutdown`, `event`

**Worker→Main methods** (30+ RPC methods):
`tools.register`, `tools.deregister`, `tools.execute`, `api.call`, `routes.register`, `log`, `llm.chat`, `fs.read/write/grep/glob`, `memory.search/save/list/delete`, `events.subscribe/unsubscribe`, `ws.broadcast`, `prompt.inject`, `ui.mount/unmountAll`

## Dependencies

### Called by
- `main.ts` — `start()` at boot
- `PluginRoutes` — HTTP API for plugin management
- `PluginStorageRoutes` / `PluginConfigRoutes` — storage API
- `PluginDetailRoute` / `PluginDiagnosticRoutes` — diagnostics
- `ToolRegistry` — routes plugin tool execution through `PluginToolProxy`

### Depends on
- `PluginLoader` — manifest scanning + validation
- `PluginAPI` — `anoclaw` object factory
- `PluginToolProxy` — Tool subclass for plugin tools
- `ExtensionPoints` — kernel override registry
- `PluginStorage` — KV file storage
- `ToolRegistry` — tool registration
- `PromptAssembler` / `MemoryManager` / `SessionStore` / `SettingsManager` — ExtensionPoints injection
- `ApiServer` — internal API + plugin route registration
- `WsServer` — broadcast + UI mount
- `TypedEventBus` — kernel event forwarding to plugins
- `SessionManager` — active session notification

## Constraints

- One Worker per plugin — no shared Worker pools
- Tool execution timeout: 30 seconds (both main and worker side)
- Activate timeout: 15 seconds
- RPC timeout: 30 seconds
- Result truncation: 50,000 chars max (prevents OOM)
- LLM result truncation: 50,000 chars
- Path traversal blocked for `fs.*` operations
- Workspace-scoped file access only
- TypeScript plugins compiled via esbuild (Node 20 target, ESM)
- Plugin crash does not affect other plugins or the platform
