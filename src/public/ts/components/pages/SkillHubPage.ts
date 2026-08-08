/**
 * AnoClaw Cinema — Skills & Tools (merged page)
 *
 * One page, three sections, following the DESIGN.md principles:
 *  - tokens: colors/radius/elevation come from the app CSS variables
 *  - layout: single column, sections in a fixed order (skills → MCP → ecosystem)
 *  - components: one compact row pattern reused across all sections
 *  - do/don't: status is explicit, destructive actions are confirm-gated
 *
 * Replaces the former SkillsPage, MCP plugin page, and EcosystemPage.
 */

import type { Page } from '../../types.js';
import { ClientLogger } from '../../ClientLogger.js';
import { Button } from '../ui/Button.js';
import { Toggle } from '../ui/Toggle.js';
import { Dialog } from '../ui/Dialog.js';
import { onLocaleChange, t } from '../../i18n/index.js';

interface SkillEntry {
  id: string;
  name: string;
  description: string;
  content: string;
  source: string;
  enabled: boolean;
}

interface McpServerView {
  id: string;
  name: string;
  transport: string;
  command?: string;
  url?: string;
  connected: boolean;
  connecting?: boolean;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
}

interface EcoEntryView {
  id: string;
  kind: string;
  assetType: string;
  name: string;
  displayName: string;
  sourcePath: string;
  supportLevel: string;
  detail?: string;
  warnings?: string[];
  status: string;
  enabled: boolean;
  trusted: boolean;
  errorMessage?: string;
}

const TOKENS = {
  textPrimary: 'var(--text-primary, #e8eaf0)',
  textSecondary: 'var(--text-secondary, #8b93a7)',
  textTertiary: 'var(--text-tertiary, #5d6472)',
  hairline: 'var(--hairline, rgba(255,255,255,.08))',
  surface: 'var(--surface-2, rgba(255,255,255,.03))',
  radius: '8px',
  radiusSm: '6px',
  success: '#34d399',
  warning: '#fbbf24',
  danger: '#f87171',
  accent: '#a5b4fc',
};

function badge(text: string, color: string, bg: string): HTMLElement {
  const el = document.createElement('span');
  el.style.cssText = `font-size:10px;padding:1px 6px;border-radius:99px;background:${bg};color:${color};white-space:nowrap;`;
  el.textContent = text;
  return el;
}

function levelColor(level: string): string {
  switch (level) {
    case 'native': return TOKENS.success;
    case 'bridge': return TOKENS.warning;
    case 'partial': return '#f97316';
    default: return TOKENS.danger;
  }
}

export class SkillHubPage implements Page {
  name = 'skills';
  container: HTMLElement;
  private _summaryEl!: HTMLElement;
  private _kickerEl!: HTMLElement;
  private _skillsHeadEl!: HTMLElement;
  private _mcpHeadEl!: HTMLElement;
  private _ecoHeadEl!: HTMLElement;
  private _skillsEl!: HTMLElement;
  private _mcpEl!: HTMLElement;
  private _ecoEl!: HTMLElement;
  private _skills: SkillEntry[] = [];
  private _mcpServers: McpServerView[] = [];
  private _ecoEntries: EcoEntryView[] = [];
  private _timer: number | null = null;
  private _modalOverlay: Dialog | null = null;
  private _activeTab: 'skills' | 'mcp' | 'ecosystem' = 'skills';
  private _tabSkillsEl!: HTMLElement;
  private _tabMcpEl!: HTMLElement;
  private _tabEcoEl!: HTMLElement;

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'cinema-static-page';
    this.container.setAttribute('data-page', 'skills');
    this.container.style.display = 'none';
    this.container.innerHTML = '<div class="cinema-static-inner" id="hub-inner"></div>';
    const inner = this.container.querySelector('#hub-inner')!;

