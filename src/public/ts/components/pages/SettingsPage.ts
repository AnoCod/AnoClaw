/**
 * AnoClaw Cinema — Settings Page
 * Appearance, display, context, and data management in cinema form style.
 */

import { App } from '../../app.js';
import type { Page, AppSettings } from '../../types.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { ClientLogger } from '../../ClientLogger.js';
import { ToastManager } from '../../ToastManager.js';
import { Toggle } from '../ui/Toggle.js';

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
            <div class="evo-stat-label">Tools Tracked</div>
          </div>
          <div class="evo-stat-card">
            <div class="evo-stat-value">${data.patterns.total}</div>
            <div class="evo-stat-label">Patterns Found</div>
          </div>
          <div class="evo-stat-card">
            <div class="evo-stat-value">${data.scores.totalScores}</div>
            <div class="evo-stat-label">Scores Collected</div>
          </div>
          <div class="evo-stat-card">
            <div class="evo-stat-value">${data.tags.totalPairs}</div>
            <div class="evo-stat-label">Tags Applied</div>
          </div>
          <div class="evo-stat-card">
            <div class="evo-stat-value">${data.tags.uniqueLabels}</div>
            <div class="evo-stat-label">Unique Tags</div>
          </div>
          <div class="evo-stat-card">
            <div class="evo-stat-value">${data.skills.tracked}</div>
            <div class="evo-stat-label">Skills Tracked</div>
          </div>
        `;
      }

      // Tool table
      const toolsEl = el('#evo-tools');
      if (toolsEl && data.tools.length > 0) {
        let th = '<table class="evo-tool-table"><thead><tr><th>Tool</th><th>Calls</th><th>Success</th><th>Avg Tokens</th><th>Avg ms</th></tr></thead><tbody>';
        for (const t of data.tools) {
          const pct = Math.round(t.successRate * 100);
          th += `<tr><td>${t.name}</td><td>${t.callCount}</td><td>${pct}%</td><td>${t.avgTokens}</td><td>${t.avgDurationMs}</td></tr>`;
        }
        th += '</tbody></table>';
        toolsEl.innerHTML = th;
      } else if (toolsEl) {
        toolsEl.innerHTML = '<div class="evo-empty">No tool data yet — start using tools to see stats.</div>';
      }

      // Patterns
      const patEl = el('#evo-patterns');
      if (patEl) {
        const p = data.patterns;
        if (p.total === 0) {
          patEl.innerHTML = '<div class="evo-empty">No patterns detected yet.</div>';
        } else {
          patEl.innerHTML = `<div style="font-size:11px;color:var(--color-cinema-text-secondary);">${p.total} total · ${p.skillCandidates} ready for skill creation · ${p.withSkills} linked to skills</div>`;
        }
      }

      // Scores
      const scrEl = el('#evo-scores');
      if (scrEl) {
        const s = data.scores;
        if (s.totalScores === 0) {
          scrEl.innerHTML = '<div class="evo-empty">No quality scores yet — rate messages using the ★ widget.</div>';
        } else {
          const agentCount = Object.keys(s.byAgent).length;
          scrEl.innerHTML = `<div style="font-size:11px;color:var(--color-cinema-text-secondary);">Global avg: <strong>${s.globalAvg.toFixed(2)}</strong> / 5 across ${s.totalScores} ratings · ${agentCount} agents</div>`;
        }
      }

      // Tags
      const tagEl = el('#evo-tags');
      if (tagEl) {
        const t = data.tags;
        if (t.totalPairs === 0) {
          tagEl.innerHTML = '<div class="evo-empty">No tags yet — tags appear automatically as you use the app.</div>';
        } else {
          const chips = (t.labels as string[]).slice(0, 10).map((l: string) =>
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

    form.innerHTML = `
      <div class="cinema-section">
        <div class="cinema-section-legend">Appearance</div>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div>
            <div style="font-size:10px;color:var(--color-cinema-text-muted);letter-spacing:1px;margin-bottom:8px;">Theme</div>
            <span id="appearance-theme"></span>
          </div>
          <div>
            <div style="font-size:10px;color:var(--color-cinema-text-muted);letter-spacing:1px;margin-bottom:8px;">Accent</div>
            <span id="appearance-accent"></span>
          </div>
        </div>
      </div>

      <div class="cinema-section">
        <div class="cinema-section-legend">Display</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <label style="display:flex;align-items:center;justify-content:space-between;">
            <span style="font-size:12px;color:var(--color-cinema-text-secondary);">Show thinking cards</span>
            <span id="toggle-think"></span>
          </label>
          <label style="display:flex;align-items:center;justify-content:space-between;">
            <span style="font-size:12px;color:var(--color-cinema-text-secondary);">Show tool cards</span>
            <span id="toggle-tool"></span>
          </label>
        </div>
      </div>

      <div class="cinema-section">
        <div class="cinema-section-legend">Context</div>
        <div style="display:flex;flex-direction:column;gap:4px;">
          <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--color-cinema-text-muted);">
            <span>Compaction Threshold</span>
            <span id="compaction-val">${s.compactionThreshold}%</span>
          </div>
          <input type="range" name="compactionThreshold" min="30" max="90" value="${s.compactionThreshold}" step="5"
            style="width:100%;accent-color:var(--color-accent-cinema);"
            oninput="document.getElementById('compaction-val').textContent=this.value+'%'">
        </div>
      </div>

      <div class="cinema-section">
        <div class="cinema-section-legend">Data</div>
        <div style="display:flex;gap:8px;">
          <button type="button" id="btn-export" class="cinema-btn">Export Settings</button>
          <button type="button" id="btn-clear" class="cinema-btn">Clear All Sessions</button>
        </div>
      </div>

      <div class="cinema-section">
        <div class="cinema-section-legend">Evolution</div>
        <div style="display:flex;flex-direction:column;gap:4px;">
          <div id="evo-stats" class="evo-stats-grid">
            <div class="evo-stat-card">
              <div class="evo-stat-value"><span class="evo-spinner"></span></div>
              <div class="evo-stat-label">Loading...</div>
            </div>
          </div>

          <div class="evo-section-title">Tool Usage</div>
          <div id="evo-tools"><div class="evo-empty">Loading...</div></div>

          <div class="evo-section-title">Patterns</div>
          <div id="evo-patterns"><div class="evo-empty">Loading...</div></div>

          <div class="evo-section-title">Quality Scores</div>
          <div id="evo-scores"><div class="evo-empty">Loading...</div></div>

          <div class="evo-section-title">Session Tags</div>
          <div id="evo-tags"><div class="evo-empty">Loading...</div></div>

          <div style="display:flex;gap:8px;align-items:center;margin-top:8px;">
            <button type="button" id="btn-evolve" class="cinema-btn">🔬 Review Evolution</button>
            <span id="evolve-status" style="font-size:11px;color:var(--color-cinema-text-tertiary);">Deep analysis — runs pattern + score + memory audit</span>
          </div>
          <div id="evolve-results" style="display:none;font-size:11px;color:var(--color-cinema-text-secondary);line-height:1.6;"></div>
        </div>
      </div>

      <div style="display:flex;justify-content:flex-end;padding-top:8px;">
        <button type="submit" class="cinema-btn cinema-btn-primary">Save Settings</button>
      </div>
    `;

    // Slot: settings-bottom
    const bottomSlot = document.createElement('div');
    bottomSlot.setAttribute('data-slot', 'settings-bottom');
    form.appendChild(bottomSlot);

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

      themeCards.appendChild(buildThemeCard('dark', 'Dark'));
      themeCards.appendChild(buildThemeCard('light', 'Light'));
      themeSlot.replaceWith(themeCards);
    }

    // ── Appearance: accent swatches ──
    const ACCENTS = [
      { value: '#da291c', label: 'Red' },
      { value: '#ffffff', label: 'White' },
      { value: '#0984E3', label: 'Blue' },
      { value: '#00B894', label: 'Green' },
      { value: '#7c3aed', label: 'Purple' },
      { value: '#E17055', label: 'Orange' },
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
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      console.log('[Settings] form submit — theme:', currentTheme, 'accent:', currentAccent);
      const fd = new FormData(form);
      const patch: Partial<AppSettings> = {
        theme: currentTheme,
        accentColor: currentAccent,
        showThinkCards: thinkToggle.checked,
        showToolCards: toolToggle.checked,
        compactionThreshold: parseInt(fd.get('compactionThreshold') as string),
      };
      app.updateSettings(patch);
      ToastManager.getInstance().success('Settings saved');
      ClientLogger.ui.info('Settings saved');
    });

    form.querySelector('#btn-export')?.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(app.settings, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'anoclaw-settings.json';
      a.click(); URL.revokeObjectURL(url);
    });

    form.querySelector('#btn-clear')?.addEventListener('click', async () => {
      const ok = await ConfirmDialog.show('This will permanently delete all sessions. This cannot be undone.', 'Clear All Sessions');
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

      status.textContent = 'Analyzing...';
      results.style.display = 'none';

      try {
        const resp = await fetch('/api/v1/evolution/analyze', { method: 'POST' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const report = await resp.json();

        status.textContent = `Analysis complete — ${report.summary.totalFindings} findings (${report.summary.criticalFindings} critical)`;
        results.style.display = 'block';

        let html = '';
        if (report.skillChanges.length > 0) {
          html += `<div style="margin-top:4px;"><strong>Skills:</strong> `;
          html += report.skillChanges.map((c: any) =>
            `${c.skillId} → ${c.action}${c.reason ? ': ' + c.reason.slice(0, 60) : ''}`
          ).join('<br>');
          html += '</div>';
        }
        if (report.memoryFindings.length > 0) {
          html += `<div style="margin-top:4px;"><strong>Memory:</strong> `;
          html += report.memoryFindings.map((m: any) =>
            `${m.memoryId} → ${m.action}`
          ).join('<br>');
          html += '</div>';
        }
        if (report.tokenFindings.length > 0) {
          html += `<div style="margin-top:4px;"><strong>Token waste:</strong> `;
          html += report.tokenFindings.map((t: any) =>
            `${t.toolName}: ~${t.estimatedSavings} tokens savings`
          ).join('<br>');
          html += '</div>';
        }
        if (report.promptSuggestions.length > 0) {
          html += `<div style="margin-top:4px;"><strong>Prompt tweaks suggested for:</strong> `;
          html += report.promptSuggestions.map((p: any) =>
            `${p.agentId} — ${p.reason.slice(0, 60)}`
          ).join('<br>');
          html += '</div>';
        }
        if (!html) html = '<em>No actionable findings — system is healthy.</em>';
        results.innerHTML = html;

        // Apply button for skill archives
        if (report.skillChanges && report.skillChanges.some(function (c: any) { return c.action === 'archive'; })) {
          const applyDiv = document.createElement('div');
          applyDiv.style.cssText = 'margin-top:8px;display:flex;gap:8px;align-items:center;';
          var applyBtn = document.createElement('button');
          applyBtn.type = 'button';
          applyBtn.className = 'cinema-btn';
          applyBtn.style.cssText = 'border-color:var(--color-accent);color:var(--color-accent);';
          applyBtn.textContent = 'Apply Skill Archives';
          applyBtn.addEventListener('click', async function () {
            try {
              applyBtn.textContent = 'Applying...';
              var r = await fetch('/api/v1/evolution/apply', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(report),
              });
              if (!r.ok) throw new Error('Apply failed');
              var res = await r.json();
              if (res.success) {
                applyBtn.textContent = 'OK Applied';
                applyBtn.disabled = true;
                ToastManager.getInstance().success('Skills archived');
              } else { throw new Error(res.error || 'Apply failed'); }
            } catch (e) {
              applyBtn.textContent = 'Apply Skill Archives';
              ToastManager.getInstance().error('Apply failed');
            }
          });
          var note = document.createElement('span');
          note.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.3);';
          note.textContent = 'Archives stale skills to skills/.archived/';
          applyDiv.appendChild(applyBtn);
          applyDiv.appendChild(note);
          results.appendChild(applyDiv);
        }

        ToastManager.getInstance().success('Evolution analysis: ' + report.summary.totalFindings + ' findings');
      } catch (err) {
        status.textContent = 'Analysis failed';
        results.style.display = 'block';
        results.innerHTML = `<span style="color:var(--color-error);">Error: ${(err as Error).message}</span>`;
      }
    });
  }

}
