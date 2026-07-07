// WorkflowPersistence.ts - localStorage persistence + API fetch for workflow data + execution logs

import { type WorkflowMeta, type WorkflowCanvasData, STORAGE_KEY } from './WorkflowNodeTypes.js';

export interface WorkflowStore { workflows: WorkflowMeta[]; activeWorkflowId: string | null; }

export function loadStore(): WorkflowStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as WorkflowStore;
  } catch {}
  return { workflows: [], activeWorkflowId: null };
}

export function saveStore(store: WorkflowStore): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

export function loadCanvasData(wfId: string): WorkflowCanvasData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY + '_' + wfId);
    if (raw) return JSON.parse(raw) as WorkflowCanvasData;
  } catch {}
  return null;
}

export function saveCanvasData(wfId: string, data: WorkflowCanvasData): void {
  localStorage.setItem(STORAGE_KEY + '_' + wfId, JSON.stringify(data));
}

export async function fetchWorkflows(): Promise<WorkflowMeta[]> {
  try {
    const r = await fetch('/api/v1/workflows');
    if (r.ok) {
      const d = await r.json();
      return (d.workflows || []).map((w: any) => ({
        id: w.id, name: w.name || w.id, status: w.status || 'idle',
        createdAt: w.createdAt || '', lastRunAt: w.lastRunAt || null,
      }));
    }
  } catch {}
  return [];
}

export async function createWorkflow(name: string): Promise<WorkflowMeta | null> {
  const id = 'wf_' + Math.random().toString(36).slice(2, 8);
  try {
    await fetch('/api/v1/workflows', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name, nodes: [], connections: [], status: 'idle' }),
    });
    return { id, name, status: 'idle', createdAt: new Date().toISOString(), lastRunAt: null };
  } catch { return null; }
}

export async function deleteWorkflow(id: string): Promise<void> {
  await fetch('/api/v1/workflows/' + id, { method: 'DELETE' });
}

export async function startWorkflow(id: string): Promise<void> {
  await fetch('/api/v1/workflows/' + id + '/start', { method: 'POST' });
}
export async function stopWorkflow(id: string): Promise<void> {
  await fetch('/api/v1/workflows/' + id + '/stop', { method: 'POST' });
}

/** Fetch execution logs for a workflow */
export async function fetchWorkflowLogs(id: string): Promise<{ logs: any[]; executionState: any }> {
  try {
    const r = await fetch('/api/v1/workflows/' + id + '/logs');
    if (r.ok) {
      const data = await r.json();
      return { logs: data.logs || [], executionState: data.executionState || null };
    }
  } catch {}
  return { logs: [], executionState: null };
}
