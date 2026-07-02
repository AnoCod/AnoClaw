// Shared UI: Tabs component

export interface TabDef {
  label: string;
  content: HTMLElement;
}

export interface TabsConfig {
  tabs: TabDef[];
  activeIndex?: number;
  onChange?: (index: number) => void;
}

export class Tabs {
  readonly element: HTMLElement;
  private _activeIndex: number;
  private _onChange?: (index: number) => void;
  private _tabBar: HTMLElement;
  private _panelArea: HTMLElement;

  constructor(config: TabsConfig) {
    this._activeIndex = config.activeIndex || 0;
    this._onChange = config.onChange;

    const container = document.createElement('div');
    container.className = 'ui-tabs';

    this._tabBar = document.createElement('div');
    this._tabBar.className = 'ui-tabs-bar';

    this._panelArea = document.createElement('div');
    this._panelArea.className = 'ui-tabs-panels';

    config.tabs.forEach((tab, i) => {
      const btn = document.createElement('button');
      btn.className = 'ui-tabs-btn';
      if (i === this._activeIndex) btn.classList.add('active');
      btn.textContent = tab.label;
      btn.addEventListener('click', () => { this.activeIndex = i; });
      this._tabBar.appendChild(btn);

      const panel = document.createElement('div');
      panel.className = 'ui-tabs-panel';
      panel.appendChild(tab.content);
      this._panelArea.appendChild(panel);
    });

    container.appendChild(this._tabBar);
    container.appendChild(this._panelArea);
    this.element = container;
    this._sync();
  }

  get activeIndex(): number { return this._activeIndex; }
  set activeIndex(v: number) {
    this._activeIndex = v;
    this._sync();
    this._onChange?.(v);
  }

  private _sync(): void {
    const btns = this._tabBar.querySelectorAll('.ui-tabs-btn');
    const panels = this._panelArea.querySelectorAll('.ui-tabs-panel');
    btns.forEach((b, i) => b.classList.toggle('active', i === this._activeIndex));
    panels.forEach((p, i) => p.classList.toggle('active', i === this._activeIndex));
  }
}
