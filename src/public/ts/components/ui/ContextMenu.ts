// Shared UI: ContextMenu component

export interface ContextMenuItem {
  label: string;
  disabled?: boolean;
  onClick?: () => void;
}

export interface ContextMenuConfig {
  items: ContextMenuItem[];
}

export class ContextMenu {
  readonly element: HTMLElement;

  constructor(config: ContextMenuConfig) {
    const menu = document.createElement('div');
    menu.className = 'ui-context-menu';

    for (const item of config.items) {
      const row = document.createElement('div');
      row.className = 'ui-context-menu-item';
      if (item.disabled) row.classList.add('disabled');
      row.textContent = item.label;
      if (!item.disabled) {
        row.addEventListener('click', () => {
          item.onClick?.();
          this.close();
        });
      }
      menu.appendChild(row);
    }

    this.element = menu;
  }

  show(x: number, y: number): void {
    this.element.style.left = `${x}px`;
    this.element.style.top = `${y}px`;
    document.body.appendChild(this.element);
    setTimeout(() => { document.addEventListener('click', this.close, { once: true }); }, 0);
  }

  close = (): void => {
    if (this.element.parentElement) this.element.remove();
  };
}
