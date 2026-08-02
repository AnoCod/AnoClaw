import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../../i18n/index.js';

const appHarness = vi.hoisted(() => ({
  current: null as {
    settings: {
      lang: 'zh-CN' | 'en-US';
      showThinkCards: boolean;
      showToolCards: boolean;
      theme: 'dark' | 'light';
      accentColor: string;
      compactionThreshold: number;
    };
    updateSettings: ReturnType<typeof vi.fn>;
  } | null,
}));

vi.mock('../../../app.js', () => ({
  App: {
    getInstance: () => appHarness.current,
  },
}));

vi.mock('../../../ClientLogger.js', () => ({
  ClientLogger: {
    ui: {
      info: vi.fn(),
      error: vi.fn(),
    },
  },
}));

vi.mock('../../../ToastManager.js', () => ({
  ToastManager: {
    getInstance: () => ({ success: vi.fn() }),
  },
}));

vi.mock('../../ConfirmDialog.js', () => ({
  ConfirmDialog: {
    show: vi.fn(),
  },
}));

vi.mock('../../../SlotRegistry.js', () => ({
  slotRegistry: {
    _onSlotReady: vi.fn(),
  },
}));

vi.mock('../../ui/Toggle.js', () => ({
  Toggle: class {
    readonly element = document.createElement('div');
    checked: boolean;

    constructor(config: { checked?: boolean } = {}) {
      this.checked = config.checked ?? false;
    }
  },
}));

type EventListenerLike = (event: {
  currentTarget: FakeElement;
  target: FakeElement;
  preventDefault(): void;
  stopPropagation(): void;
}) => void;

class FakeClassList {
  constructor(private readonly owner: FakeElement) {}

  add(...tokens: string[]): void {
    const next = new Set(this.owner.className.split(/\s+/).filter(Boolean));
    tokens.forEach((token) => next.add(token));
    this.owner.className = [...next].join(' ');
  }

  remove(...tokens: string[]): void {
    const removed = new Set(tokens);
    this.owner.className = this.owner.className
      .split(/\s+/)
      .filter((token) => token && !removed.has(token))
      .join(' ');
  }

  toggle(token: string, force?: boolean): boolean {
    const present = this.owner.className.split(/\s+/).includes(token);
    const enabled = force ?? !present;
    if (enabled) this.add(token);
    else this.remove(token);
    return enabled;
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, EventListenerLike[]>();
  readonly classList = new FakeClassList(this);
  readonly dataset: Record<string, string> = {};
  readonly style = {
    display: '',
    setProperty: vi.fn(),
    removeProperty: vi.fn(),
  };
  parentElement: FakeElement | null = null;
  className = '';
  id = '';
  name = '';
  value = '';
  type = '';
  textContent = '';
  private _html = '';
  private readonly attributes = new Map<string, string>();
  private readonly virtualElements = new Map<string, FakeElement>();

  constructor(readonly tagName: string) {}

  set innerHTML(value: string) {
    this._html = value;
    this.children.splice(0);
    this.virtualElements.clear();

    if (value.includes('id="settings-form"')) {
      const form = new FakeElement('form');
      form.id = 'settings-form';
      this.appendChild(form);
      this.virtualElements.set('#settings-form', form);
    }

    const selectMatch = value.match(/<select[^>]*name="lang"[^>]*>([\s\S]*?)<\/select>/);
    if (selectMatch) {
      const select = new FakeElement('select');
      select.name = 'lang';
      const selected = selectMatch[1].match(/<option[^>]*value="([^"]+)"[^>]*selected/);
      select.value = selected?.[1] || '';
      this.appendChild(select);
      this.virtualElements.set('select[name="lang"]', select);
      this.virtualElements.set('[name="lang"]', select);
    }

    const rangeMatch = value.match(/<input[^>]*name="compactionThreshold"[^>]*value="([^"]+)"/);
    if (rangeMatch) {
      const range = new FakeElement('input');
      range.name = 'compactionThreshold';
      range.value = rangeMatch[1];
      this.appendChild(range);
      this.virtualElements.set('[name="compactionThreshold"]', range);
    }

    for (const id of [
      'toggle-think',
      'toggle-tool',
      'appearance-theme',
      'appearance-accent',
      'btn-export',
      'btn-clear',
    ]) {
      if (!value.includes(`id="${id}"`)) continue;
      const element = new FakeElement(id.startsWith('btn-') ? 'button' : 'span');
      element.id = id;
      this.appendChild(element);
      this.virtualElements.set(`#${id}`, element);
    }
  }

  get innerHTML(): string {
    return this._html;
  }

  appendChild<T extends FakeElement>(child: T): T {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  replaceWith(replacement: FakeElement): void {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index < 0) return;
    replacement.parentElement = this.parentElement;
    this.parentElement.children.splice(index, 1, replacement);
    this.parentElement = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'id') this.id = value;
    if (name === 'name') this.name = value;
    if (name.startsWith('data-')) {
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase())] = value;
    }
  }

  addEventListener(type: string, listener: EventListenerLike): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string): void {
    const event = {
      currentTarget: this,
      target: this,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  querySelector<T extends FakeElement = FakeElement>(selector: string): T | null {
    const virtual = this.virtualElements.get(selector);
    if (virtual) return virtual as T;
    for (const child of this.children) {
      if (child.matches(selector)) return child as T;
      const nested = child.querySelector<T>(selector);
      if (nested) return nested;
    }
    return null;
  }

  querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
    const matches: T[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) matches.push(child as T);
      matches.push(...child.querySelectorAll<T>(selector));
    }
    return matches;
  }

  private matches(selector: string): boolean {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    return selector === this.tagName;
  }
}

class FakeDocument {
  readonly body = new FakeElement('body');
  readonly documentElement = new FakeElement('html');

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

describe('SettingsPage locale switching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: new FakeDocument(),
    });
    setLocale('zh-CN');

    const settings = {
      lang: 'zh-CN' as const,
      showThinkCards: true,
      showToolCards: true,
      theme: 'dark' as const,
      accentColor: '#0b8ce9',
      compactionThreshold: 70,
    };
    const updateSettings = vi.fn((patch: { lang?: 'zh-CN' | 'en-US' }) => {
      Object.assign(settings, patch);
      if (patch.lang) setLocale(patch.lang);
    });
    appHarness.current = { settings, updateSettings };
  });

  afterEach(() => {
    setLocale('zh-CN');
    appHarness.current = null;
  });

  it('applies a changed language immediately and rebuilds the visible form', async () => {
    const { SettingsPage } = await import('../SettingsPage.js');
    const page = new SettingsPage();
    page.container.style.display = '';
    page.onEnter();

    const form = page.container.querySelector('#settings-form') as unknown as FakeElement;
    expect(form.innerHTML).toContain('界面语言');
    expect(form.innerHTML).not.toContain('Interface language');

    const select = form.querySelector('select[name="lang"]') as FakeElement;
    const threshold = form.querySelector('[name="compactionThreshold"]') as FakeElement;
    threshold.value = '85';
    threshold.dispatch('input');
    select.value = 'en-US';
    select.dispatch('change');

    expect(appHarness.current?.updateSettings).toHaveBeenCalledWith({ lang: 'en-US' });
    expect(form.innerHTML).toContain('Interface language');
    expect(form.innerHTML).not.toContain('界面语言');
    expect(form.querySelector('select[name="lang"]')?.value).toBe('en-US');
    expect(form.querySelector('[name="compactionThreshold"]')?.value).toBe('85');
    expect(appHarness.current?.settings.compactionThreshold).toBe(70);

    page.container.style.display = 'none';
  });
});
