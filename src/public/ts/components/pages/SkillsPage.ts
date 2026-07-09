/**
 * AnoClaw Cinema — Skills Page
 * Card grid with cinema toggle switches, editor modal, and Markdown import.
 */

import type { Page, SkillEntry } from '../../types.js';
import { App } from '../../app.js';
import { ClientLogger } from '../../ClientLogger.js';
import { Button } from '../ui/Button.js';
import { Dialog } from '../ui/Dialog.js';
import { Toggle } from '../ui/Toggle.js';

type SkillVisual = {
  tone: string;
  label: string;
  icon: string;
};

export class SkillsPage implements Page {
  name = 'skills';
  container: HTMLElement;
  private _gridEl!: HTMLElement;
  private _skills: SkillEntry[] = [];
  private _modalOverlay: HTMLElement | null = null;

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'cinema-static-page';
    this.container.setAttribute('data-page', 'skills');
    this.container.style.display = 'none';
    this.container.innerHTML = `<div class="cinema-static-inner" id="skills-inner"></div>`;

    const inner = this.container.querySelector('#skills-inner')!;
    // Header
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;';
    const title = document.createElement('span');
    title.style.cssText = 'font-size:13px;font-weight:500;color:var(--cinema-text-btn);';
    title.textContent = 'Skills';
    header.appendChild(title);
    const btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display:flex;gap:8px;';
    const createBtn = new Button({ label: '+ Create', variant: 'default', size: 'sm', onClick: () => this._showEditor(null) });
    const importBtn = new Button({ label: 'Import', variant: 'default', size: 'sm', onClick: () => this._showImportForm() });
    btnGroup.appendChild(createBtn.element);
    btnGroup.appendChild(importBtn.element);
    header.appendChild(btnGroup);
    inner.appendChild(header);

    this._gridEl = document.createElement('div');
    this._gridEl.className = 'cinema-card-grid';
    inner.appendChild(this._gridEl);

