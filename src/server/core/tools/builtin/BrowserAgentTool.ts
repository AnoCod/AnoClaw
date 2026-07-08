// BrowserAgentTool.ts - Controls the built-in browser in the Workspace page.
// Talks directly to Electron WebContentsView through BrowserViewManager.
// No CDP, no Playwright, no external Chrome needed.

import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

// BrowserViewManager lives in the Electron main process, accessible via dynamic import.
let _bvm: any = null;
const _viewBySession = new Map<string, string>();
const DEFAULT_WAIT_MS = 1000;
const MIN_WAIT_MS = 1;
const MAX_WAIT_MS = 30000;
const DEFAULT_SCROLL_AMOUNT = 500;
const MIN_SCROLL_AMOUNT = -50000;
const MAX_SCROLL_AMOUNT = 50000;
const DEFAULT_INSPECT_ITEMS = 80;
const DEFAULT_FIND_ITEMS = 30;
const MAX_INSPECT_ITEMS = 200;

export const BROWSER_ACTIONS = [
  'navigate',
  'click',
  'fill',
  'screenshot',
  'inspect',
  'find',
  'hover',
  'select',
  'press',
  'dispatch_event',
  'execute_js',
  'get_text',
  'scroll',
  'back',
  'forward',
  'reload',
  'wait',
  'list_tabs',
  'close_tabs',
] as const;

async function getBVM(): Promise<any> {
  if (!_bvm) {
    const { BrowserViewManager } = await import('../../../../electron/BrowserViewManager.js');
    _bvm = BrowserViewManager.getInstance();
  }
  return _bvm;
}

/** Resolve or ensure the session-bound browser view exists. */
async function getOrCreateViewId(sessionId: string, url?: string): Promise<string> {
  const bvm = await getBVM();
  const existing = _viewBySession.get(sessionId);
  if (existing && bvm.get(existing)) return existing;

  const viewId = bvm.create(url || 'about:blank');
  _viewBySession.set(sessionId, viewId);
  return viewId;
}

function isFirstTabForSession(sessionId: string): boolean {
  return !_viewBySession.get(sessionId);
}

function previewValue(value: unknown, max = 140): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? text.slice(0, max - 1) + '...' : text;
}

function asBoundedInt(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

export function normalizeBrowserWaitMs(value: unknown): number {
  return asBoundedInt(value, DEFAULT_WAIT_MS, MIN_WAIT_MS, MAX_WAIT_MS, 'wait_ms');
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('Browser action cancelled by user');
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error('Browser action cancelled by user'));
    };
    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function browserJsonScript(source: string): string {
  return `(function(){${source}})()`;
}

