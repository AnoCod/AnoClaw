// ToolConfirmationQueue — FIFO queue for tool confirmation dialogs
// Receives tool_confirm_request WS events, shows dialogs one at a time,
// and sends tool_confirm_response back to the server.

import { ToolConfirmDialog, type ToolConfirmRequest } from '../components/ToolConfirmDialog.js';

export class ToolConfirmationQueue {
  private static _instance: ToolConfirmationQueue;
  private _queue: ToolConfirmRequest[] = [];
  private _active = false;
  private _sendFn: ((data: Record<string, unknown>) => void) | null = null;
  private _autoApprover: ((request: ToolConfirmRequest) => boolean) | null = null;

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

  setAutoApprover(fn: ((request: ToolConfirmRequest) => boolean) | null): void {
    this._autoApprover = fn;
  }

  enqueue(request: ToolConfirmRequest): void {
    if (request.autoApprove === true || this._autoApprover?.(request)) {
      this._sendResponse(request.toolCallId, true);
      return;
    }
    this._queue.push(request);
    this._processNext();
  }

  private async _processNext(): Promise<void> {
    if (this._active || this._queue.length === 0) return;
    this._active = true;
    const request = this._queue.shift()!;
    try {
      const approved = await ToolConfirmDialog.show(request);
      this._sendResponse(request.toolCallId, approved);
    } catch {
      this._sendResponse(request.toolCallId, false);
    } finally {
      this._active = false;
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
}
