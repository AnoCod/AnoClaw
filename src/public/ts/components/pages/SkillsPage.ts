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

  /** Cinema-styled card with avatar-gradient icon, toggle, and description. */
  private _buildCard(skill: SkillEntry): HTMLElement {
    const card = document.createElement('div');
    card.className = skill.enabled ? 'ui-card ui-card-interactive' : 'ui-card ui-card-interactive ui-card-disabled';

    // Top row: icon + name + toggle
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:8px;';

    // Icon with themed gradient (uses avatar palette tokens)
    let h = 0; for (let i = 0; i < skill.name.length; i++) h = (h * 31 + skill.name.charCodeAt(i)) | 0;
    const c = `var(--color-avatar-${Math.abs(h) % 8})`;
    const icon = document.createElement('div');
    icon.style.cssText = `width:36px;height:36px;border-radius:8px;background:linear-gradient(135deg,color-mix(in srgb,${c} 25%,transparent),color-mix(in srgb,${c} 8%,transparent));display:flex;align-items:center;justify-content:center;flex-shrink:0;`;
    icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2"><path d="M14.7 6.3a1 1 0 000-1.4l-1.6-1.6a1 1 0 00-1.4 0l-1.1 1.1 3 3 1.1-1.1zM4 16.2V20h3.8l9.8-9.8-3.8-3.8L4 16.2z"/></svg>`;
    top.appendChild(icon);

    const nameGroup = document.createElement('div');
    nameGroup.style.cssText = 'flex:1;min-width:0;';
    const nameEl = document.createElement('div');
    nameEl.textContent = skill.name;
    nameEl.style.cssText = 'font-size:12px;color:var(--cinema-text-body);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    nameGroup.appendChild(nameEl);
    const stEl = document.createElement('div');
    stEl.textContent = skill.enabled ? 'Enabled' : 'Disabled';
    stEl.style.cssText = `font-size:9px;color:${skill.enabled ? 'var(--color-success)' : 'var(--cinema-text-welcome-desc)'};`;
    nameGroup.appendChild(stEl);
    top.appendChild(nameGroup);

    // Cinema toggle
    const toggle = new Toggle({ checked: skill.enabled });
    toggle.element.addEventListener('click', (e) => {
      e.stopPropagation();
      skill.enabled = !skill.enabled;
      this._toggleSkill(skill);
      toggle.checked = skill.enabled;
      stEl.textContent = skill.enabled ? 'Enabled' : 'Disabled';
      stEl.style.color = skill.enabled ? 'var(--color-success)' : 'var(--cinema-text-welcome-desc)';
      card.className = skill.enabled ? 'ui-card ui-card-interactive' : 'ui-card ui-card-interactive ui-card-disabled';
    });
    top.appendChild(toggle.element);
    card.appendChild(top);

    // Description
    const desc = document.createElement('p');
    desc.textContent = skill.description || 'No description';
    desc.style.cssText = 'font-size:11px;color:var(--cinema-text-edge);line-height:1.5;margin:0 0 10px 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;';
    card.appendChild(desc);

    // Edit button
    const editBtn = new Button({ label: 'Edit', variant: 'default', size: 'sm', onClick: () => { this._showEditor(skill); } });
    card.appendChild(editBtn.element);

    return card;
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

