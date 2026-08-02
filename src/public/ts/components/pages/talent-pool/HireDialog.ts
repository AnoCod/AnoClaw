// HireDialog — dialog for hiring a template into the agent org chart
// Validates hierarchy before creating the agent. Uses shared UI components.

import { Dialog } from '../../ui/Dialog.js';
import { Button } from '../../ui/Button.js';
import { Badge } from '../../ui/Badge.js';
import type { TalentPoolTemplate, AgentConfig } from '../../../types.js';
import { onLocaleChange, t } from '../../../i18n/index.js';

export interface HireResult {
  templateId: string;
  name: string;
  role: 'MainAgent' | 'Manager' | 'Member';
  parentAgentId: string;
}

/** Shows the hire dialog. Returns null if cancelled, or HireResult on confirm. */
export function showHireDialog(tpl: TalentPoolTemplate, agents: AgentConfig[]): Promise<HireResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribeLocale = () => {};
    const finish = (result: HireResult | null): void => {
      if (settled) return;
      settled = true;
      unsubscribeLocale();
      resolve(result);
    };
    const defaultRole = tpl.role;
    const parentOptions = _getValidParents(agents, defaultRole);

    let defaultParentId = '';
    if (parentOptions.length > 0) {
      const main = agents.find(a => a.role === 'MainAgent' && _isValidParent(a, defaultRole));
      if (main && parentOptions.some(p => p.id === main.id)) {
        defaultParentId = main.id;
      } else {
        defaultParentId = parentOptions[0].id;
      }
    }

    // Build body
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

    const desc = document.createElement('p');
    desc.style.cssText = 'margin:0;font-size:13px;color:var(--color-text-secondary);';
    desc.textContent = tpl.description;
    body.appendChild(desc);

    // Name
    const nameLabel = _label(t('talent.hire.agentName'));
    const nameInput = document.createElement('input');
    nameInput.id = 'tp-hire-name';
    nameInput.value = tpl.name;
    nameInput.style.cssText = _inputStyle();
    body.appendChild(nameLabel);
    body.appendChild(nameInput);

    // Role
    const roleLabel = _label(t('agents.field.role'));
    const roleSelect = document.createElement('select');
    roleSelect.id = 'tp-hire-role';
    roleSelect.style.cssText = _inputStyle();
    roleSelect.innerHTML = `
      <option value="Manager" ${defaultRole === 'Manager' ? 'selected' : ''}>${t('agents.role.manager')}</option>
      <option value="Member" ${defaultRole === 'Member' ? 'selected' : ''}>${t('agents.role.member')}</option>
    `;
    body.appendChild(roleLabel);
    body.appendChild(roleSelect);

    // Parent
    const parentLabel = _label(t('talent.hire.parentAgent'));
    const parentSelect = document.createElement('select');
    parentSelect.id = 'tp-hire-parent';
    parentSelect.style.cssText = _inputStyle();
    _populateParents(parentSelect, agents, defaultRole, defaultParentId);
    body.appendChild(parentLabel);
    body.appendChild(parentSelect);

    // Error
    const errorEl = document.createElement('div');
    errorEl.id = 'tp-hire-error';
    errorEl.style.cssText = 'color:var(--color-error);font-size:12px;min-height:18px;';

    const confirmBtn = new Button({ label: t('talent.hire.confirm'), variant: 'primary', disabled: true });
    const cancelBtn = new Button({ label: t('common.cancel') });

    function validate(): boolean {
      const role = roleSelect.value;
      const parentId = parentSelect.value;
      const parent = agents.find(a => a.id === parentId);

      if (!parent) { errorEl.textContent = t('talent.hire.selectParent'); confirmBtn.disabled = true; return false; }

      const err = _validateHierarchy(parent, role);
      if (err) { errorEl.textContent = err; confirmBtn.disabled = true; return false; }

      if (role === 'MainAgent' && agents.some(a => a.role === 'MainAgent')) {
        errorEl.textContent = t('talent.hire.ceoExists');
        confirmBtn.disabled = true;
        return false;
      }

      errorEl.textContent = '';
      confirmBtn.disabled = false;
      return true;
    }

    body.appendChild(errorEl);

    // Footer
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;gap:8px;';
    footer.appendChild(cancelBtn.element);
    footer.appendChild(confirmBtn.element);

    const dialog = new Dialog({
      title: t('talent.hire.title', { name: tpl.name }),
      body,
      footer,
      width: '420px',
      onClose: () => finish(null),
    });

    const refreshLocale = (): void => {
      nameLabel.textContent = t('talent.hire.agentName');
      roleLabel.textContent = t('agents.field.role');
      parentLabel.textContent = t('talent.hire.parentAgent');
      const managerOption = roleSelect.querySelector<HTMLOptionElement>('option[value="Manager"]');
      const memberOption = roleSelect.querySelector<HTMLOptionElement>('option[value="Member"]');
      if (managerOption) managerOption.textContent = t('agents.role.manager');
      if (memberOption) memberOption.textContent = t('agents.role.member');
      _populateParents(parentSelect, agents, roleSelect.value, parentSelect.value);
      confirmBtn.label = t('talent.hire.confirm');
      cancelBtn.label = t('common.cancel');
      const title = body.parentElement?.parentElement?.querySelector<HTMLElement>('.ui-dialog-title');
      if (title) title.textContent = t('talent.hire.title', { name: tpl.name });
      validate();
    };
    unsubscribeLocale = onLocaleChange(refreshLocale);

    roleSelect.addEventListener('change', () => {
      _populateParents(parentSelect, agents, roleSelect.value, parentSelect.value);
      validate();
    });
    parentSelect.addEventListener('change', () => validate());
    nameInput.addEventListener('input', () => validate());

    confirmBtn.element.addEventListener('click', () => {
      if (!validate()) return;
      finish({
        templateId: tpl.id,
        name: nameInput.value.trim() || tpl.name,
        role: roleSelect.value as any,
        parentAgentId: parentSelect.value,
      });
      dialog.close();
    });
    cancelBtn.element.addEventListener('click', () => { finish(null); dialog.close(); });

    body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !confirmBtn.disabled) {
        confirmBtn.element.click();
      }
    });

    dialog.show();
    validate();
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

