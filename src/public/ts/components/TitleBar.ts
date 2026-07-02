// AnoClaw Frontend — Cinema Title Bar
// 28px top status bar: page name, connection dot, page switcher menu.
// Replaces old titlebar + NavigationDock combination.

import { WSConnectionState } from '../viewmodel/WSClient.js';

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

/**
 * Cinema topbar: page name label (left), [titlebar-left slot], status dot + PAGES dropdown (right),
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
      api.onFloatingBallOpenSession((sessionIdx: number) => {
        window.dispatchEvent(new CustomEvent('navigate-to', { detail: { page: 'sessions' } }));
        window.dispatchEvent(new CustomEvent('floating-ball-open-session', { detail: { index: sessionIdx } }));
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
    if (this._pageNameEl) {
      this._pageNameEl.textContent = name;
    }
  }

  /** Set dynamic plugin-contributed pages */
  setPluginPages(pages: Array<{ page: string; label: string }>): void {
    this._pluginPages = pages;
    if (this._switcherMenu) {
      this._closeSwitcher();
    }
  }

  /** Build the full topbar DOM tree with all child elements and event listeners. */
  private _build(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'topbar-cinema';

    const nameEl = document.createElement('span');
    nameEl.className = 'topbar-page-name';
    nameEl.textContent = 'SESSIONS';
    el.appendChild(nameEl);

    // Slot: titlebar-left — after page name
    const leftSlot = document.createElement('div');
    leftSlot.setAttribute('data-slot', 'titlebar-left');
    leftSlot.style.cssText = 'display:flex;align-items:center;gap:8px;margin-left:12px;-webkit-app-region:no-drag;';
    el.appendChild(leftSlot);

    const statusGroup = document.createElement('div');
    statusGroup.className = 'topbar-status';

    const dot = document.createElement('span');
    dot.className = 'connection-status-dot';
    dot.title = 'No active session';
    statusGroup.appendChild(dot);

    const switcherBtn = document.createElement('button');
    switcherBtn.className = 'topbar-page-switcher';
    switcherBtn.textContent = 'PAGES';
    switcherBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._togglePageSwitcher(switcherBtn);
    });
    statusGroup.appendChild(switcherBtn);
    el.appendChild(statusGroup);

    // Slot: titlebar-right — before window controls
    const rightSlot = document.createElement('div');
    rightSlot.setAttribute('data-slot', 'titlebar-right');
    rightSlot.style.cssText = 'display:flex;align-items:center;gap:6px;margin-right:8px;-webkit-app-region:no-drag;';
    el.appendChild(rightSlot);

    // Window controls (Electron frameless)
    const winControls = document.createElement('div');
    winControls.className = 'win-controls';

    const makeBtn = (cls: string, label: string, title: string, handler: () => void): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.className = `win-btn ${cls}`;
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener('click', handler);
      winControls.appendChild(btn);
      return btn;
    };

    makeBtn('win-minimize', '─', '最小化', () => {
      (window as any).electronAPI?.windowMinimizeAnimate();
    });
    const maxBtn = makeBtn('win-maximize', '□', '最大化', () => (window as any).electronAPI?.windowMaximize());
    makeBtn('win-close', '×', '关闭', () => (window as any).electronAPI?.windowClose());

    // Listen for maximize/unmaximize from Electron main process to toggle button icon
    const api = (window as any).electronAPI;
    if (api?.onMaximizeChange) {
      api.onMaximizeChange((maximized: boolean) => {
        maxBtn.textContent = maximized ? '⊗' : '□';
        maxBtn.title = maximized ? '还原' : '最大化';
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

    // Merge kernel pages + plugin pages, insert divider between the two groups
    const allPages = [...KERNEL_PAGES, ...this._pluginPages];

    let isKernel = true;
    for (const p of allPages) {
      // First plugin page → insert separator divider
      if (isKernel && this._pluginPages.length > 0 && p === this._pluginPages[0]) {
        isKernel = false;
        const divider = document.createElement('div');
        divider.className = 'page-switcher-divider';
        this._switcherMenu!.appendChild(divider);
      }

      const item = document.createElement('button');
      item.className = 'page-switcher-item';
      item.setAttribute('role', 'menuitem');
      item.textContent = p.label;
      item.addEventListener('click', () => {
        this._closeSwitcher();
        window.dispatchEvent(new CustomEvent('navigate-to', { detail: { page: p.page } }));
      });
      this._switcherMenu!.appendChild(item);
    }

    document.body.appendChild(this._switcherMenu);

    // Position below the button, right-aligned to button edge
    const rect = anchor.getBoundingClientRect();
    this._switcherMenu.style.position = 'fixed';
    this._switcherMenu.style.top = `${rect.bottom + 4}px`;
    // Clamp right edge within viewport (min 168px menu width)
    const rightVal = window.innerWidth - rect.right;
    this._switcherMenu.style.right = `${Math.max(4, Math.min(rightVal, window.innerWidth - 168))}px`;
    this._switcherMenu.style.left = 'auto';

    // Defer listener registration to avoid immediately capturing the opening click
    setTimeout(() => {
      document.addEventListener('click', this._onOutsideClick);
    }, 0);
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
