// BrowserAgentTool.ts — Controls the built-in browser in the Workspace page.
// Talks directly to Electron WebContentsView through BrowserViewManager.
// No CDP, no Playwright, no external Chrome needed.

import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

// BrowserViewManager lives in the Electron main process, accessible via dynamic import.
let _bvm: any = null;
let _firstTabCreated = false;

function getBVM(): any {
  if (!_bvm) {
    // In Electron main process, this is available
    const { BrowserViewManager } = require('../../../../electron/BrowserViewManager.js');
    _bvm = BrowserViewManager.getInstance();
  }
  return _bvm;
}

/** Resolve or ensure a browser view exists. Returns viewId. */
function getOrCreateViewId(url?: string): string {
  const bvm = getBVM();
  if (bvm.count() > 0) {
    // Newest view acts as the active one
    const latest = bvm.latest();
    if (latest) return latest.id;
  }
  // No views exist — create one
  const url_ = url || 'about:blank';
  const viewId = bvm.create(url_);
  _firstTabCreated = true;
  return viewId;
}

export class BrowserAgentTool extends Tool {
  static category = 'Browser';

  name(): string { return 'Browser'; }

  description(): string {
    return `Control the built-in browser that lives in the Workspace page. The browser works like a normal web browser: you can open pages, click links, fill forms, scroll, take screenshots, and read text.

## How the browser works
- The browser tab is visible in the Workspace page — the user can see what you do.
- **navigate**: On the FIRST call, a new browser tab is created automatically. Subsequent calls reuse the same tab (loadURL).
- **list_tabs**: Shows all open browser tabs with IDs.
- **close_tabs**: Close tabs by index from list_tabs.
- The active page for all actions is always the most recently created tab.

## Actions
- navigate(url)         — Go to a URL. First call creates a tab, later calls reuse it.
- click(selector)       — Click an element (CSS selector).
- fill(selector, value) — Type text into an input.
- screenshot            — Take a JPEG screenshot (displayed as an image in chat).
- execute_js(value)     — Run JavaScript in the page. Returns JSON.
- get_text(selector?)   — Read text. Without selector, reads the full body.
- scroll(scroll_amount) — Scroll the page. Positive = down, negative = up.
- back / forward / reload — Browser navigation.
- wait(wait_ms, selector?) — Wait ms or for a selector to appear.
- list_tabs             — Show all open browser pages with index and URL.
- close_tabs(value)     — Close tabs by index. value = "0,2,4" (comma-separated indices).`;
  }