function _getValidParents(agents: AgentConfig[], childRole: string): AgentConfig[] {
  return agents.filter(a => _isValidParent(a, childRole));
}

function _isValidParent(parent: AgentConfig, childRole: string): boolean {
  if (parent.role === 'Member') return false;
  if (parent.role === 'MainAgent' && childRole !== 'Manager') return false;
  if (childRole === 'MainAgent') return false;
  return true;
}

function _validateHierarchy(parent: AgentConfig, childRole: string): string | null {
  if (parent.role === 'Member') {
    return t('talent.hire.memberNoChildren', { name: parent.name });
  }
  if (parent.role === 'MainAgent' && childRole !== 'Manager') {
    return t('talent.hire.ceoManagerOnly', { name: parent.name });
  }
  if (childRole === 'MainAgent') {
    return t('talent.hire.ceoSubordinate');
  }
  if (!parent.id) {
    return t('talent.hire.invalidParent');
  }
  return null;
}

function _populateParents(select: HTMLSelectElement, agents: AgentConfig[], childRole: string, currentValue: string): void {
  const valid = _getValidParents(agents, childRole);
  const hasCurrent = valid.some(p => p.id === currentValue);
  select.innerHTML = valid.map(p =>
    `<option value="${p.id}" ${p.id === currentValue ? 'selected' : ''}>${p.role === 'MainAgent' ? '◆' : p.role === 'Manager' ? '◇' : '○'} ${p.name} (${_roleLabel(p.role)})</option>`
  ).join('');
  if (!hasCurrent && valid.length > 0) {
    select.value = valid[0].id;
  }
}

function _roleLabel(role: string): string {
  if (role === 'MainAgent') return t('agents.role.ceo');
  if (role === 'Manager') return t('agents.role.manager');
  if (role === 'Member') return t('agents.role.member');
  return role;
}
