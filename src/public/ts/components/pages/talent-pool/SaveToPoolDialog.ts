// SaveToPoolDialog — save an existing agent to the talent pool as a template
// Uses shared UI components: Dialog, Button.

import { Dialog } from '../../ui/Dialog.js';
import { Button } from '../../ui/Button.js';
import type { TalentPoolGroup, AgentConfig } from '../../../types.js';
import { ToastManager } from '../../../ToastManager.js';

export interface SaveToPoolResult {
  agentId: string;
  groupId: string;
  name: string;
  description: string;
}

/** Shows the save-to-pool dialog. Returns null if cancelled, or SaveToPoolResult on confirm. */
export function showSaveToPoolDialog(agent: AgentConfig, groups: TalentPoolGroup[]): Promise<SaveToPoolResult | null> {
  return new Promise((resolve) => {
    const defaultGroupId = groups.length > 0 ? groups[0].id : '';

    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

    const desc = document.createElement('p');
    desc.style.cssText = 'margin:0;font-size:13px;color:var(--color-text-secondary);';
    desc.innerHTML = `Save <strong>${_esc(agent.name)}</strong> as a reusable agent template.`;
    body.appendChild(desc);

    // Name
    const nameLabel = _label('Template Name');
    const nameInput = document.createElement('input');
    nameInput.value = agent.name;
    nameInput.style.cssText = _inputStyle();
    body.appendChild(nameLabel);
    body.appendChild(nameInput);

    // Description
    const descLabel = _label('Description');
    const descInput = document.createElement('input');
    descInput.value = `${agent.role} agent: ${agent.name}`;
    descInput.style.cssText = _inputStyle();
    body.appendChild(descLabel);
    body.appendChild(descInput);

    // Group
    const groupLabel = _label('Domain');
    const groupSelect = document.createElement('select');
    groupSelect.style.cssText = _inputStyle();
    groupSelect.innerHTML = groups.map(g =>
      `<option value="${_esc(g.id)}" ${g.id === defaultGroupId ? 'selected' : ''}>${_esc(g.name)}</option>`
    ).join('');
    body.appendChild(groupLabel);
    body.appendChild(groupSelect);

    // Footer
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;gap:8px;';
    const cancelBtn = new Button({ label: 'Cancel' });
    const saveBtn = new Button({ label: 'Save', variant: 'primary' });
    footer.appendChild(cancelBtn.element);
    footer.appendChild(saveBtn.element);

    const dialog = new Dialog({
      title: 'Save to Talent Pool',
      body,
      footer,
      width: '420px',
    });

    saveBtn.element.addEventListener('click', () => {
      const name = nameInput.value.trim() || agent.name;
      const description = descInput.value.trim() || `${agent.role} agent: ${agent.name}`;
      const groupId = groupSelect.value;
      if (!groupId) {
        ToastManager.getInstance().error('Select a domain.');
        return;
      }
      resolve({ agentId: agent.id, groupId, name, description });
      dialog.close();
    });

    cancelBtn.element.addEventListener('click', () => { resolve(null); dialog.close(); });

    body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { saveBtn.element.click(); }
    });

    dialog.show();
  });
}

function _label(text: string): HTMLElement {
  const l = document.createElement('label');
  l.textContent = text;
  l.style.cssText = 'font-size:11px;color:var(--color-text-tertiary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:-8px;';
  return l;
}

function _inputStyle(): string {
  return 'width:100%;padding:7px 10px;border:1px solid var(--color-bubble-sent);border-radius:6px;background:var(--color-surface-elevated);color:var(--color-text-primary);font-size:13px;box-sizing:border-box;outline:none;';
}

function _esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
