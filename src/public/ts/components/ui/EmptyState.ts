// Shared UI: EmptyState component

export interface EmptyStateConfig {
  icon?: string;
  title?: string;
  description?: string;
  action?: { element: HTMLElement };
}

export class EmptyState {
  readonly element: HTMLElement;

  constructor(config: EmptyStateConfig) {
    const el = document.createElement('div');
    el.className = 'ui-empty';

    const icon = document.createElement('div');
    icon.className = 'ui-empty-icon';
    icon.innerHTML = config.icon || '';
    el.appendChild(icon);

    const title = document.createElement('div');
    title.className = 'ui-empty-title';
    title.textContent = config.title || '';
    el.appendChild(title);

    const desc = document.createElement('div');
    desc.className = 'ui-empty-desc';
    desc.textContent = config.description || '';
    el.appendChild(desc);

    if (config.action) {
      const actionArea = document.createElement('div');
      actionArea.className = 'ui-empty-action';
      actionArea.appendChild(config.action.element);
      el.appendChild(actionArea);
    }

    this.element = el;
  }
}
