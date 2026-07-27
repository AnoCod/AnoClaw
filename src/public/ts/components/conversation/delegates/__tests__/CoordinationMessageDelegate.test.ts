import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserMessageDelegate } from '../UserMessageDelegate.js';

class FakeElement {
  children: FakeElement[] = [];
  className = '';
  dataset: Record<string, string> = {};
  innerHTML = '';
  textContent = '';

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  findByClass(className: string): FakeElement | null {
    if (this.className.split(/\s+/).includes(className)) return this;
    for (const child of this.children) {
      const match = child.findByClass(className);
      if (match) return match;
    }
    return null;
  }
}

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: () => new FakeElement(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('UserMessageDelegate coordination presentation', () => {
  it('renders the screenshot-style note as a status card, not a YOU/XML message', () => {
    const delegate = new UserMessageDelegate({
      type: 'message',
      role: 'user',
      content: [
        '<coordination-message id="msg-1" root-session-id="root-1" from-agent="ceo" to-agent="frontend-manager" kind="note">',
        'Hey, 我是 CEO。Frontend Team 最近在做什么？',
        '</coordination-message>',
      ].join('\n'),
      agentName: 'CEO',
      timestamp: '2026-07-27T15:23:52.785Z',
    });
    const element = delegate.element as unknown as FakeElement;

    expect(element.className).toContain('coordination-transcript-card');
    expect(element.dataset.coordinationState).toBe('mailbox_only');
    expect(element.findByClass('coordination-transcript-status')?.textContent)
      .toBe('Delivered · mailbox only');
    expect(element.findByClass('coordination-transcript-route')?.textContent)
      .toBe('CEO → frontend-manager');
    expect(element.findByClass('coordination-transcript-body')?.innerHTML)
      .toContain('Frontend Team 最近在做什么？');
    expect(element.findByClass('coordination-transcript-body')?.innerHTML)
      .not.toContain('coordination-message');
    expect(element.findByClass('cinema-user-text')).toBeNull();
  });
});
