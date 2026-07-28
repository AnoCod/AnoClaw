import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../../i18n/index.js';

const pageHarness = vi.hoisted(() => ({
  sseOn: vi.fn(),
}));

vi.mock('../../../app.js', () => ({
  App: {
    getInstance: () => ({
      sseClient: { on: pageHarness.sseOn },
    }),
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

vi.mock('../../ConfirmDialog.js', () => ({
  ConfirmDialog: {
    show: vi.fn(),
  },
}));

vi.mock('../../ui/Button.js', () => ({
  Button: class {
    readonly element = document.createElement('button');

    constructor(config: { label?: string } = {}) {
      this.label = config.label || '';
    }

    get label(): string {
      return this.element.textContent || '';
    }

    set label(value: string) {
      this.element.textContent = value;
    }
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

vi.mock('../../ui/Dialog.js', () => ({
  Dialog: class {
    readonly element = document.createElement('div');
    close = vi.fn();
  },
}));

vi.mock('../../ui/FormField.js', () => ({
  FormField: class {
    readonly element = document.createElement('label');
  },
}));

class FakeClassList {
  constructor(private readonly owner: FakePageElement) {}

  add(...tokens: string[]): void {
    const classes = new Set(this.owner.className.split(/\s+/).filter(Boolean));
    tokens.forEach((token) => classes.add(token));
    this.owner.className = [...classes].join(' ');
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

class FakePageElement {
  readonly children: FakePageElement[] = [];
  readonly classList = new FakeClassList(this);
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string | ((...args: unknown[]) => void)> = {
    display: '',
    cssText: '',
    gridColumn: '',
    color: '',
    backgroundColor: '',
    setProperty: vi.fn(),
    removeProperty: vi.fn(),
  };
  parentElement: FakePageElement | null = null;
  className = '';
  id = '';
  type = '';
  value = '';
  placeholder = '';
  textContent = '';
  selected = false;
  rows = 0;
  onclick: (() => void) | null = null;
  private _html = '';
  private readonly listeners = new Map<string, Array<() => void>>();
  private readonly attributes = new Map<string, string>();

  constructor(readonly tagName: string) {}

  set innerHTML(value: string) {
    this._html = value;
    this.children.splice(0);
    const wrapper = value.match(/id="(skills-inner|memory-inner)"/);
    if (wrapper) {
      const inner = new FakePageElement('div');
      inner.id = wrapper[1];
      this.appendChild(inner);
    }
  }

  get innerHTML(): string {
    return this._html;
  }

  appendChild<T extends FakePageElement>(child: T): T {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'id') this.id = value;
    if (name.startsWith('data-')) {
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase())] = value;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  querySelector<T extends FakePageElement = FakePageElement>(selector: string): T | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child as T;
      const nested = child.querySelector<T>(selector);
      if (nested) return nested;
    }
    return null;
  }

  querySelectorAll<T extends FakePageElement = FakePageElement>(selector: string): T[] {
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

class FakePageDocument {
  readonly body = new FakePageElement('body');
  readonly documentElement = new FakePageElement('html');

  createElement(tagName: string): FakePageElement {
    return new FakePageElement(tagName);
  }
}

describe('localized core pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: new FakePageDocument(),
    });
    setLocale('zh-CN');
  });

  afterEach(() => {
    setLocale('zh-CN');
  });

  it('replaces Skills and Memory static, empty, and status text at runtime', async () => {
    const [{ SkillsPage }, { MemoryPage }] = await Promise.all([
      import('../SkillsPage.js'),
      import('../MemoryPage.js'),
    ]);
    const skills = new SkillsPage();
    const memory = new MemoryPage();

    (skills as unknown as { _skills: unknown[]; _renderGrid(): void })._skills = [{
      id: 'test-skill',
      name: 'test-skill',
      description: '',
      content: '',
      enabled: false,
    }];
    (skills as unknown as { _renderGrid(): void })._renderGrid();
    (memory as unknown as { _renderGrid(): void })._renderGrid();

    const skillsRoot = skills.container as unknown as FakePageElement;
    const memoryRoot = memory.container as unknown as FakePageElement;
    expect(skillsRoot.querySelector('.skills-kicker')?.textContent).toBe('技能');
    expect(skillsRoot.querySelector('.skill-row-status')?.textContent).toBe('已禁用');
    expect(skillsRoot.querySelector('.skills-map-status')?.textContent).toBe('1 个已禁用');
    expect(memoryRoot.querySelector('.mem-header-title')?.textContent).toBe('记忆');
    expect(memoryRoot.querySelector('.ui-empty-title')?.textContent).toBe('没有找到记忆条目。');
    expect(memoryRoot.querySelectorAll('.mem-type-tab').map((tab) => tab.textContent)).toContain('全部');

    setLocale('en-US');

    expect(skillsRoot.querySelector('.skills-kicker')?.textContent).toBe('Skills');
    expect(skillsRoot.querySelector('.skill-row-status')?.textContent).toBe('Disabled');
    expect(skillsRoot.querySelector('.skills-map-status')?.textContent).toBe('1 disabled');
    expect(skillsRoot.querySelector('.skills-kicker')?.textContent).not.toBe('技能');
    expect(memoryRoot.querySelector('.mem-header-title')?.textContent).toBe('Memory');
    expect(memoryRoot.querySelector('.ui-empty-title')?.textContent).toBe('No memory entries found.');
    expect(memoryRoot.querySelectorAll('.mem-type-tab').map((tab) => tab.textContent)).toContain('All');
    expect(memoryRoot.querySelectorAll('.mem-type-tab').map((tab) => tab.textContent)).not.toContain('全部');
  });
});
