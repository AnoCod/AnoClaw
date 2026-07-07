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
import { normalizeLocale, SUPPORTED_LOCALES, t } from '../../i18n/index.js';
import { normalizeUserMode, USER_MODE_OPTIONS } from '../../userMode.js';

const SVG_REVIEW = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 18h8"/><path d="M3 22h18"/><path d="M14 22a7 7 0 0 0-7-7"/><path d="M10 14 21 3"/><path d="m21 3-4 12-7-5z"/></svg>`;

export class SettingsPage implements Page {
  name = 'settings';
  container: HTMLElement;

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'cinema-static-page';
    this.container.setAttribute('data-page', 'settings');
    this.container.style.display = 'none';
    this.container.innerHTML = `
      <div class="cinema-static-inner">
        <form id="settings-form"></form>
      </div>
    `;
  }

  onEnter(): void {
    this._buildForm();
    this._loadEvolutionStats();
  }

  onExit(): void {}

  private async _loadEvolutionStats(): Promise<void> {
    const el = (id: string) => this.container.querySelector(id);
    try {
      const resp = await fetch('/api/v1/evolution/stats');
      if (!resp.ok) return;
      const data = await resp.json();

      // Stats grid
      const grid = el('#evo-stats');
      if (grid) {
        grid.innerHTML = `
          <div class="evo-stat-card">
            <div class="evo-stat-value">${data.toolCount}</div>
            <div class="evo-stat-label">${t('settings.evolution.toolsTracked')}</div>
          </div>
          <div class="evo-stat-card">
            <div class="evo-stat-value">${data.patterns.total}</div>
            <div class="evo-stat-label">${t('settings.evolution.patternsFound')}</div>
          </div>
          <div class="evo-stat-card">
            <div class="evo-stat-value">${data.scores.totalScores}</div>
            <div class="evo-stat-label">${t('settings.evolution.scoresCollected')}</div>
          </div>
          <div class="evo-stat-card">
            <div class="evo-stat-value">${data.tags.totalPairs}</div>
            <div class="evo-stat-label">${t('settings.evolution.tagsApplied')}</div>
          </div>
          <div class="evo-stat-card">
            <div class="evo-stat-value">${data.tags.uniqueLabels}</div>
            <div class="evo-stat-label">${t('settings.evolution.uniqueTags')}</div>
          </div>
          <div class="evo-stat-card">
            <div class="evo-stat-value">${data.skills.tracked}</div>
            <div class="evo-stat-label">${t('settings.evolution.skillsTracked')}</div>
          </div>
        `;
      }

      // Tool table
      const toolsEl = el('#evo-tools');
      if (toolsEl && data.tools.length > 0) {
        let th = `<table class="evo-tool-table"><thead><tr><th>${t('settings.evolution.table.tool')}</th><th>${t('settings.evolution.table.calls')}</th><th>${t('settings.evolution.table.success')}</th><th>${t('settings.evolution.table.avgTokens')}</th><th>${t('settings.evolution.table.avgMs')}</th></tr></thead><tbody>`;
        for (const t of data.tools) {
          const pct = Math.round(t.successRate * 100);
          th += `<tr><td>${t.name}</td><td>${t.callCount}</td><td>${pct}%</td><td>${t.avgTokens}</td><td>${t.avgDurationMs}</td></tr>`;
        }
        th += '</tbody></table>';
        toolsEl.innerHTML = th;
      } else if (toolsEl) {
        toolsEl.innerHTML = `<div class="evo-empty">${t('settings.evolution.noToolData')}</div>`;
      }

      // Patterns
      const patEl = el('#evo-patterns');
      if (patEl) {
        const p = data.patterns;
        if (p.total === 0) {
          patEl.innerHTML = `<div class="evo-empty">${t('settings.evolution.noPatterns')}</div>`;
        } else {
          patEl.innerHTML = `<div style="font-size:11px;color:var(--color-cinema-text-secondary);">${t('settings.evolution.patternSummary', { total: p.total, skillCandidates: p.skillCandidates, withSkills: p.withSkills })}</div>`;
        }
      }

      // Scores
      const scrEl = el('#evo-scores');
      if (scrEl) {
        const s = data.scores;
        if (s.totalScores === 0) {
          scrEl.innerHTML = `<div class="evo-empty">${t('settings.evolution.noScores')}</div>`;
        } else {
          const agentCount = Object.keys(s.byAgent).length;
          scrEl.innerHTML = `<div style="font-size:11px;color:var(--color-cinema-text-secondary);">${t('settings.evolution.scoreSummary', { avg: s.globalAvg.toFixed(2), total: s.totalScores, agents: agentCount })}</div>`;
        }
      }

      // Tags
      const tagEl = el('#evo-tags');
      if (tagEl) {
        const tags = data.tags;
        if (tags.totalPairs === 0) {
          tagEl.innerHTML = `<div class="evo-empty">${t('settings.evolution.noTags')}</div>`;
        } else {
          const chips = (tags.labels as string[]).slice(0, 10).map((l: string) =>
            `<span class="stn-tag stn-tag--auto" style="margin-right:4px;">${l}</span>`
          ).join('');
          tagEl.innerHTML = `<div style="font-size:11px;color:var(--color-cinema-text-secondary);">${chips}</div>`;
        }
      }
    } catch { /* evolution stats unavailable — non-critical */ }
  }

  private _buildForm(): void {
    console.log('[Settings] buildForm started');
    const app = App.getInstance();
    const s = app.settings;
    const form = this.container.querySelector('#settings-form') as HTMLFormElement;
    if (!form) return;
    const currentLocale = normalizeLocale(s.lang);
    const languageOptions = SUPPORTED_LOCALES.map((locale) =>
      `<option value="${locale.code}" ${currentLocale === locale.code ? 'selected' : ''}>${locale.nativeName}</option>`
    ).join('');
    const currentUserMode = normalizeUserMode(s.userMode);
    const userModeOptions = USER_MODE_OPTIONS.map((mode) =>
      `<option value="${mode.value}" ${currentUserMode === mode.value ? 'selected' : ''}>${t(mode.labelKey)}</option>`
    ).join('');
    const modeDescription = USER_MODE_OPTIONS.find((mode) => mode.value === currentUserMode)?.descriptionKey || 'settings.userMode.simpleDesc';

    form.innerHTML = `
      <div class="cinema-section">
        <div class="cinema-section-legend">${t('settings.appearance')}</div>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div>
            <div style="font-size:10px;color:var(--color-cinema-text-muted);letter-spacing:1px;margin-bottom:8px;">${t('settings.theme')}</div>
            <span id="appearance-theme"></span>
          </div>
          <div>
            <div style="font-size:10px;color:var(--color-cinema-text-muted);letter-spacing:1px;margin-bottom:8px;">${t('settings.accent')}</div>
            <span id="appearance-accent"></span>
          </div>
        </div>
      </div>

      <div class="cinema-section">
        <div class="cinema-section-legend">${t('settings.language')}</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <label style="display:flex;align-items:center;justify-content:space-between;gap:16px;">
            <span style="font-size:12px;color:var(--color-cinema-text-secondary);">${t('settings.interfaceLanguage')}</span>
            <select name="lang" class="cinema-select" style="min-width:150px;">${languageOptions}</select>
          </label>
          <div style="font-size:10px;color:var(--color-cinema-text-muted);line-height:1.5;">${t('settings.languageHint')}</div>
        </div>
      </div>

      <div class="cinema-section">
        <div class="cinema-section-legend">${t('settings.userMode')}</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <label style="display:flex;align-items:center;justify-content:space-between;gap:16px;">
            <span style="font-size:12px;color:var(--color-cinema-text-secondary);">${t('settings.userMode.label')}</span>
            <select name="userMode" class="cinema-select" style="min-width:170px;">${userModeOptions}</select>
          </label>
          <div id="user-mode-hint" style="font-size:10px;color:var(--color-cinema-text-muted);line-height:1.5;">${t(modeDescription)}</div>
          <div style="font-size:10px;color:var(--color-cinema-text-muted);line-height:1.5;">${t('settings.userMode.hint')}</div>
        </div>
      </div>

      <div class="cinema-section">
        <div class="cinema-section-legend">${t('settings.display')}</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <label style="display:flex;align-items:center;justify-content:space-between;">
            <span style="font-size:12px;color:var(--color-cinema-text-secondary);">${t('settings.showThinkingCards')}</span>
            <span id="toggle-think"></span>
          </label>
          <label style="display:flex;align-items:center;justify-content:space-between;">
            <span style="font-size:12px;color:var(--color-cinema-text-secondary);">${t('settings.showToolCards')}</span>
            <span id="toggle-tool"></span>
          </label>
        </div>
      </div>

      <div class="cinema-section">
        <div class="cinema-section-legend">${t('settings.context')}</div>
        <div style="display:flex;flex-direction:column;gap:4px;">
          <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--color-cinema-text-muted);">
            <span>${t('settings.compactionThreshold')}</span>
            <span id="compaction-val">${s.compactionThreshold}%</span>
          </div>
          <input type="range" name="compactionThreshold" min="30" max="90" value="${s.compactionThreshold}" step="5"
            style="width:100%;accent-color:var(--color-accent-cinema);"
            oninput="document.getElementById('compaction-val').textContent=this.value+'%'">
        </div>
      </div>

      <div class="cinema-section">
        <div class="cinema-section-legend">${t('settings.data')}</div>
        <div style="display:flex;gap:8px;">
          <button type="button" id="btn-export" class="cinema-btn">${t('settings.exportSettings')}</button>
          <button type="button" id="btn-clear" class="cinema-btn">${t('settings.clearAllSessions')}</button>
        </div>
      </div>

      <div class="cinema-section">
        <div class="cinema-section-legend">${t('settings.evolution')}</div>
        <div style="display:flex;flex-direction:column;gap:4px;">
          <div id="evo-stats" class="evo-stats-grid">
            <div class="evo-stat-card">
              <div class="evo-stat-value"><span class="evo-spinner"></span></div>
              <div class="evo-stat-label">${t('settings.evolution.loading')}</div>
            </div>
          </div>

          <div class="evo-section-title">${t('settings.evolution.toolUsage')}</div>
          <div id="evo-tools"><div class="evo-empty">${t('settings.evolution.loading')}</div></div>

          <div class="evo-section-title">${t('settings.evolution.patterns')}</div>
          <div id="evo-patterns"><div class="evo-empty">${t('settings.evolution.loading')}</div></div>

          <div class="evo-section-title">${t('settings.evolution.qualityScores')}</div>
          <div id="evo-scores"><div class="evo-empty">${t('settings.evolution.loading')}</div></div>

          <div class="evo-section-title">${t('settings.evolution.sessionTags')}</div>
          <div id="evo-tags"><div class="evo-empty">${t('settings.evolution.loading')}</div></div>

          <div style="display:flex;gap:8px;align-items:center;margin-top:8px;">
            <button type="button" id="btn-evolve" class="cinema-btn cinema-btn-with-icon">${SVG_REVIEW}<span>${t('settings.evolution.review')}</span></button>
            <span id="evolve-status" style="font-size:11px;color:var(--color-cinema-text-tertiary);">${t('settings.evolution.idle')}</span>
          </div>
          <div id="evolve-results" style="display:none;font-size:11px;color:var(--color-cinema-text-secondary);line-height:1.6;"></div>
        </div>
      </div>

      <div style="display:flex;justify-content:flex-end;padding-top:8px;">
        <button type="submit" class="cinema-btn cinema-btn-primary">${t('settings.save')}</button>
      </div>
    `;

    // Slot: settings-bottom
    const bottomSlot = document.createElement('div');
    bottomSlot.setAttribute('data-slot', 'settings-bottom');
    form.appendChild(bottomSlot);
    slotRegistry._onSlotReady('settings-bottom');

    // Create Toggle components for showThinkCards and showToolCards
    const thinkToggle = new Toggle({ checked: s.showThinkCards });
    const toolToggle = new Toggle({ checked: s.showToolCards });
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
      { value: '#da291c', label: t('settings.accent.red') },
      { value: '#ffffff', label: t('settings.accent.white') },
      { value: '#0984E3', label: t('settings.accent.blue') },
      { value: '#00B894', label: t('settings.accent.green') },
      { value: '#7c3aed', label: t('settings.accent.purple') },
      { value: '#E17055', label: t('settings.accent.orange') },
    ];

    const accentSlot = form.querySelector('#appearance-accent');
    if (accentSlot) {
      const swatchRow = document.createElement('div');
      swatchRow.className = 'appearance-swatches';

      for (const a of ACCENTS) {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'appearance-swatch' + (currentAccent === a.value ? ' active' : '');
        swatch.style.background = a.value;
        swatch.title = a.label;
        swatch.addEventListener('click', () => {
          currentAccent = a.value;
          // Override CSS variables directly — works for all accent colors
          document.documentElement.style.setProperty('--color-accent-cinema', a.value);
          document.documentElement.style.setProperty('--color-accent-cinema-subtle', a.value + '1A');
          document.documentElement.style.setProperty('--color-accent-cinema-glow', a.value + '26');
          swatchRow.querySelectorAll('.appearance-swatch').forEach(s => s.classList.remove('active'));
          swatch.classList.add('active');
        });
        swatchRow.appendChild(swatch);
      }

      accentSlot.replaceWith(swatchRow);
    }

    // Bind events
    const modeSelect = form.querySelector('select[name="userMode"]') as HTMLSelectElement | null;
    const modeHint = form.querySelector('#user-mode-hint') as HTMLElement | null;
    modeSelect?.addEventListener('change', () => {
      const selected = normalizeUserMode(modeSelect.value);
      const next = USER_MODE_OPTIONS.find((mode) => mode.value === selected);
      if (modeHint && next) modeHint.textContent = t(next.descriptionKey);
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      console.log('[Settings] form submit — theme:', currentTheme, 'accent:', currentAccent);
      const fd = new FormData(form);
      const patch: Partial<AppSettings> = {
        lang: normalizeLocale(fd.get('lang')),
        userMode: normalizeUserMode(fd.get('userMode')),
        theme: currentTheme,
        accentColor: currentAccent,
        showThinkCards: thinkToggle.checked,
        showToolCards: toolToggle.checked,
        compactionThreshold: parseInt(fd.get('compactionThreshold') as string),
      };
      app.updateSettings(patch);
      ToastManager.getInstance().success(t('settings.saved'));
      ClientLogger.ui.info('Settings saved');
      this._buildForm();
      this._loadEvolutionStats();
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

    // ── Evolution: trigger analysis ──
    form.querySelector('#btn-evolve')?.addEventListener('click', async () => {
      const status = form.querySelector('#evolve-status') as HTMLElement;
      const results = form.querySelector('#evolve-results') as HTMLElement;
      if (!status || !results) return;

      status.textContent = t('settings.evolution.analyzing');
      results.style.display = 'none';

      try {
        const resp = await fetch('/api/v1/evolution/analyze', { method: 'POST' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const report = await resp.json();

        status.textContent = t('settings.evolution.complete', {
          total: report.summary.totalFindings,
          critical: report.summary.criticalFindings,
        });
        results.style.display = 'block';

        let html = '';
        if (report.skillChanges.length > 0) {
          html += `<div style="margin-top:4px;"><strong>${t('settings.evolution.skills')}:</strong> `;
          html += report.skillChanges.map((c: any) =>
            `${c.skillId} → ${c.action}${c.reason ? ': ' + c.reason.slice(0, 60) : ''}`
          ).join('<br>');
          html += '</div>';
        }
        if (report.memoryFindings.length > 0) {
          html += `<div style="margin-top:4px;"><strong>${t('settings.evolution.memory')}:</strong> `;
          html += report.memoryFindings.map((m: any) =>
            `${m.memoryId} → ${m.action}`
          ).join('<br>');
          html += '</div>';
        }
        if (report.tokenFindings.length > 0) {
          html += `<div style="margin-top:4px;"><strong>${t('settings.evolution.tokenWaste')}:</strong> `;
          html += report.tokenFindings.map((finding: any) =>
            `${finding.toolName}: ${t('settings.evolution.tokenSavings', { tokens: finding.estimatedSavings })}`
          ).join('<br>');
          html += '</div>';
        }
        if (report.promptSuggestions.length > 0) {
          html += `<div style="margin-top:4px;"><strong>${t('settings.evolution.promptTweaks')}:</strong> `;
          html += report.promptSuggestions.map((p: any) =>
            `${p.agentId} — ${p.reason.slice(0, 60)}`
          ).join('<br>');
          html += '</div>';
        }
        if (!html) html = `<em>${t('settings.evolution.noFindings')}</em>`;
        results.innerHTML = html;

        // Apply button for skill archives
        if (report.skillChanges && report.skillChanges.some(function (c: any) { return c.action === 'archive'; })) {
          const applyDiv = document.createElement('div');
          applyDiv.style.cssText = 'margin-top:8px;display:flex;gap:8px;align-items:center;';
          var applyBtn = document.createElement('button');
          applyBtn.type = 'button';
          applyBtn.className = 'cinema-btn';
          applyBtn.style.cssText = 'border-color:var(--color-accent);color:var(--color-accent);';
          applyBtn.textContent = t('settings.evolution.applySkillArchives');
          applyBtn.addEventListener('click', async function () {
            try {
              applyBtn.textContent = t('settings.evolution.applying');
              var r = await fetch('/api/v1/evolution/apply', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(report),
              });
              if (!r.ok) throw new Error('Apply failed');
              var res = await r.json();
              if (res.success) {
                applyBtn.textContent = t('settings.evolution.applied');
                applyBtn.disabled = true;
                ToastManager.getInstance().success(t('settings.evolution.skillsArchived'));
              } else { throw new Error(res.error || 'Apply failed'); }
            } catch (e) {
              applyBtn.textContent = t('settings.evolution.applySkillArchives');
              ToastManager.getInstance().error(t('settings.evolution.applyFailed'));
            }
          });
          var note = document.createElement('span');
          note.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.3);';
          note.textContent = t('settings.evolution.archiveNote');
          applyDiv.appendChild(applyBtn);
          applyDiv.appendChild(note);
          results.appendChild(applyDiv);
        }

        ToastManager.getInstance().success(t('settings.evolution.toast', { total: report.summary.totalFindings }));
      } catch (err) {
        status.textContent = t('settings.evolution.failed');
        results.style.display = 'block';
        results.innerHTML = `<span style="color:var(--color-error);">${t('settings.evolution.errorPrefix')}: ${(err as Error).message}</span>`;
      }
    });
  }

}
