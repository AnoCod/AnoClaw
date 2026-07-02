// HireDialog — dialog for hiring a template into the agent org chart
// Validates hierarchy before creating the agent. Uses shared UI components.

import { Dialog } from '../../ui/Dialog.js';
import { Button } from '../../ui/Button.js';
import { Badge } from '../../ui/Badge.js';
import type { TalentPoolTemplate, AgentConfig } from '../../../types.js';

export interface HireResult {
  templateId: string;
  name: string;
  role: 'MainAgent' | 'Manager' | 'Member';
  parentAgentId: string;
}

/** Shows the hire dialog. Returns null if cancelled, or HireResult on confirm. */
export function showHireDialog(tpl: TalentPoolTemplate, agents: AgentConfig[]): Promise<HireResult | null> {
  return new Promise((resolve) => {
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
    const nameLabel = _label('Agent Name');
    const nameInput = document.createElement('input');
    nameInput.id = 'tp-hire-name';
    nameInput.value = tpl.name;
    nameInput.style.cssText = _inputStyle();
    body.appendChild(nameLabel);
    body.appendChild(nameInput);

    // Role
    const roleLabel = _label('Role');
    const roleSelect = document.createElement('select');
    roleSelect.id = 'tp-hire-role';
    roleSelect.style.cssText = _inputStyle();
    roleSelect.innerHTML = `
      <option value="Manager" ${defaultRole === 'Manager' ? 'selected' : ''}>Manager</option>
      <option value="Member" ${defaultRole === 'Member' ? 'selected' : ''}>Member</option>
    `;
    body.appendChild(roleLabel);
    body.appendChild(roleSelect);

    // Parent
    const parentLabel = _label('Parent Agent');
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

    const confirmBtn = new Button({ label: 'Hire', variant: 'primary', disabled: true });
    const cancelBtn = new Button({ label: 'Cancel' });

    function validate(): boolean {
      const role = roleSelect.value;
      const parentId = parentSelect.value;
      const parent = agents.find(a => a.id === parentId);

      if (!parent) { errorEl.textContent = 'Select a parent agent.'; confirmBtn.disabled = true; return false; }

      const err = _validateHierarchy(parent, role);
      if (err) { errorEl.textContent = err; confirmBtn.disabled = true; return false; }

      if (role === 'MainAgent' && agents.some(a => a.role === 'MainAgent')) {
        errorEl.textContent = 'A CEO (MainAgent) already exists. Only one CEO is allowed.';
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
      title: `Hire: ${tpl.name}`,
      body,
      footer,
      width: '420px',
    });

    roleSelect.addEventListener('change', () => {
      _populateParents(parentSelect, agents, roleSelect.value, parentSelect.value);
      validate();
    });
    parentSelect.addEventListener('change', () => validate());
    nameInput.addEventListener('input', () => validate());

    confirmBtn.element.addEventListener('click', () => {
      if (!validate()) return;
      resolve({
        templateId: tpl.id,
        name: nameInput.value.trim() || tpl.name,
        role: roleSelect.value as any,
        parentAgentId: parentSelect.value,
      });
      dialog.close();
    });
    cancelBtn.element.addEventListener('click', () => { resolve(null); dialog.close(); });

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
    return `"${parent.name}" is a Member (leaf node) and cannot have subordinates. Select a Manager or CEO as parent.`;
  }
  if (parent.role === 'MainAgent' && childRole !== 'Manager') {
    return `CEO "${parent.name}" can only have Manager-level subordinates. Change role to Manager or select a different parent.`;
  }
  if (childRole === 'MainAgent') {
    return 'Cannot assign a CEO as subordinate. CEO is the top-level agent.';
  }
  if (!parent.id) {
    return 'Select a valid parent agent.';
  }
  return null;
}

function _populateParents(select: HTMLSelectElement, agents: AgentConfig[], childRole: string, currentValue: string): void {
  const valid = _getValidParents(agents, childRole);
  const hasCurrent = valid.some(p => p.id === currentValue);
  select.innerHTML = valid.map(p =>
    `<option value="${p.id}" ${p.id === currentValue ? 'selected' : ''}>${p.role === 'MainAgent' ? '◆' : p.role === 'Manager' ? '◇' : '○'} ${p.name} (${p.role})</option>`
  ).join('');
  if (!hasCurrent && valid.length > 0) {
    select.value = valid[0].id;
  }
}
