import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../../i18n/index.js';

const runtimeHarness = vi.hoisted(() => ({
  sseOn: vi.fn(),
  talentOn: vi.fn(),
  pluginsLoad: vi.fn(() => Promise.resolve()),
  pluginsOn: vi.fn(),
  pluginsOff: vi.fn(),
}));

vi.mock('../../../app.js', () => ({
  App: {
    getInstance: () => ({
      sseClient: { on: runtimeHarness.sseOn },
      agentVM: { agents: [] },
    }),
  },
}));

vi.mock('../talent-pool/TalentPoolPanel.js', () => ({
  TalentPoolPanel: class {
    visible = false;
    on = runtimeHarness.talentOn;
    reload = vi.fn();
    close = vi.fn();
    open = vi.fn();
    toggle = vi.fn();
  },
}));

vi.mock('../talent-pool/HireDialog.js', () => ({ showHireDialog: vi.fn() }));
vi.mock('../talent-pool/SaveToPoolDialog.js', () => ({ showSaveToPoolDialog: vi.fn() }));
vi.mock('../../../viewmodel/CoordinationStore.js', () => ({
  CoordinationStore: {
    getInstance: () => ({
      on: vi.fn(),
      off: vi.fn(),
    }),
  },
}));
vi.mock('../../../ToastManager.js', () => ({
  ToastManager: { getInstance: () => ({ success: vi.fn(), error: vi.fn() }) },
}));
vi.mock('../../ConfirmDialog.js', () => ({ ConfirmDialog: { show: vi.fn() } }));
vi.mock('../../../ClientLogger.js', () => ({
  ClientLogger: { ui: { info: vi.fn(), error: vi.fn() } },
}));

class RuntimeElement {
  readonly children: RuntimeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style = { cssText: '', display: '' };
  readonly classList = {
    add: vi.fn(),
    remove: vi.fn(),
    toggle: vi.fn(),
  };
  parentElement: RuntimeElement | null = null;
  className = '';
  textContent = '';
  value = '';
  placeholder = '';
  title = '';
  disabled = false;
  innerHTML = '';
  private readonly selectors = new Map<string, RuntimeElement>();
  private readonly attributes = new Map<string, string>();

  register(selector: string, element: RuntimeElement): RuntimeElement {
    this.selectors.set(selector, element);
    return element;
  }

  appendChild<T extends RuntimeElement>(child: T): T {
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

  addEventListener(): void {}
  removeEventListener(): void {}

  querySelector<T extends RuntimeElement = RuntimeElement>(selector: string): T | null {
    return (this.selectors.get(selector) as T | undefined) || null;
  }

  querySelectorAll<T extends RuntimeElement = RuntimeElement>(): T[] {
    return [];
  }
}

class RuntimeDocument {
  readonly body = new RuntimeElement();

  createElement(): RuntimeElement {
    return new RuntimeElement();
  }
}

describe('Agents and Plugins runtime locale refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: new RuntimeDocument(),
    });
    setLocale('en-US');
  });

  afterEach(() => {
    setLocale('zh-CN');
  });

  it('updates an open agent editor without replacing typed values', async () => {
    const { AgentsPage } = await import('../AgentsPage.js');
    const page = new AgentsPage();
    const panel = new RuntimeElement();
    const title = panel.register('.ag-edit-header h3', new RuntimeElement());
    const nameLabel = panel.register('label[for="ag-edit-name"]', new RuntimeElement());
    const nameInput = panel.register('#ag-edit-name', new RuntimeElement());
    nameInput.value = 'User typed name';

    (page as unknown as { _editPanel: RuntimeElement })._editPanel = panel;
    (page as unknown as { _editingAgent: { name: string } })._editingAgent = { name: 'Stored agent' };

    setLocale('zh-CN');

    expect(title.textContent).toBe('编辑：Stored agent');
    expect(nameLabel.textContent).toBe('名称');
    expect(nameInput.value).toBe('User typed name');
  });

  it('re-renders the active plugin page in the selected language', async () => {
    const { PluginsPage } = await import('../PluginsPage.js');
    const vm = {
      plugins: [],
      load: runtimeHarness.pluginsLoad,
      on: runtimeHarness.pluginsOn,
      off: runtimeHarness.pluginsOff,
    };
    const page = new PluginsPage(vm as never);
    page.onEnter();
    expect((page.container as unknown as RuntimeElement).innerHTML).toContain('No plugins installed');

    setLocale('zh-CN');

    expect((page.container as unknown as RuntimeElement).innerHTML).toContain('尚未安装插件');
    expect((page.container as unknown as RuntimeElement).innerHTML).not.toContain('No plugins installed');
    page.onExit();
  });
});