    // Shared form tokens (hub-input / hub-textarea).
    const style = document.createElement('style');
    style.textContent = [
      '.hub-input,.hub-textarea{background:transparent;border:1px solid var(--hairline,rgba(255,255,255,.08));border-radius:6px;color:var(--text-primary,#e8eaf0);padding:7px 9px;font-size:12px;outline:none;width:100%;box-sizing:border-box;font-family:var(--font-sans,system-ui);}',
      '.hub-input:focus,.hub-textarea:focus{border-color:rgba(165,180,252,.45);}',
      '.hub-textarea{font-family:var(--font-mono,ui-monospace);resize:vertical;}',
    ].join('');
    document.head?.appendChild(style);

    // ── Header ───────────────────────────────────────────────
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:2px 2px 12px;';
    const titleGroup = document.createElement('div');
    const kicker = document.createElement('div');
    kicker.className = 'hub-kicker';
    kicker.style.cssText = 'font-size:12px;font-weight:600;letter-spacing:.4px;color:var(--text-secondary,#8b93a7);';
    kicker.textContent = t('hub.kicker');
    this._kickerEl = kicker;
    titleGroup.appendChild(kicker);
    this._summaryEl = document.createElement('div');
    this._summaryEl.className = 'hub-summary';
    this._summaryEl.style.cssText = 'font-size:20px;font-weight:650;color:var(--text-primary,#e8eaf0);margin-top:2px;';
    titleGroup.appendChild(this._summaryEl);
    header.appendChild(titleGroup);
    inner.appendChild(header);

    // ── Tabs ─────────────────────────────────────────────────
    const tabBar = document.createElement('div');
    tabBar.style.cssText = `display:flex;gap:2px;border-bottom:1px solid ${TOKENS.hairline};`;
    this._tabSkillsEl = this._makeTab(t('hub.section.skills'), 'skills');
    this._tabMcpEl = this._makeTab(t('hub.section.mcp'), 'mcp');
    this._tabEcoEl = this._makeTab(t('hub.section.ecosystem'), 'ecosystem');
    tabBar.appendChild(this._tabSkillsEl);
    tabBar.appendChild(this._tabMcpEl);
    tabBar.appendChild(this._tabEcoEl);
    inner.appendChild(tabBar);

    // ── Skills ───────────────────────────────────────────────
    const skillsHead = this._sectionHeading(t('hub.section.skills'));
    this._skillsHeadEl = skillsHead.querySelector('span')!;
    const createBtn = new Button({ label: t('skills.create'), variant: 'default', size: 'sm', onClick: () => this._showSkillEditor(null) });
    const importBtn = new Button({ label: t('skills.import'), variant: 'default', size: 'sm', onClick: () => this._showSkillImport() });
    skillsHead.appendChild(createBtn.element);
    skillsHead.appendChild(importBtn.element);
    inner.appendChild(skillsHead);
    this._skillsEl = document.createElement('div');
    this._skillsEl.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    inner.appendChild(this._skillsEl);

    // ── MCP servers ──────────────────────────────────────────
    const mcpHead = this._sectionHeading(t('hub.section.mcp'));
    this._mcpHeadEl = mcpHead.querySelector('span')!;
    const mcpAdd = new Button({ label: t('hub.mcpAdd'), variant: 'default', size: 'sm', onClick: () => this._showMcpEditor(null) });
    mcpHead.appendChild(mcpAdd.element);
    inner.appendChild(mcpHead);
    this._mcpEl = document.createElement('div');
    this._mcpEl.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    inner.appendChild(this._mcpEl);

    // ── Ecosystem ────────────────────────────────────────────
    const ecoHead = this._sectionHeading(t('hub.section.ecosystem'));
    this._ecoHeadEl = ecoHead.querySelector('span')!;
    const scanBtn = new Button({ label: t('hub.scan'), variant: 'default', size: 'sm', onClick: () => { void this._scanEcosystem(); } });
    const syncBtn = new Button({ label: t('hub.sync'), variant: 'default', size: 'sm', onClick: () => { void this._syncEcosystem(); } });
    ecoHead.appendChild(scanBtn.element);
    ecoHead.appendChild(syncBtn.element);
    inner.appendChild(ecoHead);
    this._ecoEl = document.createElement('div');
    this._ecoEl.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    inner.appendChild(this._ecoEl);

    this._switchTab('skills');