export function buildDomSnapshotScript(selector?: string, maxItems = 80): string {
  const limit = Math.max(1, Math.min(200, Math.floor(maxItems)));
  return browserJsonScript(`
    const rootSelector = ${JSON.stringify(selector || '')};
    const maxItems = ${limit};
    const root = rootSelector ? document.querySelector(rootSelector) : document;
    if (!root) throw new Error('Element not found: ' + rootSelector);

    function clean(text, max) {
      return String(text || '').replace(/\\s+/g, ' ').trim().slice(0, max);
    }
    function visible(el) {
      if (!el || !el.getBoundingClientRect) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    function selectorFor(el) {
      if (!el || el.nodeType !== 1) return '';
      if (el.id) return '#' + CSS.escape(el.id);
      const stableAttrs = ['data-testid', 'data-test', 'data-cy', 'aria-label', 'name', 'title', 'placeholder'];
      for (const attr of stableAttrs) {
        const value = el.getAttribute(attr);
        if (value) return el.tagName.toLowerCase() + '[' + attr + '=' + JSON.stringify(value) + ']';
      }
      const parts = [];
      let current = el;
      while (current && current.nodeType === 1 && current !== document.body && parts.length < 5) {
        let part = current.tagName.toLowerCase();
        const cls = Array.from(current.classList || []).filter(Boolean).slice(0, 2);
        if (cls.length) part += '.' + cls.map(c => CSS.escape(c)).join('.');
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(n => n.tagName === current.tagName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
        }
        parts.unshift(part);
        current = parent;
      }
      return parts.join(' > ');
    }
    function roleFor(el) {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button' || type === 'button' || type === 'submit') return 'button';
      if (tag === 'select') return 'select';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') return type || 'input';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      return tag;
    }
    function summary(el) {
      const rect = el.getBoundingClientRect();
      return {
        selector: selectorFor(el),
        tag: el.tagName.toLowerCase(),
        role: roleFor(el),
        text: clean(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '', 180),
        href: el.href || undefined,
        name: el.getAttribute('name') || undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        value: (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') ? String(el.value || '').slice(0, 120) : undefined,
        visible: visible(el),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      };
    }

    const scope = root === document ? document.body || document.documentElement : root;
    const headings = Array.from(scope.querySelectorAll('h1,h2,h3')).filter(visible).slice(0, maxItems).map(summary);
    const links = Array.from(scope.querySelectorAll('a[href]')).filter(visible).slice(0, maxItems).map(summary);
    const interactive = Array.from(scope.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])'))
      .filter(visible).slice(0, maxItems).map(summary);
    const forms = Array.from(scope.querySelectorAll('form')).slice(0, Math.min(20, maxItems)).map(form => ({
      selector: selectorFor(form),
      text: clean(form.innerText || '', 220),
      controls: Array.from(form.querySelectorAll('input,textarea,select,button')).filter(visible).slice(0, 30).map(summary),
    }));

    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      root: rootSelector || 'document',
      viewport: { width: innerWidth, height: innerHeight },
      scroll: {
        x: Math.round(scrollX),
        y: Math.round(scrollY),
        maxY: Math.max(0, Math.round(document.documentElement.scrollHeight - innerHeight)),
      },
      counts: {
        links: scope.querySelectorAll('a[href]').length,
        buttons: scope.querySelectorAll('button,[role="button"]').length,
        inputs: scope.querySelectorAll('input,textarea,select').length,
        forms: scope.querySelectorAll('form').length,
      },
      textPreview: clean(scope.innerText || scope.textContent || '', 1500),
      headings,
      links,
      interactive,
      forms,
    };
  `);
}

export function buildFindElementsScript(query: string, maxItems = 30): string {
  const limit = Math.max(1, Math.min(100, Math.floor(maxItems)));
  return browserJsonScript(`
    const needle = ${JSON.stringify(query || '')}.toLowerCase();
    const maxItems = ${limit};
    if (!needle) throw new Error('value required: text to find');
    function clean(text, max) { return String(text || '').replace(/\\s+/g, ' ').trim().slice(0, max); }
    function visible(el) {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }
    function selectorFor(el) {
      if (el.id) return '#' + CSS.escape(el.id);
      for (const attr of ['data-testid', 'data-test', 'aria-label', 'name', 'placeholder', 'title']) {
        const value = el.getAttribute(attr);
        if (value) return el.tagName.toLowerCase() + '[' + attr + '=' + JSON.stringify(value) + ']';
      }
      const parts = [];
      let current = el;
      while (current && current.nodeType === 1 && current !== document.body && parts.length < 5) {
        let part = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(n => n.tagName === current.tagName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
        }
        parts.unshift(part);
        current = parent;
      }
      return parts.join(' > ');
    }
    const candidates = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[aria-label],[placeholder],[title],h1,h2,h3,p,span,div'))
      .filter(visible)
      .map(el => {
        const haystack = clean([
          el.innerText,
          el.textContent,
          el.value,
          el.getAttribute('aria-label'),
          el.getAttribute('placeholder'),
          el.getAttribute('title'),
          el.getAttribute('href'),
        ].filter(Boolean).join(' '), 500);
        return { el, haystack };
      })
      .filter(item => item.haystack.toLowerCase().includes(needle))
      .slice(0, maxItems)
      .map(item => {
        const rect = item.el.getBoundingClientRect();
        return {
          selector: selectorFor(item.el),
          tag: item.el.tagName.toLowerCase(),
          role: item.el.getAttribute('role') || '',
          text: clean(item.haystack, 180),
          href: item.el.href || undefined,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        };
      });
    return { query: needle, count: candidates.length, matches: candidates };
  `);
}

