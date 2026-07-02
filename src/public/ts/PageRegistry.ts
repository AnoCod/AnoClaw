// AnoClaw Frontend — Page Registry
// Manages page registration and navigation. Each page has a container element,
// onEnter/onExit lifecycle hooks. Only one page visible at a time.
// Uses display:none/block for reliable layout isolation between pages,
// with a simple opacity fade-in for the active page.

import type { Page } from './types.js';
import { ClientLogger } from './ClientLogger.js';

class PageRegistry {
  private _pages: Map<string, Page> = new Map();
  private _currentPage: string | null = null;

  register(page: Page): void {
    if (this._pages.has(page.name)) {
      ClientLogger.app.warn('Page already registered, overwriting', { page: page.name });
    }
    this._pages.set(page.name, page);
    // Start hidden — removed from flow entirely so no layout interference
    page.container.style.display = 'none';
    page.container.setAttribute('data-page', page.name);
  }

  navigateTo(name: string): void {
    const page = this._pages.get(name);
    if (!page) {
      ClientLogger.app.error('Page not found', { page: name });
      return;
    }

    if (this._currentPage === name) return;

    // Exit current page
    if (this._currentPage) {
      const current = this._pages.get(this._currentPage);
      if (current) {
        current.container.style.display = 'none';
        current.container.style.opacity = '';
        current.container.style.pointerEvents = '';
        try { current.onExit(); } catch (e) {
          ClientLogger.app.error('Page onExit error', { page: this._currentPage, error: (e as Error).message });
        }
      }
    }

    // Enter new page with Raycast-style fade + lift
    page.container.style.display = '';
    // Finish any lingering animations to prevent stacking
    page.container.getAnimations().forEach(a => a.finish());
    page.container.classList.add('page-enter');

    try { page.onEnter(); } catch (e) {
      ClientLogger.app.error('Page onEnter error', { page: name, error: (e as Error).message });
    }

    this._currentPage = name;
    // Dispatch navigation event for dock updates
    window.dispatchEvent(new CustomEvent('page-navigated', { detail: { page: name } }));
  }

  get currentPage(): string | null {
    return this._currentPage;
  }

  getPage(name: string): Page | undefined {
    return this._pages.get(name);
  }

  getAllPages(): Page[] {
    const result: Page[] = [];
    this._pages.forEach((p) => result.push(p));
    return result;
  }
}

export const pageRegistry = new PageRegistry();
