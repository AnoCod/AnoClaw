// WorkflowList.ts - sidebar workflow list with add/delete/select

import type { WorkflowMeta } from './WorkflowNodeTypes.js';

export interface ListCallbacks {
  onSelect: (id: string) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
}

/** Inline confirm dialog - styled to match the app's ConfirmDialog */
export function confirmDialog(message: string, title = 'Confirm'): Promise<boolean> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'wf-dialog-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999';
    const card = document.createElement('div');
    card.style.cssText = 'background:var(--color-surface,#0d0d0d);border:1px solid var(--color-hairline,#242728);border-radius:10px;padding:24px;min-width:300px;max-width:420px;box-shadow:none';
    card.innerHTML = `<div style="font-size:14px;font-weight:600;margin-bottom:8px;color:var(--color-text,#eee)">${title}</div><div style="font-size:12px;color:var(--color-text-secondary,#999);margin-bottom:20px">${message}</div><div style="display:flex;gap:8px;justify-content:flex-end"><button id="wf-conf-cancel" style="padding:6px 16px;border-radius:6px;border:1px solid var(--color-hairline,rgba(255,255,255,0.06));background:transparent;color:var(--color-text-secondary,#999);cursor:pointer;font-size:12px">Cancel</button><button id="wf-conf-ok" style="padding:6px 16px;border-radius:8px;border:1px solid var(--color-primary,#fff);background:var(--color-primary,#fff);color:var(--color-on-primary,#000);cursor:pointer;font-size:12px">Delete</button></div>`;
    overlay.appendChild(card);
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
    document.body.appendChild(overlay);
    card.querySelector('#wf-conf-cancel')!.addEventListener('click', () => { overlay.remove(); resolve(false); });
    card.querySelector('#wf-conf-ok')!.addEventListener('click', () => { overlay.remove(); resolve(true); });
  });
}

export function buildList(workflows: WorkflowMeta[], activeId: string | null, cb: ListCallbacks): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'workflow-list-container';
  el.innerHTML = `
    <div class="workflow-list-header">
      <span class="workflow-list-title">Workflows</span>
      <button class="workflow-list-add-btn" id="wf-list-add">+</button>
    </div>
    <div class="workflow-list-items" id="wf-list-items"></div>`;

  el.querySelector('#wf-list-add')?.addEventListener('click', () => cb.onAdd());

  const itemsEl = el.querySelector('#wf-list-items')!;
  for (const wf of workflows) {
    const item = document.createElement('div');
    item.className = 'workflow-list-item' + (wf.id === activeId ? ' active' : '');
    item.innerHTML = `
      <span style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${wf.status === 'running' ? '#f59e0b' : wf.status === 'completed' ? '#10b981' : wf.status === 'error' ? '#ef4444' : 'rgba(255,255,255,0.15)'};${wf.status === 'running' ? 'animation:dotPulse 1s ease-in-out infinite;' : ''}"></span>
      <span class="workflow-list-item-name">${esc(wf.name)}</span>
      <button class="workflow-list-item-del">&times;</button>`;
    item.addEventListener('click', async (e) => {
      if ((e.target as HTMLElement).closest('.workflow-list-item-del')) {
        if (await ((window as any).anoclaw?.dialog?.confirm || confirmDialog)('Delete workflow "' + wf.name + '"?')) cb.onDelete(wf.id);
        return;
      }
      cb.onSelect(wf.id);
    });
    itemsEl.appendChild(item);
  }
  return el;

  function esc(s: string): string { const e = document.createElement('span'); e.textContent = s; return e.innerHTML; }
}

// Add CSS animation for running dot
const style = document.createElement('style');
style.textContent = '@keyframes dotPulse{0%,100%{opacity:1}50%{opacity:0.3}}';
document.head.appendChild(style);
