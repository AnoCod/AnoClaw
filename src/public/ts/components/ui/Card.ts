// Shared UI: Card component
// Usage: new Card({ content, interactive: true, onClick: ... }).element

export interface CardConfig {
  content: HTMLElement | string;
  interactive?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

export class Card {
  readonly element: HTMLElement;

  constructor(config: CardConfig) {
    const el = document.createElement('div');
    el.className = 'ui-card';
    if (config.interactive) el.classList.add('ui-card-interactive');
    if (config.disabled) el.classList.add('ui-card-disabled');

    if (typeof config.content === 'string') {
      el.textContent = config.content;
    } else {
      el.appendChild(config.content);
    }

    if (config.onClick) {
      el.addEventListener('click', config.onClick);
    }

    this.element = el;
  }
}
