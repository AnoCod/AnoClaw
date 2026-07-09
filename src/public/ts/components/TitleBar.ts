// AnoClaw Frontend — Cinema Title Bar
// 28px top status bar: page name, page switcher menu, connection dot.
// Replaces old titlebar + NavigationDock combination.

import { WSConnectionState } from '../viewmodel/WSClient.js';
import { slotRegistry } from '../SlotRegistry.js';

interface PageEntry {
  page: string;
  label: string;
}

const KERNEL_PAGES: PageEntry[] = [
  { page: 'workspace', label: 'Workspace' },
  { page: 'agents', label: 'Agents' },
  { page: 'skills', label: 'Skills' },
  { page: 'memory', label: 'Memory' },
  { page: 'settings', label: 'Settings' },
];

const PAGE_TONES: Record<string, string> = {
  workspace: 'workspace',
  agents: 'agents',
  skills: 'skills',
  memory: 'memory',
  settings: 'settings',
  plugins: 'plugins',
};

const SVG_WIN_MINIMIZE = `<svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;
const SVG_WIN_MAXIMIZE = `<svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
const SVG_WIN_RESTORE = `<svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8V5h11v11h-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><rect x="5" y="8" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
const SVG_WIN_CLOSE = `<svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;

/**
 * Cinema topbar: page name + PAGES dropdown (left), [titlebar-left slot], status dot,
 * [titlebar-right slot], and window control buttons (minimize/maximize/close).
 *
 * PAGES dropdown merges KERNEL_PAGES (sessions, agents, skills, memory, settings) with
 * pluginContributed pages injected via setPluginPages(). A divider separates kernel from plugins.
 * Clicking a menu item dispatches a 'navigate-to' CustomEvent handled by App.
 */
export class TitleBar {
  readonly element: HTMLElement;
  private _statusDot: HTMLElement;
  private _pageNameEl: HTMLElement;
  private _switcherMenu: HTMLElement | null = null;
  private _switcherAnchor: HTMLElement;
  private _pluginPages: PageEntry[] = [];
  private _currentPage = 'workspace';

  constructor() {
    this.element = this._build();
    this._statusDot = this.element.querySelector('.connection-status-dot') as HTMLElement;
    this._pageNameEl = this.element.querySelector('.topbar-page-name') as HTMLElement;
    this._switcherAnchor = this.element.querySelector('.topbar-page-switcher') as HTMLElement;
    this._listenFloatingBall();
  }