    // Auto-refresh on external skill changes (CEO creates/deletes via tool)
    const sse = App.getInstance().sseClient;
    sse.on('skill_changed', () => this._loadSkills());
  }

  onEnter(): void { this._loadSkills(); }
  onExit(): void {}

  private async _loadSkills(): Promise<void> {
    try {
      const r = await fetch('/api/v1/skills');
      if (r.ok) {
        const data = await r.json();
        this._skills = data.skills ?? [];
      } else {
        this._skills = [];
      }
    } catch {
      this._skills = [];
    }
    this._renderGrid();
  }

  private _renderGrid(): void {
    this._gridEl.innerHTML = '';
    if (!this._skills.length) {
      this._gridEl.innerHTML = '<div class="ui-empty" style="grid-column:1/-1;"><div class="ui-empty-title">No skills loaded</div><div class="ui-empty-desc">Create or import a skill to get started.</div></div>';
      return;
    }
    for (const sk of this._skills) this._gridEl.appendChild(this._buildCard(sk));
  }

  /** Cinema-styled row with type-aware icon, toggle, and description. */
  private _buildCard(skill: SkillEntry): HTMLElement {
    const visual = this._skillVisual(skill);
    const card = document.createElement('div');
    card.className = skill.enabled
      ? 'ui-card ui-card-interactive skill-row-card'
      : 'ui-card ui-card-interactive ui-card-disabled skill-row-card';
    card.setAttribute('data-skill-tone', visual.tone);

    // Top row: icon + name + toggle
    const top = document.createElement('div');
    top.className = 'skill-row-main';

    const icon = document.createElement('div');
    icon.className = 'skill-kind-icon';
    icon.innerHTML = visual.icon;
    top.appendChild(icon);

    const nameGroup = document.createElement('div');
    nameGroup.className = 'skill-row-title';
    const nameEl = document.createElement('div');
    nameEl.textContent = skill.name;
    nameEl.className = 'skill-row-name';
    nameGroup.appendChild(nameEl);
    const metaEl = document.createElement('div');
    metaEl.className = 'skill-row-meta';
    const kindEl = document.createElement('span');
    kindEl.className = 'skill-row-kind';
    kindEl.textContent = visual.label;
    metaEl.appendChild(kindEl);
    const stEl = document.createElement('span');
    stEl.className = 'skill-row-status';
    stEl.textContent = skill.enabled ? 'Enabled' : 'Disabled';
    metaEl.appendChild(stEl);
    nameGroup.appendChild(metaEl);
    top.appendChild(nameGroup);

    // Cinema toggle
    const toggle = new Toggle({ checked: skill.enabled });
    toggle.element.addEventListener('click', (e) => {
      e.stopPropagation();
      skill.enabled = !skill.enabled;
      this._toggleSkill(skill);
      toggle.checked = skill.enabled;
      stEl.textContent = skill.enabled ? 'Enabled' : 'Disabled';
      card.className = skill.enabled
        ? 'ui-card ui-card-interactive skill-row-card'
        : 'ui-card ui-card-interactive ui-card-disabled skill-row-card';
    });
    top.appendChild(toggle.element);
    card.appendChild(top);

    // Description
    const desc = document.createElement('p');
    desc.textContent = skill.description || 'No description';
    desc.className = 'skill-row-desc';
    card.appendChild(desc);

    // Edit button
    const editBtn = new Button({ label: 'Edit', variant: 'default', size: 'sm', onClick: () => { this._showEditor(skill); } });
    editBtn.element.classList.add('skill-row-edit');
    card.appendChild(editBtn.element);

    return card;
  }

  private _skillVisual(skill: SkillEntry): SkillVisual {
    const name = skill.name.toLowerCase();
    const text = `${skill.name} ${skill.description || ''}`.toLowerCase();
    const has = (terms: string[]) => terms.some(term => text.includes(term));

    if (name.includes('design')) {
      return { tone: 'design', label: 'Design', icon: this._iconDesign() };
    }
    if (name.includes('brainstorm') || name.includes('ideation')) {
      return { tone: 'idea', label: 'Idea', icon: this._iconIdea() };
    }
    if (name.includes('computer-use') || has(['desktop', 'local app', 'clicking', 'typing', 'scrolling'])) {
      return { tone: 'control', label: 'Control', icon: this._iconControl() };
    }
    if (has(['browser', 'web ', 'web-', 'screenshot', 'forms', 'page'])) {
      return { tone: 'browser', label: 'Browser', icon: this._iconBrowser() };
    }
    if (has(['data', 'csv', 'json', 'excel', 'analysis', 'python', 'statistics'])) {
      return { tone: 'data', label: 'Data', icon: this._iconData() };
    }
    if (has(['docx', 'document', 'pdf', 'word', 'presentation', 'spreadsheet', 'report'])) {
      return { tone: 'docs', label: 'Docs', icon: this._iconDocs() };
    }
    if (has(['brainstorm', 'ideation', 'requirements', 'planning']) || text.includes('user intent')) {
      return { tone: 'idea', label: 'Idea', icon: this._iconIdea() };
    }
    if (has(['design', 'creative', 'visual', 'interface', 'ui'])) {
      return { tone: 'design', label: 'Design', icon: this._iconDesign() };
    }
    if (has(['code', 'frontend', 'debug', 'review', 'security', 'merge', 'implementation', 'repo'])) {
      return { tone: 'code', label: 'Code', icon: this._iconCode() };
    }
    if (has(['test', 'qa', 'verification', 'audit'])) {
      return { tone: 'quality', label: 'Quality', icon: this._iconQuality() };
    }
    if (has(['memory', 'context', 'knowledge'])) {
      return { tone: 'memory', label: 'Memory', icon: this._iconMemory() };
    }
    return { tone: 'system', label: 'System', icon: this._iconSystem() };
  }

  private _svg(paths: string): string {
    return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">${paths}</svg>`;
  }

  private _iconBrowser(): string {
    return this._svg('<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M4 9h16"/><path d="M7 7h.01"/><path d="M10 7h.01"/>');
  }

  private _iconCode(): string {
    return this._svg('<path d="m8 9-4 3 4 3"/><path d="m16 9 4 3-4 3"/><path d="m14 5-4 14"/>');
  }

  private _iconControl(): string {
    return this._svg('<rect x="7" y="3.5" width="10" height="17" rx="5"/><path d="M12 7v4"/><path d="M8.5 16.5h7"/>');
  }

  private _iconData(): string {
    return this._svg('<ellipse cx="12" cy="6" rx="6.5" ry="3"/><path d="M5.5 6v6c0 1.7 2.9 3 6.5 3s6.5-1.3 6.5-3V6"/><path d="M5.5 12v6c0 1.7 2.9 3 6.5 3s6.5-1.3 6.5-3v-6"/>');
  }

  private _iconDocs(): string {
    return this._svg('<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9L14 3.5Z"/><path d="M14 3.5v5a1 1 0 0 0 1 1h4"/><path d="M8 13h8"/><path d="M8 17h6"/>');
  }

  private _iconIdea(): string {
    return this._svg('<path d="M9 18h6"/><path d="M10 21h4"/><path d="M8.6 14.5A6 6 0 1 1 15.4 14.5c-.8.7-1.2 1.4-1.2 2.5H9.8c0-1.1-.4-1.8-1.2-2.5Z"/>');
  }

  private _iconDesign(): string {
    return this._svg('<path d="M12 19.5 19.5 12l2 2L14 21.5h-2v-2Z"/><path d="m16 8 3 3"/><path d="M4 20c4-1 5.5-4 5.5-7.5"/><path d="M5 5h6v6H5z"/>');
  }

  private _iconQuality(): string {
    return this._svg('<circle cx="11" cy="11" r="6.5"/><path d="m15.5 15.5 4 4"/><path d="m8.5 11 1.8 1.8 3.7-4"/>');
  }

  private _iconMemory(): string {
    return this._svg('<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 3v3"/><path d="M15 3v3"/><path d="M9 18v3"/><path d="M15 18v3"/><path d="M3 9h3"/><path d="M3 15h3"/><path d="M18 9h3"/><path d="M18 15h3"/>');
  }

  private _iconSystem(): string {
    return this._svg('<circle cx="12" cy="12" r="3.2"/><path d="M12 4v3"/><path d="M12 17v3"/><path d="M4 12h3"/><path d="M17 12h3"/><path d="m6.3 6.3 2.1 2.1"/><path d="m15.6 15.6 2.1 2.1"/><path d="m17.7 6.3-2.1 2.1"/><path d="m8.4 15.6-2.1 2.1"/>');
  }

  // ── Modal (now uses shared Dialog component) ──

  private _showEditor(skill: SkillEntry | null): void {
    const isNew = !skill;
    this._closeModal();

    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
    const nameInput = document.createElement('input');
    nameInput.placeholder = 'Name';
    nameInput.style.cssText = 'background:transparent;border:none;border-bottom:1px solid var(--hairline-cinema);color:var(--cinema-text-primary);padding:8px 0;font-size:13px;outline:none;font-family:var(--font-sans);';
    nameInput.value = skill?.name || '';
    body.appendChild(nameInput);

    const descInput = document.createElement('input');
    descInput.placeholder = 'Description';
    descInput.style.cssText = 'background:transparent;border:none;border-bottom:1px solid var(--hairline-cinema);color:var(--cinema-text-primary);padding:8px 0;font-size:13px;outline:none;font-family:var(--font-sans);';
    descInput.value = skill?.description || '';
    body.appendChild(descInput);

    const contentTa = document.createElement('textarea');
    contentTa.placeholder = 'Content (Markdown)';
    contentTa.rows = 12;
    contentTa.style.cssText = 'background:transparent;border:none;border-bottom:1px solid var(--hairline-cinema);color:var(--cinema-text-primary);padding:8px 0;font-size:12px;outline:none;font-family:var(--font-mono);resize:vertical;';
    contentTa.value = skill?.content || '';
    body.appendChild(contentTa);

    const footer = document.createElement('div');
    const cancelBtn = new Button({ label: 'Cancel', variant: 'default', onClick: () => dlg.close() });
    const saveBtn = new Button({ label: 'Save', variant: 'primary', onClick: () => {
      const n = nameInput.value.trim();
      if (!n) return;
      isNew ? this._createSkill(n, descInput.value.trim(), contentTa.value) : this._updateSkill(skill!.id, n, descInput.value.trim(), contentTa.value);
      dlg.close();
    }});
    footer.appendChild(cancelBtn.element);
    footer.appendChild(saveBtn.element);

    const dlg = new Dialog({
      title: isNew ? 'Create Skill' : 'Edit Skill',
      body,
      footer,
      onClose: () => this._closeModal(),
    });
    this._modalOverlay = dlg as any;
    dlg.show();
    setTimeout(() => nameInput.focus(), 100);
  }

  private _showImportForm(): void {
    this._closeModal();

    const body = document.createElement('div');
    const desc = document.createElement('p');
    desc.style.cssText = 'font-size:11px;color:var(--cinema-text-edge);margin-bottom:12px;';
    desc.innerHTML = 'Select a <code>.md</code> skill file. YAML frontmatter with <code>name</code> and <code>description</code> fields is supported.';
    body.appendChild(desc);

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.md';
    fileInput.style.cssText = 'color:var(--cinema-text-welcome);font-size:11px;';
    body.appendChild(fileInput);

    const status = document.createElement('p');
    status.id = 'import-status';
    status.style.cssText = 'font-size:10px;margin-top:8px;';
    body.appendChild(status);

    const footer = document.createElement('div');
    const cancelBtn = new Button({ label: 'Cancel', onClick: () => dlg.close() });
    footer.appendChild(cancelBtn.element);

    const dlg = new Dialog({
      title: 'Import Skill',
      body,
      footer,
      onClose: () => this._closeModal(),
    });
    this._modalOverlay = dlg as any;
    dlg.show();

    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0]; if (!f) return;
      try {
        const text = await f.text();
        const fm = text.match(/^---\n([\s\S]*?)\n---/);
        let n = f.name.replace(/\.md$/, ''), d = '', c = text;
        if (fm) {
          for (const ln of fm[1].split('\n')) {
            const kv = ln.match(/^(\w+):\s*(.+)/);
            if (kv) { if (kv[1]==='name') n=kv[2].trim().replace(/^"(.*)"$/,'$1'); if (kv[1]==='description') d=kv[2].trim().replace(/^"(.*)"$/,'$1'); }
          }
          c = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
        }
        const r = await fetch('/api/v1/skills', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:n,description:d,content:c}) });
        if (r.ok) { status.textContent=`Imported "${n}".`; status.style.color='var(--color-success)'; this._loadSkills(); setTimeout(()=>dlg.close(),1200); }
        else { status.textContent='Import failed.'; status.style.color='var(--color-error)'; }
      } catch (err: any) { status.textContent=`Error: ${err.message}`; status.style.color='var(--color-error)'; }
    });
  }

  private _closeModal(): void { if (this._modalOverlay) { this._modalOverlay = null; } }

  private async _createSkill(n: string, d: string, c: string): Promise<void> {
    try { if ((await fetch('/api/v1/skills',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,description:d,content:c})})).ok) this._loadSkills(); } catch {}
  }
  private async _updateSkill(id: string, n: string, d: string, c: string): Promise<void> {
    try { if ((await fetch(`/api/v1/skills/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,description:d,content:c})})).ok) this._loadSkills(); } catch {}
  }
  private async _toggleSkill(s: SkillEntry): Promise<void> {
    try { await fetch(`/api/v1/skills/${s.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:s.enabled})}); } catch {}
  }
}
