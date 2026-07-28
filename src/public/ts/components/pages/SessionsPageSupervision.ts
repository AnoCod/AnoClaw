/**
 * AnoClaw — SessionsPage Supervision
 * Builds supervision controls (Stop, View Logs) for sub-sessions,
 * and shows the session chain for delegated work.
 */
import { App } from '../../app.js';
import { escapeHtml } from './SessionsPageUtils.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import type { SessionNode } from '../../types.js';
import { ClientLogger } from '../../ClientLogger.js';
import { onLocaleChange, t } from '../../i18n/index.js';

/**
 * Build and append supervision control buttons for a sub-session node
 * into the overview pane. Includes Stop Task, View Logs, and
 * a session-chain info block.
 */
export function buildSupervisionButtons(node: SessionNode, overviewPane: HTMLElement): void {
  const existing = overviewPane.querySelector('.supervision-controls');
  if (existing) existing.remove();

  const controls = document.createElement('div');
  controls.className = 'supervision-controls';
  controls.style.cssText = `
    padding: var(--space-sm);
    display: flex;
    flex-direction: column;
    gap: 6px;
  `;

  const heading = document.createElement('div');
  heading.style.cssText = `
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-primary);
    margin-bottom: 2px;
  `;
  heading.textContent = t('supervision.title');
  controls.appendChild(heading);

  // Stop Task button
  const stopBtn = document.createElement('button');
  stopBtn.className = 'supervision-stop-btn';
  stopBtn.style.cssText = `
    padding: 8px 12px;
    background: rgba(239,68,68,0.1);
    color: #fca5a5;
    border: 1px solid rgba(239,68,68,0.2);
    border-radius: var(--radius);
    cursor: pointer;
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 500;
    transition: opacity 0.15s;
  `;
  stopBtn.innerHTML = `<span style="margin-right:4px;">⏹</span> ${t('supervision.stop')}`;
  stopBtn.title = t('supervision.stopTitle', { id: node.id });
  stopBtn.addEventListener('click', async () => {
    const ok = await ConfirmDialog.show(t('supervision.stopConfirm', { title: node.title }), t('supervision.stop'));
    if (ok) {
      const convVM = App.getInstance().conversationVM;
      const sessionVM = App.getInstance().sessionVM;
      const sid = sessionVM.activeSessionId;
      if (sid) convVM.getAgent(sid).stopGeneration().catch(() => {});
    }
  });
  stopBtn.addEventListener('mouseenter', () => { stopBtn.style.opacity = '0.85'; });
  stopBtn.addEventListener('mouseleave', () => { stopBtn.style.opacity = '1'; });
  controls.appendChild(stopBtn);

  // View Logs button
  const logBtn = document.createElement('button');
  logBtn.className = 'supervision-log-btn';
  logBtn.style.cssText = `
    padding: 8px 12px;
    background: rgba(255,255,255,0.06);
    color: var(--color-text-primary);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: var(--radius);
    cursor: pointer;
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 500;
    transition: background 0.15s;
  `;
  logBtn.innerHTML = `<span style="margin-right:4px;">📋</span> ${t('supervision.logs')}`;
  logBtn.title = t('supervision.logsTitle');
  logBtn.addEventListener('click', () => { ClientLogger.ui.debug('View logs clicked', { sid: node.id }); });
  logBtn.addEventListener('mouseenter', () => { logBtn.style.background = 'rgba(255,255,255,0.1)'; });
  logBtn.addEventListener('mouseleave', () => { logBtn.style.background = 'rgba(255,255,255,0.06)'; });
  controls.appendChild(logBtn);

  // Parent chain info
  if (node.parentSessionId) {
    const chain = document.createElement('div');
    chain.style.cssText = `
      padding: 8px;
      background: rgba(255,255,255,0.02);
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: var(--radius);
      margin-top: 4px;
      font-size: 11px;
      color: var(--color-text-secondary);
    `;
    const renderChain = () => {
      chain.innerHTML = `
        <div style="font-weight:500;color:var(--color-text-primary);margin-bottom:4px;">${t('supervision.chain')}</div>
        <div>${t('supervision.parent')}: ${escapeHtml(node.parentSessionId!)}</div>
        <div>${t('supervision.agent')}: ${escapeHtml(node.agentName || t('supervision.unknown'))}</div>
        <div>${t('supervision.type')}: ${node.type || t('supervision.sub')}</div>
      `;
    };
    renderChain();
    controls.appendChild(chain);
  }

  const stopLocaleListener = onLocaleChange(() => {
    if (!controls.isConnected) {
      stopLocaleListener();
      return;
    }
    heading.textContent = t('supervision.title');
    stopBtn.innerHTML = `<span style="margin-right:4px;">⏹</span> ${t('supervision.stop')}`;
    stopBtn.title = t('supervision.stopTitle', { id: node.id });
    logBtn.innerHTML = `<span style="margin-right:4px;">📋</span> ${t('supervision.logs')}`;
    logBtn.title = t('supervision.logsTitle');
    const chain = controls.lastElementChild as HTMLElement | null;
    if (node.parentSessionId && chain?.style) {
      chain.innerHTML = `
        <div style="font-weight:500;color:var(--color-text-primary);margin-bottom:4px;">${t('supervision.chain')}</div>
        <div>${t('supervision.parent')}: ${escapeHtml(node.parentSessionId)}</div>
        <div>${t('supervision.agent')}: ${escapeHtml(node.agentName || t('supervision.unknown'))}</div>
        <div>${t('supervision.type')}: ${node.type || t('supervision.sub')}</div>
      `;
    }
  });

  overviewPane.appendChild(controls);
}
