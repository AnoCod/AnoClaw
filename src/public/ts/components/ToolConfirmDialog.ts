// ToolConfirmDialog — modal confirmation dialog for tool execution
// Shows when the agent wants to execute a tool that requires user approval.
// Reuses existing dialog CSS classes from layout-panels.css.

import { onLocaleChange, t } from '../i18n/index.js';

export interface ToolConfirmRequest {
  toolCallId: string;
  toolName: string;
  displayName: string;
  riskLevel: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export class ToolConfirmDialog {
  private static _active = new Map<string, (value: boolean) => void>();

  static show(request: ToolConfirmRequest): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      let overlay: HTMLDivElement;
      let onKey: (e: KeyboardEvent) => void;
      let stopLocaleListener = () => {};

      const done = (value: boolean) => {
        if (settled) return;
        settled = true;
        ToolConfirmDialog._active.delete(request.toolCallId);
        stopLocaleListener();
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(value);
      };

      overlay = document.createElement('div');
      overlay.className = 'dialog-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', t('toolConfirm.ariaLabel'));

      const card = document.createElement('div');
      card.className = 'dialog';

      const titleEl = document.createElement('h2');
      titleEl.className = 'dialog-title';
      titleEl.textContent = t('toolConfirm.title');

      const msgEl = document.createElement('div');
      msgEl.className = 'dialog-message';

      const toolLine = document.createElement('p');
      toolLine.style.cssText = 'margin:0 0 8px 0;';
      toolLine.innerHTML = `<strong>${escapeHtml(t('toolConfirm.tool'))}</strong> ${escapeHtml(request.displayName)}`;

      const riskBadge = document.createElement('span');
      riskBadge.className = `tool-confirm-risk tool-confirm-risk-${request.riskLevel}`;
      riskBadge.textContent = request.riskLevel;

      const paramSummary = summarizeParams(request.params);

      msgEl.appendChild(toolLine);

      const metaLine = document.createElement('p');
      metaLine.style.cssText = 'margin:0 0 8px 0;display:flex;align-items:center;gap:8px;';
      metaLine.innerHTML = `<strong>${escapeHtml(t('toolConfirm.risk'))}</strong> `;
      metaLine.appendChild(riskBadge);
      msgEl.appendChild(metaLine);

      let paramLine: HTMLParagraphElement | null = null;
      if (paramSummary) {
        paramLine = document.createElement('p');
        paramLine.style.cssText = 'margin:0;color:var(--color-text-tertiary);font-size:12px;';
        paramLine.textContent = paramSummary;
        msgEl.appendChild(paramLine);
      }

      const btnRow = document.createElement('div');
      btnRow.className = 'dialog-actions';

      const rejectBtn = document.createElement('button');
      rejectBtn.className = 'btn-dialog-cancel';
      rejectBtn.textContent = t('common.reject');
      rejectBtn.type = 'button';
      rejectBtn.addEventListener('click', () => done(false));

      const approveBtn = document.createElement('button');
      approveBtn.className = 'btn-dialog-confirm';
      approveBtn.textContent = t('common.approve');
      approveBtn.type = 'button';
      approveBtn.addEventListener('click', () => done(true));

      btnRow.appendChild(rejectBtn);
      btnRow.appendChild(approveBtn);

      card.appendChild(titleEl);
      card.appendChild(msgEl);
      card.appendChild(btnRow);
      overlay.appendChild(card);

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) done(false);
      });

      onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') done(false);
      };
      document.addEventListener('keydown', onKey);

      document.body.appendChild(overlay);
      ToolConfirmDialog._active.set(request.toolCallId, done);
      stopLocaleListener = onLocaleChange(() => {
        overlay.setAttribute('aria-label', t('toolConfirm.ariaLabel'));
        titleEl.textContent = t('toolConfirm.title');
        toolLine.innerHTML = `<strong>${escapeHtml(t('toolConfirm.tool'))}</strong> ${escapeHtml(request.displayName)}`;
        metaLine.firstElementChild!.textContent = t('toolConfirm.risk');
        rejectBtn.textContent = t('common.reject');
        approveBtn.textContent = t('common.approve');
        if (paramLine) paramLine.textContent = summarizeParams(request.params);
      });
    });
  }

  static resolve(toolCallId: string, approved: boolean): boolean {
    const done = ToolConfirmDialog._active.get(toolCallId);
    if (!done) return false;
    done(approved);
    return true;
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function summarizeParams(params: Record<string, unknown>): string {
  const keys = Object.keys(params);
  if (keys.length === 0) return '';
  const parts: string[] = [];
  for (const key of keys.slice(0, 4)) {
    const val = params[key];
    if (typeof val === 'string') {
      parts.push(val.length > 80 ? `${key}: "${val.slice(0, 80)}..."` : `${key}: "${val}"`);
    } else if (val === true || val === false) {
      parts.push(`${key}: ${val}`);
    }
  }
  if (keys.length > 4) parts.push(t('toolConfirm.moreParams', { count: keys.length - 4 }));
  return parts.join('; ');
}