  /** Listen for floating ball actions from the main process. */
  private _listenFloatingBall(): void {
    const api = (window as any).electronAPI;
    if (api?.onFloatingBallNewSession) {
      api.onFloatingBallNewSession(() => {
        window.dispatchEvent(new CustomEvent('navigate-to', { detail: { page: 'sessions' } }));
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('floating-ball-new-session'));
        }, 100);
      });
    }
    if (api?.onFloatingBallOpenSession) {
      api.onFloatingBallOpenSession((payload: unknown) => {
        window.dispatchEvent(new CustomEvent('navigate-to', { detail: { page: 'sessions' } }));
        const detail = typeof payload === 'object' && payload !== null
          ? payload
          : { index: typeof payload === 'number' ? payload : undefined };
        window.dispatchEvent(new CustomEvent('floating-ball-open-session', { detail }));
      });
    }
  }

  /** Update the status dot color + pulse animation based on WS connection state. */
  setConnectionState(state: WSConnectionState): void {
    if (!this._statusDot) return;
    const colors: Record<WSConnectionState, string> = {
      [WSConnectionState.Connected]: 'var(--color-success)',
      [WSConnectionState.Connecting]: 'var(--color-warning)',
      [WSConnectionState.Disconnected]: 'var(--color-error)',
    };
    this._statusDot.style.backgroundColor = colors[state];
    if (state === WSConnectionState.Connecting) {
      this._statusDot.classList.add('pulse');
    } else {
      this._statusDot.classList.remove('pulse');
    }
  }

  setPageName(name: string): void {
    this._currentPage = name;
    if (this._pageNameEl) {
      this._pageNameEl.textContent = this._labelForPage(name);
    }
    if (this._switcherMenu) this._syncActiveSwitcherItem();
  }

  /** Set dynamic plugin-contributed pages */
  setPluginPages(pages: Array<{ page: string; label: string }>): void {
    this._pluginPages = pages;
    if (this._pageNameEl) this._pageNameEl.textContent = this._labelForPage(this._currentPage);
    if (this._switcherMenu) {
      this._closeSwitcher();
    }
  }

  /** Build the full topbar DOM tree with all child elements and event listeners. */
  private _build(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'topbar-cinema';

    const pageGroup = document.createElement('div');
    pageGroup.className = 'topbar-page-group';

    const nameEl = document.createElement('span');
    nameEl.className = 'topbar-page-name';
    nameEl.textContent = 'SESSIONS';
    pageGroup.appendChild(nameEl);

    const switcherBtn = document.createElement('button');
    switcherBtn.className = 'topbar-page-switcher';
    switcherBtn.setAttribute('aria-label', 'Open pages menu');
    switcherBtn.innerHTML = '<span>Pages</span><span class="topbar-page-switcher-chevron" aria-hidden="true"></span>';
    switcherBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._togglePageSwitcher(switcherBtn);
    });
    pageGroup.appendChild(switcherBtn);

    el.appendChild(pageGroup);

    // Slot: titlebar-left — after page name
    const leftSlot = document.createElement('div');
    leftSlot.setAttribute('data-slot', 'titlebar-left');
    leftSlot.style.cssText = 'display:flex;align-items:center;gap:8px;margin-left:8px;min-width:0;flex:1 1 auto;overflow:hidden;-webkit-app-region:no-drag;';
    el.appendChild(leftSlot);
    slotRegistry._onSlotReady('titlebar-left');

    const statusGroup = document.createElement('div');
    statusGroup.className = 'topbar-status';

    const dot = document.createElement('span');
    dot.className = 'connection-status-dot';
    dot.title = 'No active session';
    statusGroup.appendChild(dot);

    el.appendChild(statusGroup);

    // Slot: titlebar-right — before window controls
    const rightSlot = document.createElement('div');
    rightSlot.setAttribute('data-slot', 'titlebar-right');
    rightSlot.style.cssText = 'display:flex;align-items:center;gap:6px;margin-right:8px;-webkit-app-region:no-drag;';
    el.appendChild(rightSlot);
    slotRegistry._onSlotReady('titlebar-right');

    // Window controls (Electron frameless)
    const winControls = document.createElement('div');
    winControls.className = 'win-controls';

    const makeBtn = (cls: string, icon: string, title: string, handler: () => void): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.className = `win-btn ${cls}`;
      btn.innerHTML = icon;
      btn.title = title;
      btn.addEventListener('click', handler);
      winControls.appendChild(btn);
      return btn;
    };

    makeBtn('win-minimize', SVG_WIN_MINIMIZE, 'Minimize', () => {
      (window as any).electronAPI?.windowMinimizeAnimate();
    });
    const maxBtn = makeBtn('win-maximize', SVG_WIN_MAXIMIZE, 'Maximize', () => (window as any).electronAPI?.windowMaximize());
    makeBtn('win-close', SVG_WIN_CLOSE, 'Close', () => (window as any).electronAPI?.windowClose());

    // Listen for maximize/unmaximize from Electron main process to toggle button icon
    const api = (window as any).electronAPI;
    if (api?.onMaximizeChange) {
      api.onMaximizeChange((maximized: boolean) => {
        maxBtn.innerHTML = maximized ? SVG_WIN_RESTORE : SVG_WIN_MAXIMIZE;
        maxBtn.title = maximized ? 'Restore' : 'Maximize';
      });
    }

    el.appendChild(winControls);

    return el;
  }

  /** Open/close the PAGES dropdown below the switcher button, anchored to its right edge. */
  private _togglePageSwitcher(anchor: HTMLElement): void {
    if (this._switcherMenu) {
      this._closeSwitcher();
      return;
    }
    this._switcherMenu = document.createElement('div');
    this._switcherMenu.className = 'page-switcher-menu';
    this._switcherMenu.setAttribute('role', 'menu');

    this._appendSwitcherSection('Core', KERNEL_PAGES);
    if (this._pluginPages.length > 0) {
      const divider = document.createElement('div');
      divider.className = 'page-switcher-divider';
      this._switcherMenu.appendChild(divider);
      this._appendSwitcherSection('Plugins', this._pluginPages);
    }

    this._syncActiveSwitcherItem();

    document.body.appendChild(this._switcherMenu);

    // Position below the button, right-aligned to button edge
    const rect = anchor.getBoundingClientRect();
    this._switcherMenu.style.position = 'fixed';
    this._switcherMenu.style.top = `${rect.bottom + 5}px`;
    // Clamp right edge within viewport (min 196px menu width)
    const rightVal = window.innerWidth - rect.right;
    this._switcherMenu.style.right = `${Math.max(6, Math.min(rightVal, window.innerWidth - 196))}px`;
    this._switcherMenu.style.left = 'auto';

    // Defer listener registration to avoid immediately capturing the opening click
    setTimeout(() => {
      document.addEventListener('click', this._onOutsideClick);
    }, 0);
  }

  private _appendSwitcherSection(label: string, pages: PageEntry[]): void {
    if (!this._switcherMenu || pages.length === 0) return;
    const heading = document.createElement('div');
    heading.className = 'page-switcher-section';
    heading.textContent = label;
    this._switcherMenu.appendChild(heading);

    for (const p of pages) {
      const item = document.createElement('button');
      item.className = 'page-switcher-item';
      item.setAttribute('role', 'menuitem');
      item.dataset.page = p.page;
      item.dataset.tone = PAGE_TONES[p.page] || 'plugin';
      item.innerHTML = `<span class="page-switcher-dot" aria-hidden="true"></span><span class="page-switcher-label"></span>`;
      const labelEl = item.querySelector('.page-switcher-label') as HTMLElement;
      labelEl.textContent = p.label;
      item.addEventListener('click', () => {
        this._closeSwitcher();
        window.dispatchEvent(new CustomEvent('navigate-to', { detail: { page: p.page } }));
      });
      this._switcherMenu.appendChild(item);
    }
  }

  private _syncActiveSwitcherItem(): void {
    if (!this._switcherMenu) return;
    this._switcherMenu.querySelectorAll<HTMLElement>('.page-switcher-item').forEach((item) => {
      item.classList.toggle('active', item.dataset.page === this._currentPage);
    });
  }

  private _labelForPage(page: string): string {
    return [...KERNEL_PAGES, ...this._pluginPages].find((entry) => entry.page === page)?.label || page;
  }

  private _closeSwitcher(): void {
    if (this._switcherMenu) {
      this._switcherMenu.remove();
      this._switcherMenu = null;
    }
    document.removeEventListener('click', this._onOutsideClick);
  }

  private _onOutsideClick = (): void => {
    this._closeSwitcher();
  };
}