async function emitBrowserEvent(
  sessionId: string,
  viewId: string,
  action: string,
  phase: 'start' | 'done' | 'error',
  params: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    const bvm = await getBVM();
    bvm.emitAgentBrowserEvent?.({
      sessionId,
      viewId,
      action,
      phase,
      url: (params.url as string) || bvm.getUrl?.(viewId) || undefined,
      selector: params.selector as string | undefined,
      valuePreview: previewValue(params.value),
      timestamp: Date.now(),
      ...extra,
    });
  } catch {
    // Browser tracing is observational and must not break tool execution.
  }
}

export class BrowserAgentTool extends Tool {
  static category = 'Browser';

  name(): string { return 'Browser'; }

  description(): string {
    return `Control the built-in browser that lives in the Workspace page. The browser works like a normal web browser: you can open pages, click links, fill forms, scroll, take screenshots, and read text.

## How the browser works
- The browser tab is visible in the Workspace page, and the user can see what you do.
- Browser actions automatically open the Workspace page and show an action trace above the page.
- **navigate**: On the FIRST call for this session, a browser tab is created automatically. Subsequent calls reuse the same session tab.
- **list_tabs**: Shows all open browser tabs with IDs.
- **close_tabs**: Close tabs by index from list_tabs.

## Actions
- navigate(url)         - Go to a URL. First call creates a tab, later calls reuse it.
- click(selector)       - Click an element (CSS selector).
- fill(selector, value) - Type text into an input.
- screenshot            - Take a JPEG screenshot (displayed as an image in chat).
- inspect(selector?)    - Return a compact DOM/viewport snapshot: title, URL, headings, links, forms, inputs, buttons, scroll state. Use this before guessing selectors.
- find(value)           - Find visible elements by text, aria-label, placeholder, title, href, or value and return usable selector candidates.
- hover(selector)       - Move pointer intent over an element by dispatching hover/mouseover events.
- select(selector,value)- Set a select box value and dispatch input/change.
- press(key)            - Send a keyboard key to the active page element.
- dispatch_event(selector,event_type) - Dispatch a DOM event such as input, change, submit, keydown, or click.
- execute_js(value)     - Run JavaScript in the page. Returns JSON.
- get_text(selector?)   - Read text. Without selector, reads the full body.
- scroll(scroll_amount) - Scroll the page. Positive = down, negative = up.
- back / forward / reload - Browser navigation.
- wait(wait_ms, selector?) - Wait ms or for a selector to appear.
- list_tabs             - Show all open browser pages with index and URL.
- close_tabs(value)     - Close tabs by index. value = "0,2,4" (comma-separated indices).`;
  }

