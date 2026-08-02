// SaveToPoolDialog — save an existing agent to the talent pool as a template
// Uses shared UI components: Dialog, Button.

import { Dialog } from '../../ui/Dialog.js';
import { Button } from '../../ui/Button.js';
import type { TalentPoolGroup, AgentConfig } from '../../../types.js';
import { ToastManager } from '../../../ToastManager.js';
import { onLocaleChange, t } from '../../../i18n/index.js';

export interface SaveToPoolResult {
  agentId: string;
  groupId: string;
  name: string;
  description: string;
}

/** Shows the save-to-pool dialog. Returns null if cancelled, or SaveToPoolResult on confirm. */
export function showSaveToPoolDialog(agent: AgentConfig, groups: TalentPoolGroup[]): Promise<SaveToPoolResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribeLocale = () => {};
    const finish = (result: SaveToPoolResult | null): void => {
      if (settled) return;
      settled = true;
      unsubscribeLocale();
      resolve(result);
    };
    const defaultGroupId = groups.length > 0 ? groups[0].id : '';

    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

    const desc = document.createElement('p');
    desc.style.cssText = 'margin:0;font-size:13px;color:var(--color-text-secondary);';
    desc.innerHTML = t('talent.save.description', { name: _esc(agent.name) });
    body.appendChild(desc);

    // Name
    const nameLabel = _label(t('talent.save.templateName'));
    const nameInput = document.createElement('input');
    nameInput.value = agent.name;
    nameInput.style.cssText = _inputStyle();
    body.appendChild(nameLabel);
    body.appendChild(nameInput);

    // Description
    const descLabel = _label(t('talent.save.fieldDescription'));
    const descInput = document.createElement('input');
    let generatedDescription = t('talent.save.defaultDescription', {
      role: _roleLabel(agent.role),
      name: agent.name,
    });
    descInput.value = generatedDescription;
    descInput.style.cssText = _inputStyle();
    body.appendChild(descLabel);
    body.appendChild(descInput);

    // Group
    const groupLabel = _label(t('talent.save.domain'));
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
    const cancelBtn = new Button({ label: t('common.cancel') });
    const saveBtn = new Button({ label: t('common.save'), variant: 'primary' });
    footer.appendChild(cancelBtn.element);
    footer.appendChild(saveBtn.element);

    const dialog = new Dialog({
      title: t('talent.save.title'),
      body,
      footer,
      width: '420px',
      onClose: () => finish(null),
    });

    const refreshLocale = (): void => {
      desc.innerHTML = t('talent.save.description', { name: _esc(agent.name) });
      nameLabel.textContent = t('talent.save.templateName');
      descLabel.textContent = t('talent.save.fieldDescription');
      groupLabel.textContent = t('talent.save.domain');
      if (descInput.value === generatedDescription) {
        generatedDescription = t('talent.save.defaultDescription', {
          role: _roleLabel(agent.role),
          name: agent.name,
        });
        descInput.value = generatedDescription;
      }
      cancelBtn.label = t('common.cancel');
      saveBtn.label = t('common.save');
      const title = body.parentElement?.parentElement?.querySelector<HTMLElement>('.ui-dialog-title');
      if (title) title.textContent = t('talent.save.title');
    };
    unsubscribeLocale = onLocaleChange(refreshLocale);

    saveBtn.element.addEventListener('click', () => {
      const name = nameInput.value.trim() || agent.name;
      const description = descInput.value.trim() || generatedDescription;
      const groupId = groupSelect.value;
      if (!groupId) {
        ToastManager.getInstance().error(t('talent.save.selectDomain'));
        return;
      }
      finish({ agentId: agent.id, groupId, name, description });
      dialog.close();
    });

    cancelBtn.element.addEventListener('click', () => { finish(null); dialog.close(); });

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

function _roleLabel(role: string): string {
  if (role === 'MainAgent') return t('agents.role.ceo');
  if (role === 'Manager') return t('agents.role.manager');
  if (role === 'Member') return t('agents.role.member');
  return role;
}
