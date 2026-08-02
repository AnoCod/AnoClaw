import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../../i18n/index.js';

const dialogHarness = vi.hoisted(() => ({
  current: null as {
    body: unknown;
    title: unknown;
    close(): void;
  } | null,
}));

vi.mock('../../ui/Button.js', () => ({
  Button: class {
    readonly element = document.createElement('button');

    constructor(config: { label: string; disabled?: boolean }) {
      this.label = config.label;
      this.disabled = config.disabled ?? false;
    }

    get label(): string {
      return this.element.textContent || '';
    }

    set label(value: string) {
      this.element.textContent = value;
    }

    get disabled(): boolean {
      return this.element.disabled;
    }

    set disabled(value: boolean) {
      this.element.disabled = value;
    }
  },
}));

vi.mock('../../ui/Dialog.js', () => ({
  Dialog: class {
    private readonly onClose?: () => void;

    constructor(config: { title: string; body: DialogElement; footer?: DialogElement; onClose?: () => void }) {
      this.onClose = config.onClose;
      const dialog = document.createElement('div') as unknown as DialogElement;
      const title = document.createElement('h2') as unknown as DialogElement;
      title.className = 'ui-dialog-title';
      title.textContent = config.title;
      dialog.appendChild(title);
      const bodyWrapper = document.createElement('div') as unknown as DialogElement;
      bodyWrapper.className = 'ui-dialog-body';
      bodyWrapper.appendChild(config.body);
      dialog.appendChild(bodyWrapper);
      if (config.footer) dialog.appendChild(config.footer);
      dialogHarness.current = {
        body: config.body,
        title,
        close: () => this.close(),
      };
    }

    show(): void {}

    close(): void {
      this.onClose?.();
    }
  },
}));

vi.mock('../../../ToastManager.js', () => ({
  ToastManager: {
    getInstance: () => ({ success: vi.fn(), error: vi.fn() }),
  },
}));

class DialogClassList {
  constructor(private readonly owner: DialogElement) {}

  add(token: string): void {
    if (!this.owner.className.split(/\s+/).includes(token)) {
      this.owner.className = `${this.owner.className} ${token}`.trim();
    }
  }

  remove(token: string): void {
    this.owner.className = this.owner.className
      .split(/\s+/)
      .filter((entry) => entry && entry !== token)
      .join(' ');
  }
}

class DialogElement {
  readonly children: DialogElement[] = [];
  readonly style = { cssText: '' };
  readonly dataset: Record<string, string> = {};
  readonly classList = new DialogClassList(this);
  parentElement: DialogElement | null = null;
  className = '';
  id = '';
  value = '';
  textContent = '';
  disabled = false;
  private _html = '';
  private readonly listeners = new Map<string, Array<(event: { key?: string; target: DialogElement }) => void>>();
  private readonly selectorOverrides = new Map<string, DialogElement>();

  constructor(readonly tagName = 'div') {}

  set innerHTML(value: string) {
    this._html = value;
    if (this.tagName !== 'select') return;
    this.children.splice(0);
    const optionPattern = /<option value="([^"]*)"([^>]*)>([\s\S]*?)<\/option>/g;
    let match: RegExpExecArray | null;
    let selectedValue = '';
    while ((match = optionPattern.exec(value))) {
      const option = new DialogElement('option');
      option.value = match[1];
      option.textContent = match[3].replace(/<[^>]+>/g, '');
      this.appendChild(option);
      if (match[2].includes('selected')) selectedValue = option.value;
    }
    this.value = selectedValue || this.children[0]?.value || '';
  }

  get innerHTML(): string {
    return this._html;
  }

  appendChild<T extends DialogElement>(child: T): T {
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

  addEventListener(type: string, listener: (event: { key?: string; target: DialogElement }) => void): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  register(selector: string, element: DialogElement): void {
    this.selectorOverrides.set(selector, element);
  }

  querySelector<T extends DialogElement = DialogElement>(selector: string): T | null {
    const override = this.selectorOverrides.get(selector);
    if (override) return override as T;
    for (const child of this.children) {
      if (child.matches(selector)) return child as T;
      const nested = child.querySelector<T>(selector);
      if (nested) return nested;
    }
    return null;
  }

  querySelectorAll<T extends DialogElement = DialogElement>(selector: string): T[] {
    const matches: T[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) matches.push(child as T);
      matches.push(...child.querySelectorAll<T>(selector));
    }
    return matches;
  }

  private matches(selector: string): boolean {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    const option = selector.match(/^option\[value="([^"]+)"\]$/);
    if (option) return this.tagName === 'option' && this.value === option[1];
    return selector === this.tagName;
  }
}

