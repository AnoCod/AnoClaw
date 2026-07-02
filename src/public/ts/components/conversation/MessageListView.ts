// AnoClaw — MessageListView: scrollable message container

export class MessageListView {
  container: HTMLElement;
  private scrollContainer: HTMLElement;
  private autoScroll: boolean;
  private scrollThreshold: number;

  constructor() {
    this.autoScroll = true;
    this.scrollThreshold = 64; // px from bottom to consider "at bottom"

    this.container = document.createElement('div');
    this.container.className = 'msg-list-view';
    this.container.style.cssText = `
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    `;

    this.scrollContainer = document.createElement('div');
    this.scrollContainer.className = 'msg-list-scroll';
    this.scrollContainer.style.cssText = `
      flex: 1;
      overflow-y: auto;
      padding: var(--space-lg);
      display: flex;
      flex-direction: column;
      gap: 0;
    `;

    // Track user scroll to disable auto-scroll when reading history
    this.scrollContainer.addEventListener('scroll', () => {
      const el = this.scrollContainer;
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      this.autoScroll = distFromBottom < this.scrollThreshold;
    });

    this.container.appendChild(this.scrollContainer);
  }

  /** Append a rendered delegate element to the list */
  addDelegate(element: HTMLElement): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'msg-delegate-wrapper';
    wrapper.style.cssText = `
      animation: msgSlideIn 150ms ease-out;
    `;
    wrapper.appendChild(element);
    this.scrollContainer.appendChild(wrapper);
    this.scrollToBottomIfNeeded();
  }

  /** Replace the last delegate element (for streaming updates) */
  updateLastDelegate(element: HTMLElement): void {
    const wrappers = this.scrollContainer.querySelectorAll(':scope > .msg-delegate-wrapper');
    if (wrappers.length > 0) {
      const lastWrapper = wrappers[wrappers.length - 1];
      lastWrapper.innerHTML = '';
      lastWrapper.appendChild(element);
    } else {
      this.addDelegate(element);
    }
    this.scrollToBottomIfNeeded();
  }

  /** Remove all messages */
  clear(): void {
    this.scrollContainer.innerHTML = '';
    this.autoScroll = true;
  }

  /** Scroll to the bottom of the message list */
  scrollToBottom(): void {
    // Use requestAnimationFrame for smooth rendering during streaming
    requestAnimationFrame(() => {
      this.scrollContainer.scrollTop = this.scrollContainer.scrollHeight;
    });
  }

  /** Only scroll if user hasn't manually scrolled up */
  private scrollToBottomIfNeeded(): void {
    if (this.autoScroll) {
      this.scrollToBottom();
    }
  }

  /** Get the number of messages currently in the list */
  get messageCount(): number {
    return this.scrollContainer.querySelectorAll(':scope > .msg-delegate-wrapper').length;
  }

  /** Get the last delegate wrapper element, if any */
  get lastDelegateWrapper(): HTMLElement | null {
    const wrappers = this.scrollContainer.querySelectorAll(':scope > .msg-delegate-wrapper');
    if (wrappers.length > 0) {
      return wrappers[wrappers.length - 1] as HTMLElement;
    }
    return null;
  }

  /** Force auto-scroll back on (user hit bottom or sent a new message) */
  resetAutoScroll(): void {
    this.autoScroll = true;
  }
}

// Inject the slide-in animation
const styleId = 'msg-list-animations';
if (!document.getElementById(styleId)) {
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    @keyframes msgSlideIn {
      from {
        opacity: 0;
        transform: translateY(12px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
  `;
  document.head.appendChild(style);
}
