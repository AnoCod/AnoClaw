// ToolConfirmationQueue — FIFO queue for tool confirmation dialogs
// Receives tool_confirm_request WS events, shows dialogs one at a time,
// and sends tool_confirm_response back to the server.

import { ToolConfirmDialog, type ToolConfirmRequest } from '../components/ToolConfirmDialog.js';

export interface ToolConfirmationSummary {
  toolCallId: string;
  toolName: string;
  displayName: string;
  riskLevel: string;
  sessionId?: string;
  detail?: string;
  canInlineResolve: boolean;
}

export interface ToolConfirmationSnapshot {
  count: number;
  first: ToolConfirmationSummary | null;
}

export class ToolConfirmationQueue {
  private static _instance: ToolConfirmationQueue;
  private _queue: ToolConfirmRequest[] = [];
  private _active = false;
  private _activeRequest: ToolConfirmRequest | null = null;
  private _activeResolver: ((approved: boolean) => void) | null = null;
  private _sendFn: ((data: Record<string, unknown>) => void) | null = null;
  private _listeners = new Set<() => void>();

  static getInstance(): ToolConfirmationQueue {
    if (!ToolConfirmationQueue._instance) {
      ToolConfirmationQueue._instance = new ToolConfirmationQueue();
    }
    return ToolConfirmationQueue._instance;
  }

  static resetInstance(): void {
    ToolConfirmationQueue._instance = undefined as unknown as ToolConfirmationQueue;
  }

  setSender(fn: (data: Record<string, unknown>) => void): void {
    this._sendFn = fn;
  }

  onChange(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  get pendingCount(): number {
    return this._queue.length + (this._active ? 1 : 0);
  }

  get snapshot(): ToolConfirmationSnapshot {
    const first = this._activeRequest || this._queue[0] || null;
    return {
      count: this.pendingCount,
      first: first ? summarizeRequest(first) : null,
    };
  }

  enqueue(request: ToolConfirmRequest): void {
    this._queue.push(request);
    this._notify();
    this._processNext();
  }

  respondToFirst(approved: boolean, toolCallId?: string): boolean {
    const first = this._activeRequest || this._queue[0] || null;
    if (!first) return false;
    if (toolCallId && first.toolCallId !== toolCallId) return false;
    if (!isInlineResolvableRisk(first.riskLevel)) return false;

    if (this._activeRequest) {
      ToolConfirmDialog.resolve(first.toolCallId, approved);
      this._activeResolver?.(approved);
      return true;
    }

    this._queue.shift();
    this._sendResponse(first.toolCallId, approved);
    this._notify();
    this._processNext();
    return true;
  }

  private async _processNext(): Promise<void> {
    if (this._active || this._queue.length === 0) return;
    this._active = true;
    const request = this._queue.shift()!;
    this._activeRequest = request;
    this._notify();
    try {
      const externalResponse = new Promise<boolean>((resolve) => {
        this._activeResolver = resolve;
      });
      const approved = await Promise.race([
        ToolConfirmDialog.show(request),
        externalResponse,
      ]);
      this._sendResponse(request.toolCallId, approved);
    } catch {
      this._sendResponse(request.toolCallId, false);
    } finally {
      this._active = false;
      this._activeRequest = null;
      this._activeResolver = null;
      this._notify();
      this._processNext();
    }
  }

  private _sendResponse(toolCallId: string, approved: boolean): void {
    if (!this._sendFn) return;
    this._sendFn({
      type: 'tool_confirm_response',
      toolCallId,
      approved,
    });
  }

  private _notify(): void {
    for (const listener of this._listeners) {
      try {
        listener();
      } catch {
        // UI state listeners must not block confirmation handling.
      }
    }
  }
}

function summarizeRequest(request: ToolConfirmRequest): ToolConfirmationSummary {
  return {
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    displayName: request.displayName || request.toolName,
    riskLevel: request.riskLevel,
    sessionId: request.sessionId,
    detail: summarizeParams(request.params || {}),
    canInlineResolve: isInlineResolvableRisk(request.riskLevel),
  };
}

function isInlineResolvableRisk(riskLevel: string): boolean {
  const normalized = String(riskLevel || '').trim().toLowerCase();
  return normalized === 'safe' || normalized === 'low';
}

function summarizeParams(params: Record<string, unknown>): string {
  const keys = Object.keys(params);
  if (keys.length === 0) return '';
  const parts: string[] = [];
  for (const key of keys.slice(0, 3)) {
    const val = params[key];
    if (typeof val === 'string') {
      parts.push(val.length > 56 ? `${key}: "${val.slice(0, 56)}..."` : `${key}: "${val}"`);
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      parts.push(`${key}: ${val}`);
    }
  }
  if (keys.length > 3) parts.push(`+${keys.length - 3} more`);
  return parts.join('; ');
}