class DialogDocument {
  readonly body = new DialogElement('body');

  createElement(tagName: string): DialogElement {
    return new DialogElement(tagName);
  }

  addEventListener(): void {}
}

describe('Talent Pool dialogs runtime locale refresh', () => {
  beforeEach(() => {
    dialogHarness.current = null;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: new DialogDocument(),
    });
    setLocale('en-US');
  });

  afterEach(() => {
    dialogHarness.current?.close();
    dialogHarness.current = null;
    setLocale('zh-CN');
  });

  it('keeps Hire dialog input and selection while translating its chrome', async () => {
    const { showHireDialog } = await import('../talent-pool/HireDialog.js');
    const pending = showHireDialog({
      id: 'template-1',
      groupId: 'engineering',
      name: 'Engineer',
      description: 'Builds software',
      role: 'Member',
      model: 'test-model',
      agentPrompt: 'Test',
      allowedTools: [],
      tags: [],
      starRating: 5,
    } as never, [{
      id: 'manager-1',
      name: 'Manager One',
      role: 'Manager',
    }] as never);
    const body = dialogHarness.current?.body as DialogElement;
    const nameInput = body.querySelector('input') as DialogElement;
    const selects = body.querySelectorAll('select');
    nameInput.value = 'Custom hire name';
    expect(selects[1].value).toBe('manager-1');

    setLocale('zh-CN');

    expect(nameInput.value).toBe('Custom hire name');
    expect(selects[1].value).toBe('manager-1');
    expect(body.children[1].textContent).toBe('智能体名称');
    expect((dialogHarness.current?.title as DialogElement).textContent).toBe('雇用：Engineer');
    dialogHarness.current?.close();
    await expect(pending).resolves.toBeNull();
  });

  it('keeps the Talent Pool search query while rebuilding visible chrome', async () => {
    const { TalentPoolPanel } = await import('../talent-pool/TalentPoolPanel.js');
    const talentPool = new TalentPoolPanel(new DialogElement() as unknown as HTMLElement);
    const panel = new DialogElement();
    const search = new DialogElement('input');
    search.value = 'custom filter';
    panel.register('.tp-search-input', search);
    (talentPool as unknown as { _panel: DialogElement })._panel = panel;

    setLocale('zh-CN');

    expect(search.value).toBe('custom filter');
    expect(panel.innerHTML).toContain('人才库');
    expect(panel.innerHTML).toContain('暂无领域');
    expect(panel.innerHTML).not.toContain('No domains yet');
  });

  it('keeps edited Save-to-Pool fields while translating labels and title', async () => {
    const { showSaveToPoolDialog } = await import('../talent-pool/SaveToPoolDialog.js');
    const pending = showSaveToPoolDialog({
      id: 'agent-1',
      name: 'Agent One',
      role: 'Manager',
    } as never, [{
      id: 'engineering',
      name: 'Engineering',
    }] as never);
    const body = dialogHarness.current?.body as DialogElement;
    const inputs = body.querySelectorAll('input');
    inputs[0].value = 'Custom template name';
    inputs[1].value = 'User-authored description';

    setLocale('zh-CN');

    expect(inputs[0].value).toBe('Custom template name');
    expect(inputs[1].value).toBe('User-authored description');
    expect(body.children[1].textContent).toBe('模板名称');
    expect(body.children[3].textContent).toBe('描述');
    expect((dialogHarness.current?.title as DialogElement).textContent).toBe('保存到人才库');
    dialogHarness.current?.close();
    await expect(pending).resolves.toBeNull();
  });
});