  parametersSchema() {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: BROWSER_ACTIONS,
          description: 'Action to perform.',
        },
        url:        { type: 'string',  description: 'URL to navigate to.' },
        selector:   { type: 'string',  description: 'CSS selector for click / fill / inspect / hover / select / wait / dispatch_event.' },
        value:      { type: 'string',  description: 'Text to fill, JS code to execute, select value, element search text, or tab indices to close (e.g. "1,2,4").' },
        key:        { type: 'string',  description: 'Keyboard key for press, e.g. "Enter", "Tab", "Escape", "ArrowDown", or "a".' },
        event_type: { type: 'string',  description: 'DOM event type for dispatch_event. Examples: click, input, change, submit, keydown, keyup.' },
        include_screenshot: { type: 'boolean', description: 'When action="inspect", append a page screenshot after the DOM snapshot.' },
        max_items:  { type: 'integer', minimum: 1, maximum: MAX_INSPECT_ITEMS, description: `Max elements returned by inspect/find. Default ${DEFAULT_INSPECT_ITEMS} for inspect, ${DEFAULT_FIND_ITEMS} for find. Max ${MAX_INSPECT_ITEMS}.` },
        scroll_amount: { type: 'integer', minimum: MIN_SCROLL_AMOUNT, maximum: MAX_SCROLL_AMOUNT, description: `Pixels to scroll. Default ${DEFAULT_SCROLL_AMOUNT}. Range ${MIN_SCROLL_AMOUNT} to ${MAX_SCROLL_AMOUNT}.` },
        wait_ms:    { type: 'integer', minimum: MIN_WAIT_MS, maximum: MAX_WAIT_MS, description: `Milliseconds to wait. Default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS}.` },
      },
      required: ['action'],
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Medium; }
  isReadOnly(): boolean { return false; }
  isConcurrencySafe(): boolean { return false; }
  interruptBehavior(): InterruptBehavior { return InterruptBehavior.Cancel; }
  outputLimit(): number { return 1_000_000; }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const t0 = Date.now();
    try {
      const result = await this._run(params.action as string, params, ctx.sessionId, ctx.signal);
      return this.makeResult(result, { startedAt: t0, finishedAt: Date.now() });
    } catch (e: any) {
      return this.makeError(e.message || String(e), { startedAt: t0 });
    }
  }

  private async _run(action: string, p: Record<string, unknown>, sessionId: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) {
      throw new Error('Browser action cancelled by user');
    }
    if (!process.versions.electron) {
      throw new Error('Browser control is only available in the Electron desktop app, not in CLI mode.');
    }
    const bvm = await getBVM();

    if (action === 'list_tabs') {
      const entries = bvm.allEntries();
      if (!entries.length) return 'No open browser pages.';
      return entries.map((e: any, i: number) => `[${i}] ${e.title || '(no title)'} - ${e.url}`).join('\n');
    }

    if (action === 'close_tabs') {
      const raw = (p.value as string) || '';
      const indices = raw.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      if (!indices.length) throw new Error('value required: comma-separated tab indices from list_tabs (e.g. "0,2,4")');
      const entries = bvm.allEntries();
      let closed = 0;
      for (const idx of indices) {
        if (idx >= 0 && idx < entries.length) {
          if (bvm.destroy(entries[idx].id)) {
            for (const [sid, viewId] of _viewBySession.entries()) {
              if (viewId === entries[idx].id) _viewBySession.delete(sid);
            }
            closed++;
          }
        }
      }
      return `Closed ${closed} tab(s).`;
    }

    if (action === 'navigate') {
      const url = ensureUrl(p.url as string);
      const firstTab = isFirstTabForSession(sessionId);
      const viewId = await getOrCreateViewId(sessionId, url);
      await emitBrowserEvent(sessionId, viewId, action, 'start', { ...p, url });
      if (firstTab) {
        await bvm.waitForLoad(viewId, 5000);
      } else {
        bvm.navigate(viewId, url);
        await bvm.waitForLoad(viewId, 5000);
      }
      const result = `Navigated to: ${bvm.getUrl(viewId)}\nTitle: ${bvm.getTitle(viewId)}`;
      await emitBrowserEvent(sessionId, viewId, action, 'done', { ...p, url }, { url: bvm.getUrl(viewId), resultPreview: result });
      return result;
    }

    const viewId = await getOrCreateViewId(sessionId);
    await emitBrowserEvent(sessionId, viewId, action, 'start', p);

    try {
      let result: string;
      switch (action) {
        case 'click': {
          const sel = p.selector as string;
          if (!sel) throw new Error('selector required');
          await bvm.waitForSelector(viewId, sel, 10000);
          await bvm.execJs(viewId,
            `(function(){
              var el = document.querySelector(${JSON.stringify(sel)});
              if (!el) throw new Error('Element not found: ${sel}');
              el.scrollIntoView({block:'center'});
              ['pointerover','mouseover','pointermove','mousemove','pointerdown','mousedown','pointerup','mouseup'].forEach(function(type){
                el.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window}));
              });
              el.click();
            })()`
          );
          result = `Clicked: ${sel}`;
          break;
        }

        case 'fill': {
          const sel = p.selector as string;
          const val = p.value as string;
          if (!sel) throw new Error('selector required');
          if (val === undefined) throw new Error('value required');
          await bvm.waitForSelector(viewId, sel, 10000);
          await bvm.execJs(viewId,
            `(function(){
              var el = document.querySelector(${JSON.stringify(sel)});
              if (!el) throw new Error('Element not found: ${sel}');
              el.focus();
              if (el.isContentEditable) {
                el.textContent = ${JSON.stringify(val)};
              } else {
                el.value = ${JSON.stringify(val)};
              }
              el.dispatchEvent(new Event('input', {bubbles:true}));
              el.dispatchEvent(new Event('change', {bubbles:true}));
            })()`
          );
          result = `Filled "${sel}" with "${val}"`;
          break;
        }

        case 'screenshot': {
          const dataUrl = await bvm.screenshot(viewId);
          result = `[Browser Screenshot]\n<img src="${dataUrl}" style="max-width:100%;border-radius:6px;">`;
          break;
        }

        case 'inspect': {
          const sel = p.selector as string | undefined;
          const maxItems = asBoundedInt(p.max_items, DEFAULT_INSPECT_ITEMS, 1, MAX_INSPECT_ITEMS, 'max_items');
          const snapshot = await bvm.execJs(viewId, buildDomSnapshotScript(sel, maxItems));
          result = JSON.stringify(snapshot, null, 2).substring(0, 30000);
          if (p.include_screenshot === true) {
            const dataUrl = await bvm.screenshot(viewId);
            result += `\n\n[Browser Screenshot]\n<img src="${dataUrl}" style="max-width:100%;border-radius:6px;">`;
          }
          break;
        }

        case 'find': {
          const text = p.value as string;
          if (!text) throw new Error('value required: text to find');
          const maxItems = asBoundedInt(p.max_items, DEFAULT_FIND_ITEMS, 1, MAX_INSPECT_ITEMS, 'max_items');
          const matches = await bvm.execJs(viewId, buildFindElementsScript(text, maxItems));
          result = JSON.stringify(matches, null, 2).substring(0, 20000);
          break;
        }

        case 'hover': {
          const sel = p.selector as string;
          if (!sel) throw new Error('selector required');
          await bvm.waitForSelector(viewId, sel, 10000);
          await bvm.execJs(viewId,
            `(function(){
              var el = document.querySelector(${JSON.stringify(sel)});
              if (!el) throw new Error('Element not found: ${sel}');
              el.scrollIntoView({block:'center'});
              ['pointerover','mouseover','pointermove','mousemove'].forEach(function(type){
                el.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window}));
              });
            })()`
          );
          result = `Hovered: ${sel}`;
          break;
        }

        case 'select': {
          const sel = p.selector as string;
          const val = p.value as string;
          if (!sel) throw new Error('selector required');
          if (val === undefined) throw new Error('value required');
          await bvm.waitForSelector(viewId, sel, 10000);
          await bvm.execJs(viewId,
            `(function(){
              var el = document.querySelector(${JSON.stringify(sel)});
              if (!el) throw new Error('Element not found: ${sel}');
              el.focus();
              el.value = ${JSON.stringify(val)};
              el.dispatchEvent(new Event('input', {bubbles:true}));
              el.dispatchEvent(new Event('change', {bubbles:true}));
            })()`
          );
          result = `Selected "${val}" in ${sel}`;
          break;
        }

        case 'press': {
          const key = (p.key as string) || (p.value as string);
          if (!key) throw new Error('key required');
          if (typeof bvm.sendInputEvent === 'function') {
            bvm.sendInputEvent(viewId, { type: 'keyDown', keyCode: key });
            bvm.sendInputEvent(viewId, { type: 'keyUp', keyCode: key });
          } else {
            await bvm.execJs(viewId,
              `(function(){
                var target = document.activeElement || document.body;
                target.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true}));
                target.dispatchEvent(new KeyboardEvent('keyup',{key:${JSON.stringify(key)},bubbles:true,cancelable:true}));
              })()`
            );
          }
          result = `Pressed key: ${key}`;
          break;
        }

        case 'dispatch_event': {
          const sel = p.selector as string;
          const eventType = (p.event_type as string) || (p.value as string);
          if (!sel) throw new Error('selector required');
          if (!eventType) throw new Error('event_type required');
          await bvm.waitForSelector(viewId, sel, 10000);
          await bvm.execJs(viewId,
            `(function(){
              var el = document.querySelector(${JSON.stringify(sel)});
              if (!el) throw new Error('Element not found: ${sel}');
              var type = ${JSON.stringify(eventType)};
              if (/^key/.test(type)) {
                el.dispatchEvent(new KeyboardEvent(type,{key:${JSON.stringify((p.key as string) || '')},bubbles:true,cancelable:true}));
              } else if (/^(click|mouse|pointer)/.test(type)) {
                el.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window}));
              } else {
                el.dispatchEvent(new Event(type,{bubbles:true,cancelable:true}));
              }
            })()`
          );
          result = `Dispatched "${eventType}" on ${sel}`;
          break;
        }

        case 'execute_js': {
          const code = p.value as string;
          if (!code) throw new Error('value required');
          const raw = await bvm.execJs(viewId, code);
          const jsResult = raw === undefined ? null : raw;
          let output: string;
          try { output = JSON.stringify(jsResult, null, 2); } catch { output = String(jsResult); }
          result = output.substring(0, 5000);
          break;
        }

        case 'get_text': {
          const sel = p.selector as string;
          if (sel) {
            const text = await bvm.execJs(viewId,
              `(function(){var e=document.querySelector(${JSON.stringify(sel)});return e?e.textContent||'':'';})()`
            );
            result = text ? text.trim().substring(0, 10000) : `No text for "${sel}"`;
            break;
          }
          const body = await bvm.execJs(viewId, 'document.body?document.body.innerText:""');
          result = (body || '').replace(/\s+/g, ' ').trim().substring(0, 10000);
          break;
        }

        case 'scroll': {
          const amt = asBoundedInt(p.scroll_amount, DEFAULT_SCROLL_AMOUNT, MIN_SCROLL_AMOUNT, MAX_SCROLL_AMOUNT, 'scroll_amount');
          await bvm.execJs(viewId, `window.scrollBy(0,${amt})`);
          result = `Scrolled ${amt > 0 ? 'down' : 'up'} ${Math.abs(amt)}px`;
          break;
        }

        case 'back':
          bvm.goBack(viewId);
          result = `Back -> ${bvm.getUrl(viewId)}`;
          break;

        case 'forward':
          bvm.goForward(viewId);
          result = `Forward -> ${bvm.getUrl(viewId)}`;
          break;

        case 'reload':
          bvm.reload(viewId);
          result = `Reloaded: ${bvm.getUrl(viewId)}`;
          break;

        case 'wait': {
          const ms = normalizeBrowserWaitMs(p.wait_ms);
          const sel = p.selector as string;
          if (sel) {
            await bvm.waitForSelector(viewId, sel, ms);
            result = `"${sel}" appeared.`;
            break;
          }
          await abortableDelay(ms, signal);
          result = `Waited ${ms}ms`;
          break;
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      await emitBrowserEvent(sessionId, viewId, action, 'done', p, { url: bvm.getUrl(viewId), resultPreview: previewValue(result, 180) });
      return result;
    } catch (e: any) {
      await emitBrowserEvent(sessionId, viewId, action, 'error', p, { url: bvm.getUrl(viewId), error: e.message || String(e) });
      throw e;
    }
  }
}

function ensureUrl(u: string): string {
  if (!u) throw new Error('url required');
  return u.startsWith('http://') || u.startsWith('https://') ? u : 'https://' + u;
}
