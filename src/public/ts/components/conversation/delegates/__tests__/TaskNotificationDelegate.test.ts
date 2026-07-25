import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskNotificationDelegate } from '../TaskNotificationDelegate.js';

class FakeElement {
  children: FakeElement[] = [];
  className = '';
  textContent = '';
  style: Record<string, string> = {};
  private attributes = new Map<string, string>();
  parent: FakeElement | null = null;

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] || null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  querySelector<T extends FakeElement>(selector: string): T | null {
    if (selector.startsWith('.') && this.className.split(/\s+/).includes(selector.slice(1))) return this as unknown as T;
    for (const child of this.children) {
      const found = child.querySelector<T>(selector);
      if (found) return found;
    }
    return null;
  }

  remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }
}

const showNotification = vi.fn(async () => {});

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: () => new FakeElement(),
  });
  vi.stubGlobal('window', {
    electronAPI: { showNotification },
  });
});

afterEach(() => {
  showNotification.mockClear();
  vi.unstubAllGlobals();
});

describe('TaskNotificationDelegate', () => {
  const data = {
    subSessionId: 'sub-1',
    subAgentId: 'worker-1',
    status: 'completed' as const,
    summary: 'Finished tests',
    result: '',
  };

  it('does not replay desktop notifications while rendering history', () => {
    new TaskNotificationDelegate(data, { notify: false });
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('notifies once for a live card and can add a result body on update', () => {
    const delegate = new TaskNotificationDelegate(data, { notify: true });

    expect(showNotification).toHaveBeenCalledTimes(1);
    delegate.update({ ...data, result: 'All checks passed.' });

    expect((delegate.element as unknown as FakeElement).children).toHaveLength(2);
    expect((delegate.element as unknown as FakeElement).children[1].textContent).toBe('All checks passed.');
    expect(showNotification).toHaveBeenCalledTimes(1);
  });
});
