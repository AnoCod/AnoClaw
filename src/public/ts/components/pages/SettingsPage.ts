/**
 * AnoClaw Cinema — Settings Page
 * Appearance, display, context, and data management in cinema form style.
 */

import { App } from '../../app.js';
import type { Page, AppSettings } from '../../types.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { ClientLogger } from '../../ClientLogger.js';
import { ToastManager } from '../../ToastManager.js';
import { slotRegistry } from '../../SlotRegistry.js';
import { Toggle } from '../ui/Toggle.js';
import { normalizeLocale, onLocaleChange, SUPPORTED_LOCALES, t } from '../../i18n/index.js';

export class SettingsPage implements Page {
  name = 'settings';
  container: HTMLElement;
  private _draft: AppSettings | null = null;

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'cinema-static-page';
    this.container.setAttribute('data-page', 'settings');
    this.container.style.display = 'none';
    this.container.innerHTML = `
      <div class="cinema-static-inner">
        <form id="settings-form" class="settings-workbench-form"></form>
      </div>
    `;
    onLocaleChange(({ locale }) => {
      if (this._draft) this._draft.lang = locale;
      if (this.container.style.display !== 'none') this._buildForm();
    });
  }

  onEnter(): void {
    this._buildForm();
  }

  onExit(): void {}

  private _buildForm(): void {
    console.log('[Settings] buildForm started');
    const app = App.getInstance();
    if (!this._draft) this._draft = { ...app.settings };
    const s = { ...this._draft };
    document.documentElement.setAttribute('data-theme', s.theme);
    document.documentElement.style.setProperty('--user-accent', s.accentColor);
    const form = this.container.querySelector('#settings-form') as HTMLFormElement;
    if (!form) return;
    const currentLocale = normalizeLocale(s.lang);
    const languageOptions = SUPPORTED_LOCALES.map((locale) =>
      `<option value="${locale.code}" ${currentLocale === locale.code ? 'selected' : ''}>${locale.nativeName}</option>`
    ).join('');

    form.innerHTML = `
      <div class="cinema-section settings-section settings-section-appearance">
        <div class="cinema-section-legend">${t('settings.appearance')}</div>
        <div class="settings-section-body settings-appearance-body">
          <div>
            <div class="settings-field-label">${t('settings.theme')}</div>
            <span id="appearance-theme"></span>
          </div>
          <div>
            <div class="settings-field-label">${t('settings.accent')}</div>
            <span id="appearance-accent"></span>
          </div>
        </div>
      </div>

      <div class="cinema-section settings-section">
        <div class="cinema-section-legend">${t('settings.language')}</div>
        <div class="settings-section-body">
          <label class="settings-row">
            <span class="settings-row-label">${t('settings.interfaceLanguage')}</span>
            <select name="lang" class="cinema-select" style="min-width:150px;">${languageOptions}</select>
          </label>
          <div class="settings-helper">${t('settings.languageHint')}</div>
        </div>
      </div>

      <div class="cinema-section settings-section">
        <div class="cinema-section-legend">${t('settings.display')}</div>
        <div class="settings-section-body">
          <label class="settings-row">
            <span class="settings-row-label">${t('settings.showThinkingCards')}</span>
            <span id="toggle-think"></span>
          </label>
          <label class="settings-row">
            <span class="settings-row-label">${t('settings.showToolCards')}</span>
            <span id="toggle-tool"></span>
          </label>
        </div>
      </div>

      <div class="cinema-section settings-section">
        <div class="cinema-section-legend">${t('settings.context')}</div>
        <div class="settings-section-body">
          <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--color-cinema-text-muted);">
            <span>${t('settings.compactionThreshold')}</span>
            <span id="compaction-val">${s.compactionThreshold}%</span>
          </div>
          <input type="range" name="compactionThreshold" min="30" max="90" value="${s.compactionThreshold}" step="5"
            style="width:100%;accent-color:var(--color-primary, #0b8ce9);"
            oninput="document.getElementById('compaction-val').textContent=this.value+'%'">
        </div>
      </div>

      <div class="cinema-section settings-section">
        <div class="cinema-section-legend">${t('settings.data')}</div>
        <div class="settings-section-body settings-action-row">
          <button type="button" id="btn-export" class="cinema-btn">${t('settings.exportSettings')}</button>
          <button type="button" id="btn-clear" class="cinema-btn">${t('settings.clearAllSessions')}</button>
        </div>
      </div>

      <div class="settings-save-row">
        <button type="submit" class="cinema-btn cinema-btn-primary">${t('settings.save')}</button>
      </div>
    `;

    // Slot: settings-bottom
    const bottomSlot = document.createElement('div');
    bottomSlot.setAttribute('data-slot', 'settings-bottom');
    form.appendChild(bottomSlot);
    slotRegistry._onSlotReady('settings-bottom');

    // Create Toggle components for showThinkCards and showToolCards
    const thinkToggle = new Toggle({
      checked: s.showThinkCards,
      onChange: (checked) => { if (this._draft) this._draft.showThinkCards = checked; },
    });
    const toolToggle = new Toggle({
      checked: s.showToolCards,
      onChange: (checked) => { if (this._draft) this._draft.showToolCards = checked; },
    });
    const thinkSlot = form.querySelector('#toggle-think');
    const toolSlot = form.querySelector('#toggle-tool');
    if (thinkSlot) thinkSlot.replaceWith(thinkToggle.element);
    if (toolSlot) toolSlot.replaceWith(toolToggle.element);

    // ── Appearance: theme cards ──
    let currentTheme: 'dark' | 'light' = s.theme;
    let currentAccent = s.accentColor;

    const themeSlot = form.querySelector('#appearance-theme');
    if (themeSlot) {
      const themeCards = document.createElement('div');
      themeCards.className = 'appearance-theme-cards';

      const buildThemeCard = (theme: 'dark' | 'light', label: string) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'appearance-theme-card' + (currentTheme === theme ? ' active' : '');
        card.innerHTML = `<div class="appearance-theme-preview ${theme}-preview">Aa</div><span class="appearance-theme-label">${label}</span>`;
        card.addEventListener('click', () => {
          currentTheme = theme;
          if (this._draft) this._draft.theme = theme;
          document.documentElement.setAttribute('data-theme', theme);
          themeCards.querySelectorAll('.appearance-theme-card').forEach(c => c.classList.remove('active'));
          card.classList.add('active');
        });
        return card;
      };

      themeCards.appendChild(buildThemeCard('dark', t('settings.theme.dark')));
      themeCards.appendChild(buildThemeCard('light', t('settings.theme.light')));
      themeSlot.replaceWith(themeCards);
    }

    // ── Appearance: accent swatches ──
    const ACCENTS = [
      { value: '#0b8ce9', label: t('settings.accent.blue') },
      { value: '#ff6161', label: t('settings.accent.red') },
      { value: '#59d499', label: t('settings.accent.green') },
      { value: '#ffc533', label: t('settings.accent.orange') },
      { value: '#a78bfa', label: t('settings.accent.purple') },
    ];

    const accentSlot = form.querySelector('#appearance-accent');
    if (accentSlot) {
      const swatchRow = document.createElement('div');
      swatchRow.className = 'appearance-swatches';

      for (const a of ACCENTS) {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'appearance-swatch' + (currentAccent === a.value ? ' active' : '');
        swatch.style.setProperty('--appearance-swatch-color', a.value);
        swatch.title = a.label;
        swatch.addEventListener('click', () => {
          currentAccent = a.value;
          if (this._draft) this._draft.accentColor = a.value;
          document.documentElement.style.setProperty('--user-accent', a.value);
          swatchRow.querySelectorAll('.appearance-swatch').forEach(s => s.classList.remove('active'));
          swatch.classList.add('active');
        });
        swatchRow.appendChild(swatch);
      }

      accentSlot.replaceWith(swatchRow);
    }

    // Bind events
    form.querySelector<HTMLSelectElement>('select[name="lang"]')?.addEventListener('change', (e) => {
      const lang = normalizeLocale((e.currentTarget as HTMLSelectElement).value);
      if (this._draft) this._draft.lang = lang;
      if (lang !== app.settings.lang) app.updateSettings({ lang });
    });
    form.querySelector<HTMLInputElement>('[name="compactionThreshold"]')?.addEventListener('input', (e) => {
      const value = Number.parseInt((e.currentTarget as HTMLInputElement).value, 10);
      if (this._draft && Number.isFinite(value)) this._draft.compactionThreshold = value;
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      console.log('[Settings] form submit — theme:', currentTheme, 'accent:', currentAccent);
      const fd = new FormData(form);
      const patch: Partial<AppSettings> = {
        lang: normalizeLocale(fd.get('lang')),
        theme: currentTheme,
        accentColor: currentAccent,
        showThinkCards: thinkToggle.checked,
        showToolCards: toolToggle.checked,
        compactionThreshold: parseInt(fd.get('compactionThreshold') as string),
      };
      this._draft = { ...app.settings, ...patch } as AppSettings;
      app.updateSettings(patch);
      this._draft = { ...app.settings };
      ToastManager.getInstance().success(t('settings.saved'));
      ClientLogger.ui.info('Settings saved');
      this._buildForm();
    });

    form.querySelector('#btn-export')?.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(app.settings, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = t('settings.exportFileName');
      a.click(); URL.revokeObjectURL(url);
    });

    form.querySelector('#btn-clear')?.addEventListener('click', async () => {
      const ok = await ConfirmDialog.show(t('settings.clearConfirm'), t('settings.clearTitle'));
      if (ok) {
        try {
          await fetch('/api/v1/sessions/clear', { method: 'POST' });
          window.location.reload();
        } catch (err) { ClientLogger.ui.error('Failed to clear sessions', { error: (err as Error).message }); }
      }
    });

  }

}
