// AnoClaw — ToastManager: global toast notification system
// Provides show(type, msg, duration?) for success/error/info feedback.

type ToastType = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  element: HTMLElement;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Singleton toast notification manager.
 *
 * Creates a fixed container in the DOM, renders toast divs with type-based CSS classes
 * (toast-success / toast-error / toast-info), and manages auto-dismiss via setTimeout.
 *
 * Animation: toast-visible class triggers CSS transition (fade in). On dismiss,
 * toast-hiding class triggers fade out, then the DOM node is removed after 300ms.
 */
export class ToastManager {
  private static _instance: ToastManager;
  private _container: HTMLElement | null = null;
  private _toasts: Map<number, ToastItem> = new Map();
  private _nextId = 1;

  private constructor() {}

  static getInstance(): ToastManager {
    if (!this._instance) {
      this._instance = new ToastManager();
    }
    return this._instance;
  }

  /** Ensure the toast container exists in the DOM. */
  private _ensureContainer(): HTMLElement {
    if (this._container && document.body.contains(this._container)) {
      return this._container;
    }
    const container = document.createElement('div');
    container.className = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
    this._container = container;
    return container;
  }

  /** Show a toast, return id for manual dismiss. Duration 0 = sticky (no auto-dismiss). */
  show(type: ToastType, msg: string, duration: number = 3000): number {
    const id = this._nextId++;
    console.log('[Toast] show', { id, type, msg: msg.slice(0, 80), duration });
    const container = this._ensureContainer();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('data-toast-id', String(id));
    toast.textContent = msg;

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.dismiss(id);
    });
    toast.appendChild(closeBtn);

    container.appendChild(toast);

    // requestAnimationFrame ensures the element is in DOM before adding visible class for CSS transition
    requestAnimationFrame(() => {
      toast.classList.add('toast-visible');
    });

    // Auto-dismiss after duration (unless sticky with 0)
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (duration > 0) {
      timer = setTimeout(() => this.dismiss(id), duration);
    }

    this._toasts.set(id, { id, element: toast, timer });

    return id;
  }

  /** Dismiss a toast: clear timer, trigger hide animation, remove from DOM after 300ms. */
  dismiss(id: number): void {
    const item = this._toasts.get(id);
    if (!item) return;

    console.log('[Toast] dismiss', { id });

    if (item.timer) {
      clearTimeout(item.timer);
    }

    // Swap classes: remove visible (fade in), add hiding (fade out)
    item.element.classList.remove('toast-visible');
    item.element.classList.add('toast-hiding');

    // Wait for CSS transition to finish (300ms), then remove DOM node
    setTimeout(() => {
      if (item.element.parentElement) {
        item.element.remove();
      }
      this._toasts.delete(id);
      // Remove container from DOM when empty to keep a clean DOM
      if (this._container && this._container.children.length === 0) {
        this._container.remove();
        this._container = null;
      }
    }, 300);
  }

  /** Dismiss all visible toasts. */
  dismissAll(): void {
    Array.from(this._toasts.keys()).forEach((id) => {
      this.dismiss(id);
    });
  }

  /** Quick helpers */
  success(msg: string, duration?: number): number {
    return this.show('success', msg, duration);
  }

  error(msg: string, duration?: number): number {
    return this.show('error', msg, duration);
  }

  info(msg: string, duration?: number): number {
    return this.show('info', msg, duration);
  }
}
