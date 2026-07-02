// Shared UI: Dialog component
// Usage: new Dialog({ title: 'Confirm', body: 'Are you sure?' }).show()

export interface DialogConfig {
  title: string;
  body: HTMLElement | string;
  footer?: HTMLElement | null;
  width?: string;
  onClose?: () => void;
}

export class Dialog {
  private _overlay: HTMLElement;
  private _onClose?: () => void;
  private _escHandler: (e: KeyboardEvent) => void;

  constructor(config: DialogConfig) {
    this._onClose = config.onClose;

    const overlay = document.createElement('div');
    overlay.className = 'ui-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'ui-dialog';
    if (config.width) dialog.style.width = config.width;

    // Header
    const header = document.createElement('div');
    header.className = 'ui-dialog-header';
    const title = document.createElement('h2');
    title.className = 'ui-dialog-title';
    title.textContent = config.title;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ui-dialog-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(title);
    header.appendChild(closeBtn);

    // Body
    const body = document.createElement('div');
    body.className = 'ui-dialog-body';
    if (typeof config.body === 'string') {
      body.textContent = config.body;
    } else {
      body.appendChild(config.body);
    }

    dialog.appendChild(header);
    dialog.appendChild(body);

    // Footer
    if (config.footer) {
      const footer = document.createElement('div');
      footer.className = 'ui-dialog-footer';
      footer.appendChild(config.footer);
      dialog.appendChild(footer);
    }

    overlay.appendChild(dialog);

    // Close on overlay click (not dialog click)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });

    this._overlay = overlay;
    this._escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.close();
    };
  }

  show(): void {
    document.body.appendChild(this._overlay);
    document.addEventListener('keydown', this._escHandler);
  }

  close(): void {
    if (this._overlay.parentElement) {
      this._overlay.remove();
    }
    document.removeEventListener('keydown', this._escHandler);
    this._onClose?.();
  }
}
