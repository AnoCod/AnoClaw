import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeDomEvent {
  defaultPrevented = false;
  propagationStopped = false;

  constructor(
    readonly type: string,
    readonly target: FakeElement,
    readonly key?: string,
  ) {}

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

class FakeElement {
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  parentElement: FakeElement | null = null;
  textContent = '';
  title = '';
  type = '';
  private _className = '';
  private readonly listeners = new Map<string, Set<(event: FakeDomEvent) => void>>();

  readonly classList = {
    add: (...tokens: string[]) => {
      const next = new Set(this._tokens());
      for (const token of tokens) next.add(token);
      this._className = Array.from(next).join(' ');
    },
    remove: (...tokens: string[]) => {
      const next = new Set(this._tokens());
      for (const token of tokens) next.delete(token);
      this._className = Array.from(next).join(' ');
    },
    toggle: (token: string, force?: boolean) => {
      const next = new Set(this._tokens());
      const shouldAdd = force ?? !next.has(token);
      if (shouldAdd) next.add(token);
      else next.delete(token);
      this._className = Array.from(next).join(' ');
      return shouldAdd;
    },
    contains: (token: string) => this._tokens().includes(token),
  };

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get className(): string {
    return this._className;
  }

  set className(value: string) {
    this._className = value;
  }

  set innerHTML(value: string) {
    if (value === '') {
      for (const child of this.children) child.parentElement = null;
      this.children.length = 0;
    }
  }

  appendChild<T extends FakeElement>(child: T): T {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  contains(node: FakeElement): boolean {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }

  addEventListener(type: string, listener: (event: FakeDomEvent) => void): void {
    const bucket = this.listeners.get(type) || new Set();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: (event: FakeDomEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: FakeDomEvent): boolean {
    const bucket = this.listeners.get(event.type);
    if (bucket) {
      for (const listener of Array.from(bucket)) listener(event);
    }
    return !event.defaultPrevented;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  focus(): void {}

  getBoundingClientRect(): DOMRect {
    const isDropdown = this.classList.contains('mode-dropdown');
    return {
      left: 40,
      top: 500,
      width: isDropdown ? 260 : 110,
      height: isDropdown ? 260 : 32,
      right: isDropdown ? 300 : 150,
      bottom: isDropdown ? 760 : 532,
      x: 40,
      y: 500,
      toJSON: () => ({}),
    } as DOMRect;
  }

  private _tokens(): string[] {
    return this._className.split(/\s+/).filter(Boolean);
  }
}

class FakeDocument {
  readonly body = new FakeElement('body');
  private readonly listeners = new Map<string, Set<(event: FakeDomEvent) => void>>();

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  addEventListener(type: string, listener: (event: FakeDomEvent) => void): void {
    const bucket = this.listeners.get(type) || new Set();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: (event: FakeDomEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchDocumentEvent(type: string, target: FakeElement, key?: string): void {
    const bucket = this.listeners.get(type);
    if (!bucket) return;
    const event = new FakeDomEvent(type, target, key);
    for (const listener of Array.from(bucket)) listener(event);
  }
}

let fakeDocument: FakeDocument;

async function createSelector() {
  const modeModule = await import('../ModeSelector.js');
  const loggerModule = await import('../../../ClientLogger.js');
  vi.spyOn(loggerModule.ClientLogger.ui, 'debug').mockImplementation(() => {});
  return new modeModule.ModeSelector('auto', true);
}

function openDropdown(selector: { element: FakeElement }): FakeElement {
  selector.element.dispatchEvent(new FakeDomEvent('click', selector.element));
  const dropdown = fakeDocument.body.children.find((child) => child.classList.contains('mode-dropdown'));
  expect(dropdown).toBeTruthy();
  return dropdown!;
}

beforeEach(() => {
  vi.resetModules();
  fakeDocument = new FakeDocument();
  vi.stubGlobal('document', fakeDocument);
  vi.stubGlobal('window', { innerWidth: 1024 });
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ModeSelector', () => {
  it('changes mode when a menu option is pressed', async () => {
    const selector = await createSelector();
    const changes: string[] = [];
    selector.onModeChange = (mode) => changes.push(mode);

    const dropdown = openDropdown(selector as unknown as { element: FakeElement });
    const askOption = dropdown.children[2];
    askOption.dispatchEvent(new FakeDomEvent('pointerdown', askOption));

    expect(selector.getMode()).toBe('ask');
    expect(changes).toEqual(['ask']);
    expect(fakeDocument.body.children.some((child) => child.classList.contains('mode-dropdown'))).toBe(false);
  });

  it('does not treat clicks on button children as outside clicks', async () => {
    const selector = await createSelector();
    openDropdown(selector as unknown as { element: FakeElement });

    const button = selector.element as unknown as FakeElement;
    const label = button.children[0];
    fakeDocument.dispatchDocumentEvent('pointerdown', label);
    button.dispatchEvent(new FakeDomEvent('click', label));

    expect(fakeDocument.body.children.some((child) => child.classList.contains('mode-dropdown'))).toBe(false);
    expect(selector.element.getAttribute('aria-expanded')).toBe('false');
  });
});