    onLocaleChange(() => this._renderAll());
  }

  onEnter(): void {
    void this._loadAll();
    this._timer = window.setInterval(() => { void this._loadMcp(); }, 5000);
  }

  onExit(): void {
    if (this._timer !== null) { window.clearInterval(this._timer); this._timer = null; }
  }

  // ── Data loading ───────────────────────────────────────────

  private async _loadAll(): Promise<void> {
    await Promise.all([this._loadSkills(), this._loadMcp(), this._loadEcosystem()]);
    this._renderAll();
  }

  private async _loadSkills(): Promise<void> {
    try {
      const r = await fetch('/api/v1/skills');
      const data = r.ok ? (await r.json()) as { skills: SkillEntry[] } : { skills: [] };
      this._skills = data.skills ?? [];
    } catch {
      this._skills = [];
    }
  }

  private async _loadMcp(): Promise<void> {
    try {
      const r = await fetch('/api/v1/mcp/servers');
      const data = r.ok ? (await r.json()) as { servers: McpServerView[] } : { servers: [] };
      this._mcpServers = data.servers ?? [];
    } catch {
      this._mcpServers = [];
    }
    this._renderMcp();
  }

  private async _loadEcosystem(): Promise<void> {
    try {
      const r = await fetch('/api/v1/ecosystem/scan');
      const data = r.ok ? (await r.json()) as { entries: EcoEntryView[] } : { entries: [] };
      this._ecoEntries = data.entries ?? [];
    } catch {
      this._ecoEntries = [];
    }
  }

  private async _scanEcosystem(): Promise<void> {
    await this._loadEcosystem();
    this._renderEcosystem();
  }

  private async _syncEcosystem(): Promise<void> {
    try {
      await fetch('/api/v1/ecosystem/sync', { method: 'POST' });
    } catch (err) {
      ClientLogger.app.error('Ecosystem sync failed', { error: (err as Error).message });
    }
    await this._loadAll();
  }

  // ── Rendering ──────────────────────────────────────────────

  private _renderAll(): void {
    this._kickerEl.textContent = t('hub.kicker');
    this._tabSkillsEl.textContent = t('hub.section.skills');
    this._tabMcpEl.textContent = t('hub.section.mcp');
    this._tabEcoEl.textContent = t('hub.section.ecosystem');
    this._skillsHeadEl.textContent = t('hub.section.skills');
    this._mcpHeadEl.textContent = t('hub.section.mcp');
    this._ecoHeadEl.textContent = t('hub.section.ecosystem');
    this._renderSkills();
    this._renderMcp();
    this._renderEcosystem();
    const total = this._skills.length + this._mcpServers.length + this._ecoEntries.length;
    this._summaryEl.textContent = t('hub.summary', { total });
  }

  private _sectionHeading(label: string): HTMLElement {
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 2px 8px;';
    const title = document.createElement('span');
    title.style.cssText = 'font-size:13px;font-weight:650;color:var(--text-primary,#e8eaf0);letter-spacing:.2px;';
    title.textContent = label;
    head.appendChild(title);
    return head;
  }

  private _makeTab(label: string, tab: 'skills' | 'mcp' | 'ecosystem'): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.style.cssText = [
      'flex:1;background:transparent;border:none;border-bottom:2px solid transparent;',
      'padding:8px 10px;font-size:12px;font-weight:600;color:var(--text-secondary,#8b93a7);',
      'cursor:pointer;font-family:var(--font-sans,system-ui);',
    ].join('');
    el.textContent = label;
    el.addEventListener('click', () => this._switchTab(tab));
    return el;
  }

  private _switchTab(tab: 'skills' | 'mcp' | 'ecosystem'): void {
    this._activeTab = tab;
    this._styleTab(this._tabSkillsEl, tab === 'skills');
    this._styleTab(this._tabMcpEl, tab === 'mcp');
    this._styleTab(this._tabEcoEl, tab === 'ecosystem');
    this._skillsEl.style.display = tab === 'skills' ? 'flex' : 'none';
    this._mcpEl.style.display = tab === 'mcp' ? 'flex' : 'none';
    this._ecoEl.style.display = tab === 'ecosystem' ? 'flex' : 'none';
    this._skillsHeadEl.parentElement!.style.display = tab === 'skills' ? 'flex' : 'none';
    this._mcpHeadEl.parentElement!.style.display = tab === 'mcp' ? 'flex' : 'none';
    this._ecoHeadEl.parentElement!.style.display = tab === 'ecosystem' ? 'flex' : 'none';
  }

  private _styleTab(el: HTMLElement, active: boolean): void {
    el.style.color = active ? 'var(--text-primary,#e8eaf0)' : 'var(--text-secondary,#8b93a7)';
    el.style.borderBottomColor = active ? 'rgba(165,180,252,.75)' : 'transparent';
  }

  private _emptyRow(message: string): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = `font-size:12px;color:${TOKENS.textTertiary};padding:14px 10px;border:1px dashed ${TOKENS.hairline};border-radius:${TOKENS.radius};`;
    el.textContent = message;
    return el;
  }

  private _renderSkills(): void {
    this._skillsEl.innerHTML = '';
    if (this._skills.length === 0) {
      this._skillsEl.appendChild(this._emptyRow(t('hub.skillsEmpty')));
      return;
    }
    for (const skill of this._skills) {
      const row = this._row();
      const sourceBadge = badge(skill.source, TOKENS.textSecondary, 'rgba(139,147,167,.12)');
      const main = this._main(`${skill.name}`, skill.description || t('common.noDescription'), [sourceBadge]);
      row.appendChild(main);

      const toggle = new Toggle({ checked: skill.enabled, onChange: (v) => { void this._toggleSkill(skill, v); } });
      row.appendChild(toggle.element);
      const edit = new Button({ label: t('common.edit'), variant: 'default', size: 'sm', onClick: () => this._showSkillEditor(skill) });
      row.appendChild(edit.element);
      this._skillsEl.appendChild(row);
    }
  }

  private _renderMcp(): void {
    this._mcpEl.innerHTML = '';
    if (this._mcpServers.length === 0) {
      this._mcpEl.appendChild(this._emptyRow(t('hub.mcpEmpty')));
      return;
    }
    for (const server of this._mcpServers) {
      const row = this._row();
      const dot = document.createElement('span');
      dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${server.connected ? TOKENS.success : TOKENS.textTertiary};display:inline-block;`;
      const transportBadge = badge(server.transport.toUpperCase(), TOKENS.accent, 'rgba(165,180,252,.14)');
      const statusBadge = badge(
        server.connected ? `${t('hub.mcpConnected')} · ${server.toolCount} ${t('hub.mcpTools')}` : t('hub.mcpDisconnected'),
        server.connected ? TOKENS.success : TOKENS.textSecondary,
        server.connected ? 'rgba(52,211,153,.12)' : 'rgba(139,147,167,.12)',
      );
      const main = this._main(server.name, server.command || server.url || '', [dot, transportBadge, statusBadge]);
      row.appendChild(main);

      const reconnect = new Button({
        label: t('hub.mcpReconnect'), variant: 'default', size: 'sm',
        onClick: () => { void this._reconnectMcp(server.id); },
      });
      row.appendChild(reconnect.element);
      const edit = new Button({
        label: t('common.edit'), variant: 'default', size: 'sm',
        onClick: () => this._showMcpEditor(server),
      });
      row.appendChild(edit.element);
      const del = new Button({
        label: '×', variant: 'default', size: 'sm',
        onClick: () => { void this._deleteMcp(server); },
      });
      del.element.title = t('common.delete');
      row.appendChild(del.element);
      this._mcpEl.appendChild(row);
    }
  }

  private _renderEcosystem(): void {
    this._ecoEl.innerHTML = '';
    if (this._ecoEntries.length === 0) {
      this._ecoEl.appendChild(this._emptyRow(t('hub.ecoEmpty')));
      return;
    }
    const ordered = [...this._ecoEntries].sort((a, b) => a.kind.localeCompare(b.kind) || a.assetType.localeCompare(b.assetType));
    for (const entry of ordered) {
      const row = this._row();
      const badges = [
        badge(entry.kind, TOKENS.textSecondary, 'rgba(139,147,167,.12)'),
        badge(entry.assetType, TOKENS.accent, 'rgba(165,180,252,.14)'),
        badge(entry.supportLevel, levelColor(entry.supportLevel), `${levelColor(entry.supportLevel)}22`),
      ];
      if (entry.assetType === 'plugin' && !entry.trusted) {
        badges.push(badge(t('hub.untrusted'), TOKENS.danger, 'rgba(248,113,113,.14)'));
      }
      const main = this._main(entry.displayName || entry.name, entry.sourcePath, badges);
      const warnings = [...(entry.warnings ?? [])];
      if (entry.errorMessage) warnings.unshift(entry.errorMessage);
      if (warnings.length > 0) {
        const warn = document.createElement('div');
        warn.style.cssText = `font-size:11px;color:${TOKENS.warning};margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
        warn.textContent = warnings.join(' · ');
        warn.title = warnings.join('\n');
        main.appendChild(warn);
      }
      row.appendChild(main);

      if (entry.assetType === 'plugin' && !entry.trusted && (entry.supportLevel === 'bridge' || entry.supportLevel === 'partial')) {
        const trust = new Button({ label: t('hub.trust'), variant: 'default', size: 'sm', onClick: () => { void this._trustEco(entry); } });
        row.appendChild(trust.element);
      }
      const toggle = new Toggle({ checked: entry.enabled, onChange: (v) => { void this._toggleEco(entry, v); } });
      row.appendChild(toggle.element);
      const forget = new Button({ label: '×', variant: 'default', size: 'sm', onClick: () => { void this._forgetEco(entry); } });
      forget.element.title = t('hub.forget');
      row.appendChild(forget.element);
      this._ecoEl.appendChild(row);
    }
  }

  private _row(): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = `display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid ${TOKENS.hairline};border-radius:${TOKENS.radius};background:${TOKENS.surface};`;
    return row;
  }

  private _main(name: string, sub: string, metaChildren: HTMLElement[] = []): HTMLElement {
    const main = document.createElement('div');
    main.style.cssText = 'flex:1;min-width:0;';
    const nameEl = document.createElement('div');
    nameEl.className = 'hub-name';
    nameEl.style.cssText = `font-size:13px;font-weight:600;color:${TOKENS.textPrimary};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
    nameEl.textContent = name;
    const meta = document.createElement('div');
    meta.className = 'hub-meta';
    meta.style.cssText = `display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px;`;
    main.appendChild(nameEl);
    main.appendChild(meta);
    for (const child of metaChildren) meta.appendChild(child);
    if (sub) {
      const subEl = document.createElement('div');
      subEl.style.cssText = `font-size:11px;color:${TOKENS.textTertiary};margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
      subEl.textContent = sub;
      main.appendChild(subEl);
    }
    return main;
  }

  // ── Actions: skills ────────────────────────────────────────

  private async _toggleSkill(skill: SkillEntry, enabled: boolean): Promise<void> {
    try {
      skill.enabled = enabled;
      await fetch(`/api/v1/skills/${skill.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
    } catch (err) {
      ClientLogger.app.error('Skill toggle failed', { error: (err as Error).message });
    }
  }

  private _showSkillEditor(skill: SkillEntry | null): void {
    this._closeModal();
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
    const nameInput = document.createElement('input');
    nameInput.placeholder = t('skills.namePlaceholder');
    nameInput.value = skill?.name || '';
    nameInput.className = 'hub-input';
    const descInput = document.createElement('input');
    descInput.placeholder = t('skills.descriptionPlaceholder');
    descInput.value = skill?.description || '';
    descInput.className = 'hub-input';
    const contentTa = document.createElement('textarea');
    contentTa.placeholder = t('skills.contentPlaceholder');
    contentTa.rows = 12;
    contentTa.value = skill?.content || '';
    contentTa.className = 'hub-textarea';
    body.appendChild(nameInput);
    body.appendChild(descInput);
    body.appendChild(contentTa);

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
    const cancel = new Button({ label: t('common.cancel'), variant: 'default', onClick: () => this._closeModal() });
    const save = new Button({
      label: t('common.save'), variant: 'primary',
      onClick: () => {
        const n = nameInput.value.trim();
        if (!n) return;
        if (skill) {
          void this._updateSkill(skill.id, n, descInput.value.trim(), contentTa.value);
        } else {
          void this._createSkill(n, descInput.value.trim(), contentTa.value);
        }
        this._closeModal();
      },
    });
    footer.appendChild(cancel.element);
    footer.appendChild(save.element);

    const dlg = new Dialog({
      title: skill ? t('skills.editTitle') : t('skills.createTitle'),
      body,
      footer,
      onClose: () => this._closeModal(),
    });
    this._modalOverlay = dlg;
    dlg.show();
    setTimeout(() => nameInput.focus(), 100);
  }

  private _showSkillImport(): void {
    this._closeModal();
    const body = document.createElement('div');
    const hint = document.createElement('p');
    hint.style.cssText = `font-size:11px;color:${TOKENS.textSecondary};margin-bottom:12px;`;
    hint.textContent = t('hub.importHint');
    body.appendChild(hint);
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.md';
    body.appendChild(fileInput);
    const status = document.createElement('p');
    status.style.cssText = `font-size:11px;margin-top:8px;color:${TOKENS.textSecondary};`;
    body.appendChild(status);

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;justify-content:flex-end;';
    const cancel = new Button({ label: t('common.cancel'), variant: 'default', onClick: () => this._closeModal() });
    footer.appendChild(cancel.element);
    const dlg = new Dialog({
      title: t('skills.importTitle'),
      body,
      footer,
      onClose: () => this._closeModal(),
    });
    this._modalOverlay = dlg;
    dlg.show();

    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      try {
        const text = await f.text();
        const fm = text.match(/^---\n([\s\S]*?)\n---/);
        let n = f.name.replace(/\.md$/, '');
        let d = '';
        let c = text;
        if (fm) {
          for (const ln of fm[1].split('\n')) {
            const kv = ln.match(/^(\w+):\s*(.+)/);
            if (kv) {
              if (kv[1] === 'name') n = kv[2].trim().replace(/^"(.*)"$/, '$1');
              if (kv[1] === 'description') d = kv[2].trim().replace(/^"(.*)"$/, '$1');
            }
          }
          c = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
        }
        await this._createSkill(n, d, c);
        status.textContent = t('skills.imported', { name: n });
        setTimeout(() => dlg.close(), 900);
      } catch {
        status.textContent = t('skills.importFailed');
      }
    });
  }

  private async _createSkill(n: string, d: string, c: string): Promise<void> {
    try {
      await fetch('/api/v1/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: n, description: d, content: c }),
      });
      await this._loadSkills();
      this._renderSkills();
    } catch (err) {
      ClientLogger.app.error('Skill create failed', { error: (err as Error).message });
    }
  }

  private async _updateSkill(id: string, n: string, d: string, c: string): Promise<void> {
    try {
      await fetch(`/api/v1/skills/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: n, description: d, content: c }),
      });
      await this._loadSkills();
      this._renderSkills();
    } catch (err) {
      ClientLogger.app.error('Skill update failed', { error: (err as Error).message });
    }
  }

  // ── Actions: MCP ───────────────────────────────────────────

  private _showMcpEditor(server: McpServerView | null): void {
    this._closeModal();
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
    const fields: Array<{ label: string; el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement }> = [];

    const name = this._field('Name', server?.name ?? '');
    const transport = document.createElement('select');
    transport.className = 'hub-input';
    for (const value of ['stdio', 'sse', 'http']) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value;
      transport.appendChild(opt);
    }
    transport.value = server?.transport ?? 'stdio';
    const command = this._field(t('hub.mcpCommand'), server?.command ?? '');
    const url = this._field(t('hub.mcpUrl'), server?.url ?? '');
    fields.push({ label: 'Name', el: name }, { label: 'Transport', el: transport }, { label: t('hub.mcpCommand'), el: command }, { label: t('hub.mcpUrl'), el: url });
    body.append(...fields.map((f) => {
      const wrap = document.createElement('div');
      const label = document.createElement('div');
      label.style.cssText = `font-size:11px;color:${TOKENS.textSecondary};margin-bottom:2px;`;
      label.textContent = f.label;
      wrap.appendChild(label);
      wrap.appendChild(f.el);
      return wrap;
    }));

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
    const cancel = new Button({ label: t('common.cancel'), variant: 'default', onClick: () => this._closeModal() });
    const save = new Button({
      label: t('common.save'), variant: 'primary',
      onClick: () => {
        const n = name.value.trim();
        if (!n) return;
        const payload = {
          name: n,
          transport: transport.value,
          command: command.value.trim() || undefined,
          url: url.value.trim() || undefined,
        };
        if (server) void this._updateMcp(server.id, payload);
        else void this._createMcp(payload);
        this._closeModal();
      },
    });
    footer.appendChild(cancel.element);
    footer.appendChild(save.element);
    const dlg = new Dialog({
      title: server ? t('hub.mcpEditTitle') : t('hub.mcpAddTitle'),
      body,
      footer,
      onClose: () => this._closeModal(),
    });
    this._modalOverlay = dlg;
    dlg.show();
    setTimeout(() => name.focus(), 100);
  }

  private _field(label: string, value: string): HTMLInputElement {
    const el = document.createElement('input');
    el.className = 'hub-input';
    el.placeholder = label;
    el.value = value;
    return el;
  }

  private async _createMcp(payload: Record<string, unknown>): Promise<void> {
    try {
      await fetch('/api/v1/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await this._loadMcp();
    } catch (err) {
      ClientLogger.app.error('MCP create failed', { error: (err as Error).message });
    }
  }

  private async _updateMcp(id: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await fetch(`/api/v1/mcp/servers/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await this._loadMcp();
    } catch (err) {
      ClientLogger.app.error('MCP update failed', { error: (err as Error).message });
    }
  }

  private async _reconnectMcp(id: string): Promise<void> {
    try {
      await fetch(`/api/v1/mcp/servers/${encodeURIComponent(id)}/reconnect`, { method: 'POST' });
      await this._loadMcp();
    } catch (err) {
      ClientLogger.app.error('MCP reconnect failed', { error: (err as Error).message });
    }
  }

  private async _deleteMcp(server: McpServerView): Promise<void> {
    if (!window.confirm(`${t('hub.mcpDeleteConfirm')} "${server.name}"?`)) return;
    try {
      await fetch(`/api/v1/mcp/servers/${encodeURIComponent(server.id)}`, { method: 'DELETE' });
      await this._loadMcp();
    } catch (err) {
      ClientLogger.app.error('MCP delete failed', { error: (err as Error).message });
    }
  }

  // ── Actions: ecosystem ─────────────────────────────────────

  private async _toggleEco(entry: EcoEntryView, enabled: boolean): Promise<void> {
    try {
      const url = enabled
        ? `/api/v1/ecosystem/entries/${encodeURIComponent(entry.id)}/enable`
        : `/api/v1/ecosystem/entries/${encodeURIComponent(entry.id)}/disable`;
      const r = await fetch(url, { method: 'POST' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
      }
      await this._loadEcosystem();
      this._renderEcosystem();
    } catch (err) {
      ClientLogger.app.error('Ecosystem toggle failed', { error: (err as Error).message });
      window.alert(String((err as Error).message));
    }
  }

  private async _trustEco(entry: EcoEntryView): Promise<void> {
    try {
      await fetch(`/api/v1/ecosystem/entries/${encodeURIComponent(entry.id)}/trust`, { method: 'POST' });
      await this._loadEcosystem();
      this._renderEcosystem();
    } catch (err) {
      ClientLogger.app.error('Ecosystem trust failed', { error: (err as Error).message });
    }
  }

  private async _forgetEco(entry: EcoEntryView): Promise<void> {
    if (!window.confirm(`${t('hub.forgetConfirm')} "${entry.displayName}"?`)) return;
    try {
      await fetch(`/api/v1/ecosystem/entries/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
      await this._loadEcosystem();
      this._renderEcosystem();
    } catch (err) {
      ClientLogger.app.error('Ecosystem forget failed', { error: (err as Error).message });
    }
  }

  private _closeModal(): void {
    this._modalOverlay = null;
  }
}
