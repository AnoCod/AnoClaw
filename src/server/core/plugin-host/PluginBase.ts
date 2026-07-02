// PluginBase.ts — Base class for class-style plugins.
// Inspired by Obsidian's Plugin base class. Plugins extend this instead of
// exporting bare functions. Both styles coexist — PluginHost detects which
// style the module uses at activation time.
//
// Usage:
//   import { PluginBase } from './PluginBase.js';
//   export default class MyPlugin extends PluginBase {
//     async onload() {
//       this.registerTool({ name: 'myTool', ... });
//       this.onEvent('memory:saved', this._onMemorySaved);
//       await this.loadData();
//     }
//     async onToolExecute(name, params, ctx) { ... }
//     async onunload() { ... }
//   }

import type { AnoClawAPI, PluginToolDefinition } from './PluginAPI.js';

export abstract class PluginBase {
  /** The raw anoclaw API — always available for direct calls. */
  readonly api: AnoClawAPI;

  /** Plugin name from manifest. */
  get name(): string { return this.api.context.pluginName; }

  /** Plugin storage path — guaranteed writable directory. */
  get storagePath(): string { return this.api.context.storagePath; }

  /** Plugin root path on disk. */
  get pluginPath(): string { return this.api.context.pluginPath; }

  private _disposables: Array<{ dispose(): void }> = [];
  private _toolNames: string[] = [];
  private _loadedData: Record<string, unknown> | null = null;

  constructor(api: AnoClawAPI) {
    this.api = api;
  }

  // ── Lifecycle (override these) ────────────────────────────────

  /** Called when the plugin is loaded. Register tools, routes, events here. */
  async onload(): Promise<void> {}

  /** Called when the plugin is unloaded. Clean up resources. */
  async onunload(): Promise<void> {}

  // ── Tool execution (override this) ─────────────────────────────

  /** Called when an AI agent invokes a tool registered by this plugin.
   *  Return a string result. Throw on error. */
  async onToolExecute(toolName: string, params: Record<string, unknown>, ctx: { sessionId: string; agentId: string; workspace: string } | null): Promise<string> {
    throw new Error(`Tool "${toolName}" not handled by ${this.name}. Override onToolExecute().`);
  }

  // ── Register API ───────────────────────────────────────────────

  /** Register a tool that AI agents can call. */
  async registerTool(def: PluginToolDefinition): Promise<void> {
    await this.api.tools.register(def);
    this._toolNames.push(def.name);
  }

  /** Add a frontend page to the app navigation. */
  addPage(id: string, title: string, htmlPath?: string, order?: number): void {
    // Page registration happens through the manifest contributes.pages.
    // This is a convenience — plugin.json still declares pages, but now
    // plugins can also register them programmatically.
    const contribution = {
      id,
      title,
      html: htmlPath || 'frontend/index.html',
      order: order || 100,
    };
    this.api.routes.register([
      { method: 'GET', path: `/pages/${id}`, handler: 'servePage' }
    ]).catch(() => {});
    this._log(`page registered: ${id}`);
  }

  /** Subscribe to a kernel event. Auto-unsubscribes on unload. */
  onEvent(event: string, handler: (data: unknown) => void): void {
    this.api.events.on(event, handler);
    this._disposables.push({
      dispose: () => this.api.events.off(event, handler),
    });
  }

  /** Inject content into the agent system prompt. */
  async injectPrompt(name: string, content: string, priority?: number): Promise<void> {
    await this.api.prompt.inject(name, content, priority);
    this._disposables.push({
      dispose: () => { this.api.prompt.inject(name, '').catch(() => {}); },
    });
  }

  /** Register an HTTP route handled by this plugin. */
  async registerRoute(method: string, path: string, handler: string): Promise<void> {
    await this.api.routes.register([{ method, path, handler }]);
  }

  // ── Persistent data (backed by memory system) ──────────────────

  /** Load persisted plugin data. Call in onload(). */
  async loadData(): Promise<Record<string, unknown>> {
    if (this._loadedData) return this._loadedData;
    try {
      const results = await this.api.memory.search(this.name, { scope: 'team', limit: 1 });
      if (results.length > 0) {
        const raw = (results[0] as any).content;
        this._loadedData = typeof raw === 'string' ? JSON.parse(raw) : raw || {};
      }
    } catch {}
    if (!this._loadedData) this._loadedData = {};
    return this._loadedData!;
  }

  /** Save persisted plugin data. */
  async saveData(data?: Record<string, unknown>): Promise<void> {
    const toSave = data || this._loadedData || {};
    this._loadedData = toSave;
    await this.api.memory.save({
      name: this.name,
      type: 'reference',
      description: `${this.name} persisted data`,
      content: JSON.stringify(toSave),
      scope: 'team',
    });
  }

  // ── Internal ────────────────────────────────────────────────────

  /** Called by PluginHost to activate. Don't override — override onload() instead. */
  async _activate(): Promise<Array<{ dispose(): void }>> {
    await this.onload();
    this._log('activated');
    return [{
      dispose: async () => {
        await this.onunload();
        for (const d of [...this._disposables].reverse()) {
          try { d.dispose(); } catch {}
        }
        this._disposables = [];
        this._log('deactivated');
      },
    }];
  }

  private _log(msg: string): void {
    this.api.log.info(msg);
  }
}
