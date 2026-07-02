/**
 * AnoClaw — SessionsPage Supervision
 * Builds supervision controls (Stop, View Logs) for sub-sessions,
 * manages sub-session card delegates, and handles delegation status updates.
 */
import { App } from '../../app.js';
import { escapeHtml, formatAgentName } from './SessionsPageUtils.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { SubSessionCardDelegate } from '../conversation/delegates/SubSessionCardDelegate.js';
import type { Message } from '../../types.js';
import type { SessionNode } from '../../types.js';
import { ClientLogger } from '../../ClientLogger.js';

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
  heading.textContent = 'Supervision';
  controls.appendChild(heading);

  // Stop Task button
  const stopBtn = document.createElement('button');
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
  stopBtn.innerHTML = '<span style="margin-right:4px;">⏹</span> Stop Task';
  stopBtn.title = `Terminate task for session ${node.id}`;
  stopBtn.addEventListener('click', async () => {
    const ok = await ConfirmDialog.show(`Stop task for session "${node.title}"?`, 'Stop Task');
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
  logBtn.innerHTML = '<span style="margin-right:4px;">📋</span> View Logs';
  logBtn.title = 'View logs for this sub-session';
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
    chain.innerHTML = `
      <div style="font-weight:500;color:var(--color-text-primary);margin-bottom:4px;">Session Chain</div>
      <div>Parent: ${escapeHtml(node.parentSessionId)}</div>
      <div>Agent: ${escapeHtml(node.agentName || 'Unknown')}</div>
      <div>Type: ${node.type || 'Sub'}</div>
    `;
    controls.appendChild(chain);
  }

  overviewPane.appendChild(controls);
}

/** Manages sub-session card lifecycle: creation and delegation status updates. */
export class SubSessionCardManager {
  private _cards = new Map<string, SubSessionCardDelegate>();

  /** Create a sub-session card from a TaskAssign tool result, if applicable. */
  maybeAddCard(msg: Message, parentEl: HTMLElement): void {
    if (msg.type !== 'tool_call' || msg.toolName !== 'TaskAssign' || msg.status !== 'success') return;

    const content = msg.content || '';
    const subSessionMatch = content.match(/Sub-session:\s*(\S+)/);
    const agentMatch = content.match(/agent\s+'([^']+)'/);
    const subSessionId = subSessionMatch ? subSessionMatch[1] : '';
    const agentName = agentMatch ? agentMatch[1] : '';

    if (!subSessionId) return;

    const sessionVM = App.getInstance().sessionVM;
    const subNode = sessionVM.sessions.getById(subSessionId);
    const messageCount = subNode ? (subNode as any).messageCount || 0 : 0;
    const parentSid = (subNode as any)?.parentSessionId as string | undefined;
    const parentNode = parentSid ? sessionVM.sessions.getById(parentSid) : undefined;

    const delegate = new SubSessionCardDelegate({
      subSessionId,
      subAgentId: agentName || subSessionId.split('-').slice(1).join('-'),
      subAgentName: formatAgentName(agentName || subSessionId),
      taskDescription: (msg.toolInput as any)?.task || '',
      messageCount,
      status: 'running',
      parentSessionId: parentSid,
      parentSessionTitle: parentNode?.title,
      onNavigate: (sid: string) => { App.getInstance().sessionVM.selectSession(sid); },
    });
    parentEl.appendChild(delegate.element);
    this._cards.set(subSessionId, delegate);
  }

  /** Update card status from WS delegation_status event. */
  onDelegationStatus(data: { subSessionId: string; phase: string }): void {
    const card = this._cards.get(data.subSessionId);
    if (!card) return;
    if (data.phase === 'completed') card.updateStatus('completed');
    else if (data.phase === 'error') card.updateStatus('error');
    else if (data.phase === 'started' || data.phase === 'working') card.updateStatus('running');
  }

  /** Clear all tracked cards (e.g. on session reset). */
  clear(): void { this._cards.clear(); }
}