  parametersSchema() {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['navigate','click','fill','screenshot','execute_js','get_text','scroll','back','forward','reload','wait','list_tabs','close_tabs'],
          description: 'Action to perform.',
        },
        url:        { type: 'string',  description: 'URL to navigate to.' },
        selector:   { type: 'string',  description: 'CSS selector for click / fill / wait.' },
        value:      { type: 'string',  description: 'Text to fill, JS code to execute, or tab indices to close (e.g. "1,2,4").' },
        scroll_amount: { type: 'number', description: 'Pixels to scroll. Default 500.' },
        wait_ms:    { type: 'number', description: 'Milliseconds. Default 1000.' },
      },
      required: ['action'],
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Medium; }
  isReadOnly(): boolean { return false; }
  isConcurrencySafe(): boolean { return false; }
  interruptBehavior(): InterruptBehavior { return InterruptBehavior.Cancel; }
  outputLimit(): number { return 1_000_000; }

  async execute(params: Record<string, unknown>, _ctx: ExecutionContext): Promise<ToolResult> {
    const t0 = Date.now();
    try {
      const result = await this._run(params.action as string, params);
      return this.makeResult(result, { startedAt: t0, finishedAt: Date.now() });
    } catch (e: any) {
      return this.makeError(e.message || String(e), { startedAt: t0 });
    }
  }

  private async _run(action: string, p: Record<string, unknown>): Promise<string> {
    const bvm = getBVM();

    // ── Tab management ──
    if (action === 'list_tabs') {
      const entries = bvm.allEntries();
      if (!entries.length) return 'No open browser pages.';
      return entries.map((e: any, i: number) => `[${i}] ${e.title || '(no title)'} — ${e.url}`).join('\n');
    }

    if (action === 'close_tabs') {
      const raw = (p.value as string) || '';
      const indices = raw.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      if (!indices.length) throw new Error('value required: comma-separated tab indices from list_tabs (e.g. "0,2,4")');
      const entries = bvm.allEntries();
      let closed = 0;
      for (const idx of indices) {
        if (idx >= 0 && idx < entries.length) {
          if (bvm.destroy(entries[idx].id)) closed++;
        }
      }
      return `Closed ${closed} tab(s).`;
    }

    // ── navigate ──
    if (action === 'navigate') {
      const url = ensureUrl(p.url as string);
      const viewId = getOrCreateViewId(url);
      if (!_firstTabCreated) {
        _firstTabCreated = true;
        // Tab already navigated to url in getOrCreateViewId
      } else {
        bvm.navigate(viewId, url);
        await bvm.waitForLoad(viewId, 5000);
      }
      return `Navigated to: ${bvm.getUrl(viewId)}\nTitle: ${bvm.getTitle(viewId)}`;
    }

    // ── Everything else needs an active view ──
    const viewId = getOrCreateViewId();
    const bvm_ = bvm; // alias

    switch (action) {

      case 'click': {
        const sel = p.selector as string;
        if (!sel) throw new Error('selector required');
        await bvm_.waitForSelector(viewId, sel, 10000);
        await bvm_.execJs(viewId,
          `(function(){
            var el = document.querySelector(${JSON.stringify(sel)});
            if (!el) throw new Error('Element not found: ${sel}');
            el.scrollIntoView({block:'center'});
            el.click();
          })()`
        );
        return `Clicked: ${sel}`;
      }

      case 'fill': {
        const sel = p.selector as string;
        const val = p.value as string;
        if (!sel) throw new Error('selector required');
        if (val === undefined) throw new Error('value required');
        await bvm_.waitForSelector(viewId, sel, 10000);
        await bvm_.execJs(viewId,
          `(function(){
            var el = document.querySelector(${JSON.stringify(sel)});
            if (!el) throw new Error('Element not found: ${sel}');
            el.focus();
            el.value = ${JSON.stringify(val)};
            el.dispatchEvent(new Event('input', {bubbles:true}));
            el.dispatchEvent(new Event('change', {bubbles:true}));
          })()`
        );
        return `Filled "${sel}" with "${val}"`;
      }

      case 'screenshot': {
        const dataUrl = await bvm_.screenshot(viewId);
        return `[Browser Screenshot]\n<img src="${dataUrl}" style="max-width:100%;border-radius:6px;">`;
      }

      case 'execute_js': {
        const code = p.value as string;
        if (!code) throw new Error('value required');
        const raw = await bvm_.execJs(viewId, code);
        const result = raw === undefined ? null : raw;
        let output: string;
        try { output = JSON.stringify(result, null, 2); } catch { output = String(result); }
        return output.substring(0, 5000);
      }

      case 'get_text': {
        const sel = p.selector as string;
        if (sel) {
          const text = await bvm_.execJs(viewId,
            `(function(){var e=document.querySelector(${JSON.stringify(sel)});return e?e.textContent||'':'';})()`
          );
          return text ? text.trim().substring(0, 10000) : `No text for "${sel}"`;
        }
        const body = await bvm_.execJs(viewId, 'document.body?document.body.innerText:""');
        return (body || '').replace(/\s+/g, ' ').trim().substring(0, 10000);
      }

      case 'scroll': {
        const amt = (p.scroll_amount as number) || 500;
        await bvm_.execJs(viewId, `window.scrollBy(0,${amt})`);
        return `Scrolled ${amt > 0 ? 'down' : 'up'} ${Math.abs(amt)}px`;
      }

      case 'back':
        bvm_.goBack(viewId);
        return `Back → ${bvm_.getUrl(viewId)}`;

      case 'forward':
        bvm_.goForward(viewId);
        return `Forward → ${bvm_.getUrl(viewId)}`;

      case 'reload':
        bvm_.reload(viewId);
        return `Reloaded: ${bvm_.getUrl(viewId)}`;

      case 'wait': {
        const ms = (p.wait_ms as number) || 1000;
        const sel = p.selector as string;
        if (sel) {
          await bvm_.waitForSelector(viewId, sel, Math.max(ms, 30000));
          return `"${sel}" appeared.`;
        }
        await new Promise(r => setTimeout(r, ms));
        return `Waited ${ms}ms`;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }
}

function ensureUrl(u: string): string {
  if (!u) throw new Error('url required');
  return u.startsWith('http://') || u.startsWith('https://') ? u : 'https://' + u;
}
