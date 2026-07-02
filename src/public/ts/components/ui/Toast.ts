// Shared UI: Toast notification component

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastConfig {
  text: string;
  type?: ToastType;
  duration?: number;
  dismissible?: boolean;
  onDismiss?: () => void;
}

export class Toast {
  readonly element: HTMLElement;

  constructor(config: ToastConfig) {
    const el = document.createElement('div');
    el.className = 'ui-toast';
    if (config.type) el.classList.add(`ui-toast-${config.type}`);
    el.textContent = config.text;

    if (config.dismissible !== false) {
      const close = document.createElement('button');
      close.className = 'ui-toast-close';
      close.innerHTML = '&times;';
      close.addEventListener('click', () => {
        el.classList.add('ui-toast-hiding');
        setTimeout(() => { if (el.parentElement) el.remove(); config.onDismiss?.(); }, 200);
      });
      el.appendChild(close);
    }

    if (config.duration && config.duration > 0) {
      setTimeout(() => {
        el.classList.add('ui-toast-hiding');
        setTimeout(() => { if (el.parentElement) el.remove(); config.onDismiss?.(); }, 200);
      }, config.duration);
    }

    this.element = el;
  }
}
