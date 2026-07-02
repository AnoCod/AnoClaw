// PluginViewModel.ts — Fetches plugin list and page contributions from API.
// Used by TitleBar to dynamically add plugin pages to navigation.
// Supports reload, activate, deactivate, and uninstall operations.

import { EventEmitter } from '../EventEmitter.js';
import type { PluginInfo, PluginPageContribution } from '../types.js';

export class PluginViewModel extends EventEmitter {
  private _plugins: PluginInfo[] = [];
  private _contributions: PluginPageContribution[] = [];

  async load(): Promise<void> {
    try {
      const resp = await fetch('/api/v1/plugins');
      const data = await resp.json() as { plugins: PluginInfo[] };
      this._plugins = data.plugins || [];
      this._extractContributions();
      this.emit('pluginsChanged', this._plugins);
    } catch {
      this._plugins = [];
      this._contributions = [];
    }
  }

  get plugins(): PluginInfo[] { return this._plugins; }

  /** Returns page contributions from activated plugins */
  get pageContributions(): PluginPageContribution[] { return this._contributions; }

  /** Extract page contributions from plugin manifest data */
  private _extractContributions(): void {
    this._contributions = [];

    for (const p of this._plugins) {
      if (p.status !== 'activated') continue;

      const pages = p.contributes?.pages;
      if (!pages || pages.length === 0) continue;

      for (const pageDef of pages) {
        let htmlPath = pageDef.html || `/plugins/${p.name}/frontend/index.html`;
        // Prepend plugin path if relative
        if (!htmlPath.startsWith('/') && !htmlPath.startsWith('http')) {
          htmlPath = `/plugins/${p.name}/${htmlPath}`;
        }
        this._contributions.push({
          id: pageDef.id,
          title: pageDef.title || p.displayName,
          order: pageDef.order || 99,
          pluginName: p.name,
          htmlPath,
        });
      }
    }
  }

  async reloadPlugin(name: string): Promise<void> {
    await fetch('/api/v1/plugins/reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await this.load();
  }

  async togglePlugin(name: string): Promise<void> {
    const p = this._plugins.find(pl => pl.name === name);
    if (!p) return;

    const action = p.status === 'activated' ? 'deactivate' : 'activate';
    await fetch('/api/v1/plugins/reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, action }),
    });
    await this.load();
  }

  async uninstallPlugin(name: string): Promise<void> {
    await fetch(`/api/v1/plugins/${encodeURIComponent(name)}`, { method: 'DELETE' });
    await this.load();
  }
}
