// AnoClaw Frontend — Confirm Dialog (TypeScript)
// DOM-based confirm dialog (replaces native confirm() so CDP/browser-automation can detect it).
// Usage: const ok = await ConfirmDialog.show('Are you sure?');

import { onLocaleChange, t } from '../i18n/index.js';

export class ConfirmDialog {
  /** Show a confirmation dialog.
   *  @param message - Question text displayed in the dialog.
   *  @param title - Optional dialog title (default: 'Confirm').
   *  @returns Resolves true on Confirm, false on Cancel/close.
   */
  static show(message: string, title?: string): Promise<boolean> {
    const usesDefaultTitle = title === undefined;
    const resolvedTitle = title ?? t('common.confirmTitle');
    console.log('[Dialog] show title:', resolvedTitle);
    return new Promise((resolve) => {
      let stopLocaleListener = () => {};
      const done = (value: boolean) => {
        console.log('[Dialog] result:', value);
        stopLocaleListener();
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(value);
      };

      // ── Overlay ──
      const overlay = document.createElement('div');
      overlay.id = 'confirm-dialog-overlay';
      overlay.className = 'dialog-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', resolvedTitle);

      // ── Dialog card ──
      const card = document.createElement('div');
      card.id = 'confirm-dialog-card';
      card.className = 'dialog';

      // ── Title ──
      const titleEl = document.createElement('h2');
      titleEl.id = 'confirm-dialog-title';
      titleEl.className = 'dialog-title';
      titleEl.textContent = resolvedTitle;

      // ── Message ──
      const msgEl = document.createElement('p');
      msgEl.id = 'confirm-dialog-message';
      msgEl.className = 'dialog-message';
      msgEl.textContent = message;

      // ── Buttons ──
      const btnRow = document.createElement('div');
      btnRow.className = 'dialog-actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.id = 'confirm-dialog-cancel-btn';
      cancelBtn.className = 'btn-dialog-cancel';
      cancelBtn.textContent = t('common.cancel');
      cancelBtn.type = 'button';
      cancelBtn.addEventListener('click', () => done(false));

      const confirmBtn = document.createElement('button');
      confirmBtn.id = 'confirm-dialog-confirm-btn';
      confirmBtn.className = 'btn-dialog-confirm';
      confirmBtn.textContent = t('common.confirm');
      confirmBtn.type = 'button';
      confirmBtn.addEventListener('click', () => done(true));

      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(confirmBtn);

      // ── Assemble ──
      card.appendChild(titleEl);
      card.appendChild(msgEl);
      card.appendChild(btnRow);
      overlay.appendChild(card);

      // ── Click-overlay-to-dismiss ──
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) done(false);
      });

      // ── Escape key ──
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          document.removeEventListener('keydown', onKey);
          done(false);
        }
      };
      document.addEventListener('keydown', onKey);

      document.body.appendChild(overlay);
      stopLocaleListener = onLocaleChange(() => {
        cancelBtn.textContent = t('common.cancel');
        confirmBtn.textContent = t('common.confirm');
        if (usesDefaultTitle) {
          titleEl.textContent = t('common.confirmTitle');
          overlay.setAttribute('aria-label', t('common.confirmTitle'));
        }
      });
    });
  }
}
