import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../../i18n/index.js';

vi.mock('../../ConfirmDialog.js', () => ({
  ConfirmDialog: {
    show: vi.fn(),
  },
}));

class FakePluginElement extends EventTarget {
  readonly children: FakePluginElement[] = [];
  readonly style = { display: '' };
  readonly contentWindow?: {
    postMessage: ReturnType<typeof vi.fn>;
  };
  readonly contentDocument?: {
    documentElement: FakePluginElement;
    head: FakePluginElement;
    createElement(tagName: string): FakePluginElement;
  };
  className = '';
  src = '';
  srcdoc = '';
  textContent = '';
  rel = '';
  href = '';
  lang = '';
  parentElement: FakePluginElement | null = null;
  private readonly attributes = new Map<string, string>();

  constructor(readonly tagName: string) {
    super();
    if (tagName === 'iframe') {
      const documentElement = new FakePluginElement('html');
      this.contentWindow = { postMessage: vi.fn() };
      this.contentDocument = {
        documentElement,
        head: new FakePluginElement('head'),
        createElement: (name: string) => new FakePluginElement(name),
      };
    }
  }

  appendChild<T extends FakePluginElement>(child: T): T {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

class FakePluginDocument {
  readonly documentElement = new FakePluginElement('html');

  createElement(tagName: string): FakePluginElement {
    return new FakePluginElement(tagName);
  }
}

describe('PluginPageContainer locale propagation', () => {
  beforeEach(() => {
    setLocale('zh-CN');

    const windowTarget = new EventTarget() as EventTarget & {
      location: { href: string };
    };
    windowTarget.location = { href: 'http://127.0.0.1:3456/index.html' };

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: windowTarget,
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: new FakePluginDocument(),
    });
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  });

  afterEach(() => {
    setLocale('zh-CN');
    vi.unstubAllGlobals();
  });

  it('replaces the iframe locale when the host language changes', async () => {
    const { PluginPageContainer } = await import('../PluginPageContainer.js');
    const page = new PluginPageContainer({
      id: 'gateway',
      pluginName: 'anoclaw-gateway',
      title: 'Gateway',
      htmlPath: '/plugins/anoclaw-gateway/frontend/index.html',
    });

    page.onEnter();
    const iframe = (page.container as unknown as FakePluginElement).children[0];
    expect(iframe.contentDocument?.documentElement.lang).toBe('zh-CN');
    iframe.contentWindow?.postMessage.mockClear();

    setLocale('en-US');
    window.dispatchEvent(new CustomEvent('locale-changed', {
      detail: { locale: 'en-US', previousLocale: 'zh-CN' },
    }));

    expect(iframe.contentWindow?.postMessage).toHaveBeenCalledWith({
      type: 'anoclaw:locale',
      locale: 'en-US',
    }, '*');
    expect(iframe.contentDocument?.documentElement.lang).toBe('en-US');
  });
});
