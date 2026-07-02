// PluginsPage.ts — Plugin management in cinema design.
// Lists plugins with status, toggle, reload, uninstall. Uses cinema CSS variables.

import { PluginViewModel } from '../../viewmodel/PluginViewModel.js';
import type { Page, PluginInfo } from '../../types.js';

const SVG_PLUGIN = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2l9 4.5v11L12 22l-9-4.5v-11L12 2z"/><rect x="8" y="10" width="8" height="8" rx="1.5"/></svg>`;
const SVG_TOGGLE_ON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a11 11 0 110 22 11 11 0 010-22z"/><circle cx="12" cy="12" r="5"/></svg>`;
const SVG_TOGGLE_OFF = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="11"/><circle cx="12" cy="12" r="3"/></svg>`;
const SVG_RELOAD = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 4v6h6"/><path d="M1.5 12.5a10 10 0 0016 4.5M23 20v-6h-6"/><path d="M22.5 11.5a10 10 0 00-16-4.5"/></svg>`;
const SVG_TRASH = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>`;

export class PluginsPage implements Page {
  readonly name = 'plugins';
  readonly container: HTMLElement;
  private _vm: PluginViewModel;

  constructor(vm: PluginViewModel) {
    this._vm = vm;
    this.container = document.createElement('div');
    this.container.className = 'cinema-static-page';
    this.container.setAttribute('data-page', 'plugins');
    this.container.style.display = 'none';
  }

  onEnter(): void {
    console.log('[Plugins] onEnter — loading plugins');
    this._render();
    this._vm.load().then(() => this._render());
    this._vm.on('pluginsChanged', this._onChange);
  }

  onExit(): void {
    this._vm.off('pluginsChanged', this._onChange);
  }

  private _onChange = (): void => { this._render(); };

  private _render(): void {
    console.log('[Plugins] render count:', this._vm.plugins.length);
    const plugins = this._vm.plugins;
    const activatedCount = plugins.filter(p => p.status === 'activated').length;
    const errorCount = plugins.filter(p => p.status === 'error').length;

    this.container.innerHTML = `
      <div class="cinema-static-inner">
        <div class="cinema-section">
          <div class="cinema-section-legend">Extensions</div>
          <div class="cinema-section-desc">
            ${plugins.length} installed &middot; ${activatedCount} active${errorCount > 0 ? ` &middot; ${errorCount} error` : ''}
          </div>
        </div>
        ${plugins.length === 0 ? `
          <div class="plugins-empty-state">
            <span class="plugins-empty-icon">${SVG_PLUGIN}</span>
            <span class="plugins-empty-text">No plugins installed</span>
            <span class="plugins-empty-hint">Place plugins in the <code>plugins/</code> directory</span>
          </div>
        ` : `
          <div class="plugins-grid">
            ${plugins.map(p => this._renderCard(p)).join('')}
          </div>
        `}
      </div>
    `;

    this._bindButtons();
  }

  private _renderCard(p: PluginInfo): string {
    const isActive = p.status === 'activated';
    const isError = p.status === 'error';
    const statusDot = isActive
      ? '<span class="plg-status-dot active"></span>'
      : isError
        ? '<span class="plg-status-dot error"></span>'
        : '<span class="plg-status-dot"></span>';

    const desc = p.description || `Plugin: ${p.name}`;
    const toolCount = p.contributes?.tools?.length || 0;
    const pageCount = p.contributes?.pages?.length || 0;

    let meta = `v${this._esc(p.version)}`;
    if (toolCount > 0) meta += ` &middot; ${toolCount} tool${toolCount > 1 ? 's' : ''}`;
    if (pageCount > 0) meta += ` &middot; ${pageCount} page${pageCount > 1 ? 's' : ''}`;

    return `
      <div class="plg-card" data-plugin="${this._esc(p.name)}">
        <div class="plg-card-top">
          <div class="plg-card-left">
            <div class="plg-card-name">
              ${statusDot}
              <span>${this._esc(p.displayName)}</span>
              <span class="plg-card-publisher">${this._esc(p.publisher || '')}</span>
            </div>
            <div class="plg-card-desc">${this._esc(desc)}</div>
            <div class="plg-card-meta">${meta}</div>
          </div>
          <div class="plg-card-actions">
            <button class="plg-btn plg-btn-toggle" data-action="toggle" data-plugin="${this._esc(p.name)}" title="${isActive ? 'Deactivate' : 'Activate'}">
              ${isActive ? SVG_TOGGLE_ON : SVG_TOGGLE_OFF}
            </button>
            <button class="plg-btn plg-btn-reload" data-action="reload" data-plugin="${this._esc(p.name)}" title="Reload">
              ${SVG_RELOAD}
            </button>
            <button class="plg-btn plg-btn-delete" data-action="uninstall" data-plugin="${this._esc(p.name)}" title="Uninstall">
              ${SVG_TRASH}
            </button>
          </div>
        </div>
        ${p.errorMessage ? `<div class="plg-card-error">${this._esc(p.errorMessage)}</div>` : ''}
      </div>
    `;
  }

  private _bindButtons(): void {
    this.container.querySelectorAll('.plg-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const el = btn as HTMLButtonElement;
        const action = el.dataset.action;
        const name = el.dataset.plugin;
        if (!name || !action) return;

        el.classList.add('busy');
        el.disabled = true;

        try {
          switch (action) {
            case 'toggle':
              await this._vm.togglePlugin(name);
              break;
            case 'reload':
              await this._vm.reloadPlugin(name);
              break;
            case 'uninstall':
              if (confirm(`Uninstall plugin "${name}"? This moves it to a .disabled directory.`)) {
                await this._vm.uninstallPlugin(name);
              }
              break;
          }
        } catch (err) {
          console.error(`[PluginsPage] ${action} failed for ${name}:`, err);
        } finally {
          // VM.load() will re-render via pluginsChanged event
          el.classList.remove('busy');
          el.disabled = false;
        }
      });
    });
  }

  private _esc(s: string): string {
    const el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }
}
